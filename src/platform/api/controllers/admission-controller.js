const AdmissionManager = require("../../../commons/data-managers/admission-manager");
const AdmissionCheckManager = require("../../../commons/data-managers/admission-check-manager");
const AdmissionDeviceManager = require("../../../commons/data-managers/admission-device-manager");
const AdmissionResetRunManager = require("../../../commons/data-managers/admission-reset-run-manager");
const {
  AdmissionService,
} = require("../../../commons/services/admission/admission-service");
const {
  AdmissionCheckService,
} = require("../../../commons/services/admission/admission-check-service");
const {
  AdmissionDeviceService,
} = require("../../../commons/services/admission/admission-device-service");
const {
  CODE_STATUS,
  codeOf,
  formatCode,
  verifyCode,
} = require("../../../commons/services/admission/admission-code");
const RateLimiter = require("../../../commons/services/rate-limit/rate-limiter");
const {
  admissionCheckPerUser,
} = require("../../../commons/services/rate-limit/limits");
const {
  NotFoundError,
  TooManyRequestsError,
} = require("../../../errors/BaseError");

const intOf = (value) => {
  const number = Number(value);
  return Number.isInteger(number) ? number : undefined;
};

/** What a check request names: the code, the direction, the request id. */
function checkInputOf(body = {}) {
  return {
    code: body.code,
    direction: body.direction,
    requestId: body.requestId ?? null,
  };
}

/**
 * Web controller of the admissions (German "Zugangsberechtigung"): the
 * check at the entrance - by a device with its token, or by a member of
 * staff signed in -, the administration of the admissions and of the
 * devices. Who may do what is the routes': `admission.*` and
 * `admissionDevice.*` of the rights table for the signed-in routes; the
 * device routes are token-authorized and authenticate the device first.
 */
class AdmissionController {
  /** A device's entry check at its facility. */
  static async deviceEntry(request, response, next) {
    return AdmissionController._deviceCheck(request, response, next, "entry");
  }

  /** A device's exit check at its facility. */
  static async deviceExit(request, response, next) {
    return AdmissionController._deviceCheck(request, response, next, "exit");
  }

  static async _deviceCheck(request, response, next, direction) {
    try {
      const tenantId = request.params.tenant;
      const device = await AdmissionDeviceService.authenticate(
        tenantId,
        request.headers.authorization,
      );
      const { code, requestId } = checkInputOf(request.body);
      const answer = await AdmissionCheckService.check({
        tenantId,
        facilityId: device.facilityId,
        code,
        direction,
        actor: { deviceId: device.id },
        requestId,
      });
      return response.status(200).send(answer);
    } catch (err) {
      return next(err);
    }
  }

  /** What a device shows besides the scan: its facility's count, its last checks. */
  static async deviceStatus(request, response, next) {
    try {
      const tenantId = request.params.tenant;
      const device = await AdmissionDeviceService.authenticate(
        tenantId,
        request.headers.authorization,
      );
      const [count, checks] = await Promise.all([
        AdmissionCheckService.checkedIn(tenantId, device.facilityId),
        AdmissionCheckManager.getRecentChecks(tenantId, device.facilityId, {
          deviceId: device.id,
          limit: 10,
        }),
      ]);
      return response.status(200).send({
        device: {
          id: device.id,
          label: device.label,
          facilityId: device.facilityId,
        },
        ...count,
        recentChecks: checks.map((check) => check.answer),
      });
    } catch (err) {
      return next(err);
    }
  }

  /** A check by a member of staff in the check view. */
  static async staffCheck(request, response, next) {
    try {
      const tenantId = request.params.tenant;
      const userId = request.user.id;
      const slot = await RateLimiter.consume(admissionCheckPerUser(userId));
      if (!slot.allowed) {
        throw new TooManyRequestsError("too_many_requests", {
          retryAfterSeconds: slot.retryAfterSeconds,
        });
      }
      const { code, direction, requestId } = checkInputOf(request.body);
      const answer = await AdmissionCheckService.check({
        tenantId,
        facilityId: request.params.facilityId,
        code,
        direction,
        actor: { userId },
        requestId,
      });
      return response.status(200).send(answer);
    } catch (err) {
      return next(err);
    }
  }

  /** The number of checked-in admissions of a facility. */
  static async checkedIn(request, response, next) {
    try {
      const answer = await AdmissionCheckService.checkedIn(
        request.params.tenant,
        request.params.facilityId,
      );
      return response.status(200).send(answer);
    } catch (err) {
      return next(err);
    }
  }

  /** The latest checks at a facility. */
  static async recentChecks(request, response, next) {
    try {
      const checks = await AdmissionCheckManager.getRecentChecks(
        request.params.tenant,
        request.params.facilityId,
        { limit: intOf(request.query.limit) },
      );
      return response.status(200).send(checks);
    } catch (err) {
      return next(err);
    }
  }

  /** The runs of the daily reset of a facility (monitoring). */
  static async resetRuns(request, response, next) {
    try {
      const runs = await AdmissionResetRunManager.getRuns(
        request.params.tenant,
        request.params.facilityId,
        { limit: intOf(request.query.limit) },
      );
      return response.status(200).send(runs);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * The admissions of the tenant, by facility, tariff, booking, state and
   * code. A code is read as the check reads it - spaces, hyphens
   * and lower case accepted - and finds its admission by the identifier it
   * carries; a code that is none, or not signed for the tenant, finds none.
   */
  static async getAdmissions(request, response, next) {
    try {
      const tenantId = request.params.tenant;
      const { facilityId, bookableId, bookingId, state, code } = request.query;
      let key;
      if (typeof code === "string" && code.trim()) {
        const read = verifyCode(tenantId, code);
        if (read.status !== CODE_STATUS.OK) {
          return response.status(200).send([]);
        }
        key = read.key;
      }
      const admissions = await AdmissionManager.getAdmissions(tenantId, {
        facilityId,
        bookableId,
        bookingId,
        state,
        key,
        limit: intOf(request.query.limit),
      });
      return response
        .status(200)
        .send(admissions.map((admission) => admission.toResponse()));
    } catch (err) {
      return next(err);
    }
  }

  /** One admission with its usage log and its code, for a reissue. */
  static async getAdmission(request, response, next) {
    try {
      const tenantId = request.params.tenant;
      const admission = await AdmissionManager.getAdmission(
        tenantId,
        request.params.id,
      );
      if (!admission) {
        throw new NotFoundError("admission_not_found", {
          id: request.params.id,
        });
      }
      return response.status(200).send(
        admission.toResponse({
          code: formatCode(codeOf(tenantId, admission.key)),
        }),
      );
    } catch (err) {
      return next(err);
    }
  }

  /** A correction of the administration. */
  static async correctAdmission(request, response, next) {
    try {
      const admission = await AdmissionService.correct(
        request.params.tenant,
        request.params.id,
        {
          action: request.body?.action,
          reason: request.body?.reason,
          userId: request.user.id,
        },
      );
      return response.status(200).send(admission.toResponse());
    } catch (err) {
      return next(err);
    }
  }

  static async getDevices(request, response, next) {
    try {
      const devices = await AdmissionDeviceManager.getDevices(
        request.params.tenant,
        { facilityId: request.query.facilityId },
      );
      return response.status(200).send(devices);
    } catch (err) {
      return next(err);
    }
  }

  /** Registers a device; the answer carries its token, once. */
  static async createDevice(request, response, next) {
    try {
      const result = await AdmissionDeviceService.createDevice({
        tenantId: request.params.tenant,
        facilityId: request.body?.facilityId,
        label: request.body?.label,
        userId: request.user.id,
      });
      return response.status(201).send(result);
    } catch (err) {
      return next(err);
    }
  }

  static async renewDeviceToken(request, response, next) {
    try {
      const result = await AdmissionDeviceService.renewToken(
        request.params.tenant,
        request.params.id,
        request.user.id,
      );
      return response.status(200).send(result);
    } catch (err) {
      return next(err);
    }
  }

  static async blockDevice(request, response, next) {
    try {
      const device = await AdmissionDeviceService.blockDevice(
        request.params.tenant,
        request.params.id,
        { reason: request.body?.reason, userId: request.user.id },
      );
      return response.status(200).send(device);
    } catch (err) {
      return next(err);
    }
  }

  static async unblockDevice(request, response, next) {
    try {
      const device = await AdmissionDeviceService.unblockDevice(
        request.params.tenant,
        request.params.id,
        { userId: request.user.id },
      );
      return response.status(200).send(device);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = AdmissionController;
