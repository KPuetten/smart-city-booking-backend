const bunyan = require("bunyan");

const AdmissionManager = require("../../data-managers/admission-manager");
const AdmissionCheckManager = require("../../data-managers/admission-check-manager");
const { BookableManager } = require("../../data-managers/bookable-manager");
const { DOMAIN } = require("../authorization/reach");
const {
  normalizeFacility,
  CAPACITY_CHECKS,
} = require("../../entities/admission/admission-definition");
const {
  ADMISSION_CHECK_DIRECTIONS,
  ADMISSION_CHECK_PENDING,
  ADMISSION_CHECK_ERROR,
} = require("../../schemas/admissionCheckSchema");
const { verifyCode } = require("./admission-code");
const { decideEntry, decideExit } = require("./admission-decision");
const {
  CHECK_RESULTS,
  CHECK_ERRORS,
  messageOf,
} = require("./admission-reasons");
const {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} = require("../../../errors/BaseError");

const logger = bunyan.createLogger({
  name: "admission-check-service.js",
  level: process.env.LOG_LEVEL,
});

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/**
 * How often a check is decided anew when its write met a change in
 * between: another device scanned the same admission at the same moment.
 * Each new attempt waits a random time up to a bound that doubles from
 * `RETRY_BASE_MS` to `RETRY_CAP_MS` ("full jitter"), so the scans that met
 * no longer meet again at once. Many entrances at the same family card
 * (10-50 at once in a load test) used up three attempts without a
 * wait. A lost attempt costs a few ms; only a scan that keeps losing waits
 * long, at most about one second in all, on average half of it.
 */
const MAX_ATTEMPTS = 25;
const RETRY_BASE_MS = 5;
const RETRY_CAP_MS = 50;

/** The wait before attempt `attempt + 1`, in ms. */
function retryDelay(attempt) {
  const bound = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
  return Math.floor(Math.random() * (bound + 1));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_REQUEST_ID_LENGTH = 128;

/**
 * A scan sent again while its twin is still decided waits for the twin's
 * answer: it looks every `CLAIM_WAIT_MS`, at most `MAX_CLAIM_WAITS` times
 * (two seconds, more than a contended check takes), then answers
 * `503 admission_request_in_progress`. A claim whose owner has been silent
 * for `STALE_CLAIM_MS` is taken over.
 */
const CLAIM_WAIT_MS = 50;
const MAX_CLAIM_WAITS = 40;
const STALE_CLAIM_MS = 30 * 1000;

/**
 * The facility a check runs at, with its normalized settings.
 *
 * @param {string} tenantId
 * @param {string} facilityId
 * @returns {Promise<{ facility: Object, settings: Object }>}
 * @throws {NotFoundError} `admission_facility_not_found`
 */
async function loadFacility(tenantId, facilityId) {
  const facility = facilityId
    ? await BookableManager.getBookable(facilityId, tenantId, DOMAIN)
    : null;
  const settings = normalizeFacility(facility?.admissionFacility);
  if (!settings) {
    throw new NotFoundError("admission_facility_not_found", { facilityId });
  }
  return { facility, settings };
}

/** The earliest entry that still counts as present under the stay limit. */
function enteredSince(settings, now) {
  return Number.isInteger(settings.maxStayMinutes)
    ? now - settings.maxStayMinutes * MINUTE
    : null;
}

/**
 * What the entrance is told about an admission: what it allows and where
 * it stands, never who booked it.
 */
function summaryOf(admission) {
  if (!admission) {
    return null;
  }
  return {
    id: admission.id,
    bookableTitle: admission.bookableTitle,
    kind: admission.kind,
    memberIndex: admission.memberIndex,
    state: admission.state,
    usage: admission.entitlement?.usage,
    remainingDays: admission.remainingDays,
    validFrom: admission.entitlement?.validFrom,
    validTo: admission.entitlement?.validTo,
    personalized: admission.entitlement?.personalized === true,
    lastEntryAt: admission.lastEntryAt,
  };
}

class AdmissionCheckService {
  /**
   * One scan at an entrance: decides it, writes the effect of a
   * granted one, logs it whatever the answer and answers.
   *
   * A scan sent again with the same `requestId` by the same device or
   * person is answered as the first time, without a second effect; the
   * same id for another admission or direction is
   * `409 admission_request_id_reused`. The request id is
   * claimed before the decision (`AdmissionCheckManager.claimCheck`), so a
   * scan sent again while the first is still decided waits for its answer
   * instead of deciding anew. A scan that meets a write of another device
   * in between is decided anew on what that one wrote.
   *
   * @param {Object} params
   * @param {string} params.tenantId
   * @param {string} params.facilityId The facility checked at
   * @param {string} params.code The scanned or entered code
   * @param {"entry"|"exit"} [params.direction="entry"]
   * @param {{ deviceId?: string|null, userId?: string|null }} params.actor
   * @param {string} [params.requestId] The client's id of this scan
   * @param {number} [params.now]
   * @returns {Promise<Object>} The answer: `result`, `reason`, `message`,
   *   `notices`, `step`, `admission`, `checkedIn`, `checkedAt`
   */
  static async check({
    tenantId,
    facilityId,
    code,
    direction = ADMISSION_CHECK_DIRECTIONS.ENTRY,
    actor,
    requestId = null,
    now = Date.now(),
  }) {
    if (!Object.values(ADMISSION_CHECK_DIRECTIONS).includes(direction)) {
      throw new BadRequestError("admission_direction_invalid", { direction });
    }
    if (
      requestId !== null &&
      (typeof requestId !== "string" ||
        requestId.length === 0 ||
        requestId.length > MAX_REQUEST_ID_LENGTH)
    ) {
      throw new BadRequestError("admission_request_id_invalid");
    }

    const { facility, settings } = await loadFacility(tenantId, facilityId);
    const { status: integrity, key } = verifyCode(tenantId, code);

    const admission = key
      ? await AdmissionManager.getAdmissionByKey(tenantId, key)
      : null;

    const row = {
      tenantId,
      facilityId,
      direction,
      deviceId: actor.deviceId ?? null,
      userId: actor.userId ?? null,
      requestId,
      admissionId: admission?.id ?? null,
      at: now,
    };
    let claim = null;
    if (requestId) {
      const claimed = await AdmissionCheckService._claim(row);
      if (claimed.replay) {
        return claimed.replay;
      }
      claim = claimed.claim;
    }
    try {
      return await AdmissionCheckService._run({
        row,
        claim,
        facility,
        settings,
        integrity,
        key,
        admission,
        actor,
      });
    } catch (err) {
      if (claim) {
        // No decision: the scan sent again is decided at once.
        await AdmissionCheckManager.releaseCheck(claim.id).catch((release) =>
          logger.error(
            { err: release, tenantId, requestId },
            "admission check claim not released",
          ),
        );
      }
      throw err;
    }
  }

  /**
   * Claims the request id of a scan, or answers it from the check that
   * claimed it before: at once where that one is decided, after a wait
   * where it is still being decided.
   *
   * @param {Object} row The fields of the check known before the decision
   * @returns {Promise<{ claim?: Object, replay?: Object }>}
   */
  static async _claim(row) {
    for (let look = 1; ; look++) {
      const { claimed, existing } = await AdmissionCheckManager.claimCheck(
        row,
        { staleMs: STALE_CLAIM_MS },
      );
      if (claimed) {
        return { claim: claimed };
      }
      if (existing) {
        // The same scan sent again names the same admission and direction;
        // a request id reused for another scan is the client's error, and
        // never answered with the answer of somebody else's ticket.
        if (
          existing.admissionId !== row.admissionId ||
          existing.direction !== row.direction
        ) {
          throw new ConflictError("admission_request_id_reused", {
            requestId: row.requestId,
          });
        }
        if (
          ![ADMISSION_CHECK_PENDING, ADMISSION_CHECK_ERROR].includes(
            existing.result,
          )
        ) {
          return { replay: { ...existing.answer, replayed: true } };
        }
      }
      if (look >= MAX_CLAIM_WAITS) {
        throw new ServiceUnavailableError("admission_request_in_progress", {
          requestId: row.requestId,
          retryAfterSeconds: 1,
        });
      }
      await sleep(CLAIM_WAIT_MS);
    }
  }

  /** Decides a check, writes its effect, logs and answers it. */
  static async _run({
    row,
    claim,
    facility,
    settings,
    integrity,
    key,
    admission,
    actor,
  }) {
    const { tenantId, facilityId, direction, at: now } = row;
    let decision;
    for (let attempt = 1; ; attempt++) {
      decision = await AdmissionCheckService._decide({
        tenantId,
        facilityId,
        facility,
        settings,
        integrity,
        admission,
        direction,
        actor,
        now,
      });
      if (!decision.effect) {
        break;
      }
      const written = await AdmissionManager.updateAdmissionIfRevision(
        tenantId,
        admission.id,
        admission.revision,
        decision.effect.set,
        decision.effect.entries,
      );
      if (written) {
        admission = written;
        break;
      }
      if (attempt >= MAX_ATTEMPTS) {
        await AdmissionCheckService._logContended({ row, claim, admission });
        throw new ServiceUnavailableError(CHECK_ERRORS.CONTENDED, {
          retryAfterSeconds: 1,
        });
      }
      await sleep(retryDelay(attempt));
      admission = await AdmissionManager.getAdmissionByKey(tenantId, key);
    }

    const checkedIn = await AdmissionManager.countPresentAdmissions(
      tenantId,
      facilityId,
      { enteredSince: enteredSince(settings, now) },
    );
    const answer = {
      result: decision.result,
      direction,
      reason: decision.reason,
      step: decision.step,
      message: decision.message,
      notices: decision.notices,
      admission: integrity === "ok" ? summaryOf(admission) : null,
      checkedIn,
      checkedAt: now,
    };

    const outcome = {
      admissionId: admission?.id ?? null,
      result: decision.result,
      reason: decision.reason,
      notices: decision.notices.map((notice) => notice.code),
      answer,
    };
    if (claim) {
      await AdmissionCheckManager.finishCheck(claim.id, outcome);
    } else {
      await AdmissionCheckManager.insertCheck({ ...row, ...outcome });
    }

    logger.info(
      {
        tenantId,
        facilityId,
        deviceId: actor.deviceId ?? null,
        direction,
        result: decision.result,
        reason: decision.reason,
      },
      "admission check",
    );
    return answer;
  }

  /**
   * Logs a check that came to no decision because its write kept meeting
   * the writes of other devices. A failure to log is logged and does not
   * replace the answer.
   */
  static async _logContended({ row, claim, admission }) {
    const reason = CHECK_ERRORS.CONTENDED;
    const outcome = {
      admissionId: admission?.id ?? null,
      result: ADMISSION_CHECK_ERROR,
      reason,
      notices: [],
      answer: {
        result: ADMISSION_CHECK_ERROR,
        direction: row.direction,
        reason,
        step: null,
        message: messageOf(reason),
        notices: [],
        admission: null,
        checkedIn: null,
        checkedAt: row.at,
      },
    };
    logger.warn(
      {
        tenantId: row.tenantId,
        facilityId: row.facilityId,
        deviceId: row.deviceId,
        admissionId: outcome.admissionId,
        attempts: MAX_ATTEMPTS,
      },
      "admission check contended",
    );
    try {
      if (claim) {
        await AdmissionCheckManager.finishCheck(claim.id, outcome);
      } else {
        await AdmissionCheckManager.insertCheck({ ...row, ...outcome });
      }
    } catch (err) {
      logger.error(
        { err, tenantId: row.tenantId },
        "admission check contended, not logged",
      );
    }
  }

  /** Loads what the decision needs beyond the admission, and decides. */
  static async _decide({
    tenantId,
    facilityId,
    facility,
    settings,
    integrity,
    admission,
    direction,
    actor,
    now,
  }) {
    if (direction === ADMISSION_CHECK_DIRECTIONS.EXIT) {
      return decideExit({
        integrity,
        admission,
        facilityId,
        facility: settings,
        actor,
        now,
      });
    }

    let capacity = null;
    let presentCount = 0;
    if (admission?.entitlement?.capacityCheck === CAPACITY_CHECKS.ENTRY) {
      capacity = Number.isInteger(facility.amount) ? facility.amount : null;
      presentCount = await AdmissionManager.countPresentAdmissions(
        tenantId,
        facilityId,
        { enteredSince: enteredSince(settings, now) },
      );
    }
    const recentDenials = admission
      ? await AdmissionCheckManager.countDeniedChecks(
          tenantId,
          admission.id,
          now - HOUR,
        )
      : 0;

    return decideEntry({
      integrity,
      admission,
      facilityId,
      facility: settings,
      capacity,
      presentCount,
      recentDenials,
      actor,
      now,
    });
  }

  /**
   * The number of admissions checked in at a facility: checked-in
   * admissions, not people present - nobody without an admission, no staff,
   * nobody who left without an exit scan before the reset.
   *
   * @param {string} tenantId
   * @param {string} facilityId
   * @param {{ now?: number }} [options]
   * @returns {Promise<{ facilityId: string, checkedIn: number, capacity: number|null }>}
   */
  static async checkedIn(tenantId, facilityId, { now = Date.now() } = {}) {
    const { facility, settings } = await loadFacility(tenantId, facilityId);
    const checkedIn = await AdmissionManager.countPresentAdmissions(
      tenantId,
      facilityId,
      { enteredSince: enteredSince(settings, now) },
    );
    return {
      facilityId,
      checkedIn,
      capacity: Number.isInteger(facility.amount) ? facility.amount : null,
      counts: "checked_in_admissions",
    };
  }
}

module.exports = {
  AdmissionCheckService,
  CHECK_RESULTS,
  MAX_ATTEMPTS,
  retryDelay,
};
