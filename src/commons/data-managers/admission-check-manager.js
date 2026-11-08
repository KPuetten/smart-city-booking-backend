const { v4: uuidv4 } = require("uuid");
const AdmissionCheckModel = require("./models/admissionCheckModel");
const { positiveInt } = require("../services/rate-limit/limits");
const {
  ADMISSION_CHECK_PENDING,
  ADMISSION_CHECK_ERROR,
} = require("../schemas/admissionCheckSchema");

const DAY = 24 * 60 * 60 * 1000;
const DUPLICATE_KEY = 11000;

/** How long a check is kept, `ADMISSION_CHECK_LOG_RETENTION_DAYS` (90). */
function retentionDays() {
  return positiveInt("ADMISSION_CHECK_LOG_RETENTION_DAYS", 90);
}

/**
 * Data manager of the check log (`admissionchecks`): every check at an
 * entrance with the answer it got, granted or denied.
 */
class AdmissionCheckManager {
  /**
   * @param {Object} check The fields of `admissionCheckSchema`, without id
   *   and expiry
   * @returns {Promise<Object>} The stored row
   */
  static async insertCheck(check) {
    const row = {
      ...check,
      id: uuidv4(),
      expiresAt: new Date(check.at + retentionDays() * DAY),
    };
    await AdmissionCheckModel.create(row);
    return row;
  }

  /**
   * Claims the request id of a check before it is decided: inserts its row
   * as `pending`. The index over tenant, device, person and request id is
   * unique, so of two scans sent with the same id at the same moment one
   * gets it; the other gets the row as it stands, to wait for its answer.
   * A row of the same admission and direction that came to no decision -
   * pending with its owner silent for `staleMs`, or an error - is taken
   * over, as a run of the reset is.
   *
   * @param {Object} check The fields of `admissionCheckSchema` known before
   *   the decision: `tenantId`, `facilityId`, `direction`, `deviceId`,
   *   `userId`, `requestId`, `admissionId`, `at`
   * @param {{ staleMs: number }} options
   * @returns {Promise<{ claimed?: Object, existing?: Object|null }>}
   */
  static async claimCheck(check, { staleMs }) {
    const fields = {
      ...check,
      result: ADMISSION_CHECK_PENDING,
      reason: null,
      notices: [],
      answer: {},
      expiresAt: new Date(check.at + retentionDays() * DAY),
    };
    const row = { ...fields, id: uuidv4() };
    try {
      await AdmissionCheckModel.create(row);
      return { claimed: row };
    } catch (err) {
      if (err.code !== DUPLICATE_KEY) {
        throw err;
      }
    }
    const filter = AdmissionCheckManager.requestFilter(
      check.tenantId,
      check,
      check.requestId,
    );
    const taken = await AdmissionCheckModel.findOneAndUpdate(
      {
        ...filter,
        admissionId: check.admissionId,
        direction: check.direction,
        $or: [
          { result: ADMISSION_CHECK_PENDING, at: { $lt: check.at - staleMs } },
          { result: ADMISSION_CHECK_ERROR },
        ],
      },
      { $set: fields },
      { new: true, projection: { _id: 0, __v: 0 } },
    ).lean();
    if (taken) {
      return { claimed: taken };
    }
    return {
      existing: await AdmissionCheckModel.findOne(filter, {
        _id: 0,
        __v: 0,
      }).lean(),
    };
  }

  /**
   * Writes the decision into a claimed row.
   *
   * @param {string} id
   * @param {{ result: string, reason: string|null, notices: string[],
   *   answer: Object, admissionId: string|null }} result
   * @returns {Promise<void>}
   */
  static async finishCheck(id, result) {
    await AdmissionCheckModel.updateOne({ id }, { $set: result });
  }

  /**
   * Gives a claim up that came to no decision, so the scan sent again is
   * decided at once.
   *
   * @param {string} id
   * @returns {Promise<void>}
   */
  static async releaseCheck(id) {
    await AdmissionCheckModel.deleteOne({
      id,
      result: ADMISSION_CHECK_PENDING,
    });
  }

  /**
   * The check a device or a person sent before with the same request id:
   * a scan sent twice is answered from here, without a second effect.
   *
   * @param {string} tenantId
   * @param {{ deviceId?: string|null, userId?: string|null }} actor
   * @param {string} requestId
   * @returns {Promise<Object|null>}
   */
  static async getCheckByRequest(tenantId, actor, requestId) {
    return AdmissionCheckModel.findOne(
      AdmissionCheckManager.requestFilter(tenantId, actor, requestId),
    ).lean();
  }

  /**
   * The filter of `getCheckByRequest`. The index on the request id is
   * partial (`requestId: { $type: "string" }`), and an equality alone does
   * not prove to the planner that a document is in it: without the `$type`
   * it scans the tenant's whole log over another index instead.
   *
   * @param {string} tenantId
   * @param {{ deviceId?: string|null, userId?: string|null }} actor
   * @param {string} requestId
   * @returns {Object}
   */
  static requestFilter(tenantId, actor, requestId) {
    return {
      tenantId,
      requestId: { $eq: requestId, $type: "string" },
      deviceId: actor.deviceId ?? null,
      userId: actor.userId ?? null,
    };
  }

  /**
   * The refused checks of an admission since a point in time.
   *
   * @param {string} tenantId
   * @param {string} admissionId
   * @param {number} since Epoch ms
   * @returns {Promise<number>}
   */
  static async countDeniedChecks(tenantId, admissionId, since) {
    return AdmissionCheckModel.countDocuments({
      tenantId,
      admissionId,
      result: "denied",
      at: { $gte: since },
    });
  }

  /**
   * The latest checks at a facility, newest first, optionally of one
   * device or one admission.
   *
   * @param {string} tenantId
   * @param {string} facilityId
   * @param {{ deviceId?: string, admissionId?: string, limit?: number }} [filters]
   * @returns {Promise<Object[]>}
   */
  static async getRecentChecks(tenantId, facilityId, filters = {}) {
    const condition = {
      tenantId,
      facilityId,
      result: { $ne: ADMISSION_CHECK_PENDING },
    };
    if (filters.deviceId) condition.deviceId = filters.deviceId;
    if (filters.admissionId) condition.admissionId = filters.admissionId;
    const limit = Math.min(
      Number.isInteger(filters.limit) && filters.limit > 0 ? filters.limit : 20,
      200,
    );
    return AdmissionCheckModel.find(condition, { _id: 0, __v: 0 })
      .sort({ at: -1 })
      .limit(limit)
      .lean();
  }
}

module.exports = AdmissionCheckManager;
