const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const bunyan = require("bunyan");

const AdmissionDeviceManager = require("../../data-managers/admission-device-manager");
const { BookableManager } = require("../../data-managers/bookable-manager");
const { DOMAIN } = require("../authorization/reach");
const {
  normalizeFacility,
} = require("../../entities/admission/admission-definition");
const {
  ADMISSION_DEVICE_STATUS,
} = require("../../schemas/admissionDeviceSchema");
const RateLimiter = require("../rate-limit/rate-limiter");
const { admissionCheckPerDevice } = require("../rate-limit/limits");
const {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
} = require("../../../errors/BaseError");

const logger = bunyan.createLogger({
  name: "admission-device-service.js",
  level: process.env.LOG_LEVEL,
});

/**
 * The token of a device: `adm.<device id>.<secret>`, the secret
 * 256 random bits. The device id lets the check find the device; the
 * secret is what authenticates it. Only the SHA-256 of the whole token is
 * stored: the token is random and long, so a salted, slow hash buys
 * nothing, and a stolen database names no token.
 */
const TOKEN_PREFIX = "adm";
const SECRET_BYTES = 32;
const MAX_LABEL_LENGTH = 100;
const LAST_SEEN_INTERVAL_MS = 60 * 1000;

function hashOf(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function newToken(deviceId) {
  const secret = crypto.randomBytes(SECRET_BYTES).toString("base64url");
  const token = `${TOKEN_PREFIX}.${deviceId}.${secret}`;
  return { token, tokenHash: hashOf(token), tokenHint: secret.slice(-4) };
}

/**
 * The token of an `Authorization: Bearer` header, split, or null.
 *
 * @param {string|undefined} header
 * @returns {{ token: string, deviceId: string }|null}
 */
function tokenOf(header) {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!match) {
    return null;
  }
  const parts = match[1].split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1]) {
    return null;
  }
  return { token: match[1], deviceId: parts[1] };
}

function requireText(value, code) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > MAX_LABEL_LENGTH) {
    throw new BadRequestError(code);
  }
  return text;
}

class AdmissionDeviceService {
  /**
   * Registers a device at a facility of the tenant. The token is answered
   * here once and never again; a lost token is renewed, not shown.
   *
   * @param {Object} params
   * @param {string} params.tenantId
   * @param {string} params.facilityId
   * @param {string} params.label E.g. "Eingang Nord"
   * @param {string} params.userId Who registers it
   * @returns {Promise<{ device: Object, token: string }>}
   */
  static async createDevice({ tenantId, facilityId, label, userId }) {
    const name = requireText(label, "admission_device_label_required");
    const facility =
      typeof facilityId === "string" && facilityId
        ? await BookableManager.getBookable(facilityId, tenantId, DOMAIN)
        : null;
    if (!normalizeFacility(facility?.admissionFacility)) {
      throw new NotFoundError("admission_facility_not_found", { facilityId });
    }
    const id = uuidv4();
    const { token, tokenHash, tokenHint } = newToken(id);
    const now = Date.now();
    await AdmissionDeviceManager.createDevice({
      id,
      tenantId,
      facilityId,
      label: name,
      tokenHash,
      tokenHint,
      status: ADMISSION_DEVICE_STATUS.ACTIVE,
      createdBy: userId,
      updatedBy: userId,
      tokenRenewedAt: now,
      timeCreated: now,
      timeUpdated: now,
    });
    logger.info(
      { tenantId, deviceId: id, facilityId, userId },
      "device created",
    );
    const device = await AdmissionDeviceManager.getDevice(tenantId, id);
    return { device, token };
  }

  /**
   * A new token for a device; the old one stops working at once.
   *
   * @param {string} tenantId
   * @param {string} id
   * @param {string} userId
   * @returns {Promise<{ device: Object, token: string }>}
   */
  static async renewToken(tenantId, id, userId) {
    const { token, tokenHash, tokenHint } = newToken(id);
    const device = await AdmissionDeviceManager.updateDevice(tenantId, id, {
      tokenHash,
      tokenHint,
      tokenRenewedAt: Date.now(),
      updatedBy: userId,
    });
    if (!device) {
      throw new NotFoundError("admission_device_not_found", { id });
    }
    logger.info({ tenantId, deviceId: id, userId }, "device token renewed");
    return { device, token };
  }

  /**
   * Blocks a device: its token is refused until it is unblocked.
   *
   * @param {string} tenantId
   * @param {string} id
   * @param {{ reason: string, userId: string }} params
   * @returns {Promise<Object>} The device
   */
  static async blockDevice(tenantId, id, { reason, userId }) {
    const why = requireText(reason, "reason_required");
    const device = await AdmissionDeviceManager.updateDevice(tenantId, id, {
      status: ADMISSION_DEVICE_STATUS.BLOCKED,
      blockReason: why,
      updatedBy: userId,
    });
    if (!device) {
      throw new NotFoundError("admission_device_not_found", { id });
    }
    logger.info({ tenantId, deviceId: id, userId }, "device blocked");
    return device;
  }

  /**
   * @param {string} tenantId
   * @param {string} id
   * @param {{ userId: string }} params
   * @returns {Promise<Object>} The device
   */
  static async unblockDevice(tenantId, id, { userId }) {
    const current = await AdmissionDeviceManager.getDevice(tenantId, id);
    if (!current) {
      throw new NotFoundError("admission_device_not_found", { id });
    }
    if (current.status !== ADMISSION_DEVICE_STATUS.BLOCKED) {
      throw new ConflictError("admission_device_not_blocked", { id });
    }
    const device = await AdmissionDeviceManager.updateDevice(tenantId, id, {
      status: ADMISSION_DEVICE_STATUS.ACTIVE,
      blockReason: null,
      updatedBy: userId,
    });
    logger.info({ tenantId, deviceId: id, userId }, "device unblocked");
    return device;
  }

  /**
   * Authenticates the device of a request at the tenant of its route and
   * counts the request against the device's rate limit. A token of
   * another tenant, a renewed one and a made-up one are refused alike.
   *
   * @param {string} tenantId The tenant of the route
   * @param {string|undefined} authorization The `Authorization` header
   * @param {{ now?: number }} [options]
   * @returns {Promise<Object>} The device, without its token hash
   * @throws {UnauthorizedError} `admission_device_unauthorized`
   * @throws {ForbiddenError} `admission_device_blocked`
   * @throws {TooManyRequestsError} `too_many_requests`, `retryAfterSeconds`
   */
  static async authenticate(
    tenantId,
    authorization,
    { now = Date.now() } = {},
  ) {
    const parsed = tokenOf(authorization);
    const stored = parsed
      ? await AdmissionDeviceManager.getDeviceForAuthentication(
          tenantId,
          parsed.deviceId,
        )
      : null;
    const matches =
      stored &&
      crypto.timingSafeEqual(
        Buffer.from(hashOf(parsed.token), "hex"),
        Buffer.from(stored.tokenHash, "hex"),
      );
    if (!matches) {
      logger.warn(
        { tenantId, deviceId: parsed?.deviceId ?? null },
        "device authentication failed",
      );
      throw new UnauthorizedError("admission_device_unauthorized");
    }
    if (stored.status !== ADMISSION_DEVICE_STATUS.ACTIVE) {
      logger.warn({ tenantId, deviceId: stored.id }, "blocked device refused");
      throw new ForbiddenError("admission_device_blocked");
    }

    const slot = await RateLimiter.consume(admissionCheckPerDevice(stored.id));
    if (!slot.allowed) {
      logger.warn(
        { tenantId, deviceId: stored.id },
        "device rate limit reached",
      );
      throw new TooManyRequestsError("too_many_requests", {
        retryAfterSeconds: slot.retryAfterSeconds,
      });
    }

    AdmissionDeviceManager.touchDevice(
      tenantId,
      stored.id,
      now,
      LAST_SEEN_INTERVAL_MS,
    ).catch((err) =>
      logger.warn({ err, deviceId: stored.id }, "device last seen not written"),
    );

    // eslint-disable-next-line no-unused-vars
    const { tokenHash, _id, __v, ...device } = stored;
    return device;
  }
}

module.exports = { AdmissionDeviceService, TOKEN_PREFIX };
