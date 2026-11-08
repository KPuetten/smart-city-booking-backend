const AdmissionModel = require("./models/admissionModel");
const {
  ADMISSION_STATES,
  USAGE_EVENTS,
} = require("../schemas/admissionSchema");

const DUPLICATE_KEY = 11000;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;

/** The states a reset or a cancellation may still change. */
const LIVE_STATES = Object.freeze([
  ADMISSION_STATES.ISSUED,
  ADMISSION_STATES.PRESENT,
  ADMISSION_STATES.ABSENT,
  ADMISSION_STATES.CONSUMED,
  ADMISSION_STATES.EXPIRED,
  ADMISSION_STATES.BLOCKED,
]);

/**
 * Data manager of the admissions (German "Zugangsberechtigung"). Every
 * read and write names the tenant. The admissions are no resource of the
 * rights table with an owner: who may read them is the route's, and the
 * entrance reads them by the identifier of a verified code.
 */
class AdmissionManager {
  /**
   * @param {string} tenantId
   * @param {string} key The identifier a verified code carries
   * @returns {Promise<import("../entities/admission/admission").Admission|null>}
   */
  static async getAdmissionByKey(tenantId, key) {
    const doc = await AdmissionModel.findOne({ tenantId, key });
    return doc ? doc.toEntity() : null;
  }

  /**
   * @param {string} tenantId
   * @param {string} id
   * @returns {Promise<import("../entities/admission/admission").Admission|null>}
   */
  static async getAdmission(tenantId, id) {
    const doc = await AdmissionModel.findOne({ tenantId, id });
    return doc ? doc.toEntity() : null;
  }

  /**
   * The admissions of a booking, in the order of its positions.
   *
   * @param {string} tenantId
   * @param {string} bookingId
   * @returns {Promise<import("../entities/admission/admission").Admission[]>}
   */
  static async getAdmissionsByBooking(tenantId, bookingId) {
    const docs = await AdmissionModel.find({ tenantId, bookingId }).sort({
      itemIndex: 1,
      unitIndex: 1,
      memberIndex: 1,
    });
    return docs.map((doc) => doc.toEntity());
  }

  /**
   * The admissions of a tenant, newest first, narrowed by the filters given.
   *
   * @param {string} tenantId
   * @param {{ facilityId?: string, bookableId?: string, bookingId?: string,
   *   state?: string, key?: string, limit?: number }} [filters]
   * @returns {Promise<import("../entities/admission/admission").Admission[]>}
   */
  static async getAdmissions(tenantId, filters = {}) {
    const condition = { tenantId };
    for (const field of [
      "facilityId",
      "bookableId",
      "bookingId",
      "state",
      "key",
    ]) {
      if (typeof filters[field] === "string" && filters[field]) {
        condition[field] = filters[field];
      }
    }
    const limit = Math.min(
      Number.isInteger(filters.limit) && filters.limit > 0
        ? filters.limit
        : DEFAULT_LIST_LIMIT,
      MAX_LIST_LIMIT,
    );
    const docs = await AdmissionModel.find(condition)
      .sort({ timeCreated: -1 })
      .limit(limit);
    return docs.map((doc) => doc.toEntity());
  }

  /**
   * Inserts the admissions of an issuance. A place of the booking that has
   * its admission already keeps it: the unique index refuses the second,
   * and the refusal is no error - the issuance ran before.
   *
   * @param {Object[]} admissions
   * @returns {Promise<number>} The number inserted now
   */
  static async insertAdmissions(admissions) {
    if (admissions.length === 0) {
      return 0;
    }
    try {
      const inserted = await AdmissionModel.insertMany(admissions, {
        ordered: false,
      });
      return inserted.length;
    } catch (err) {
      const errors = err.writeErrors ?? [err];
      if (errors.every((e) => (e.code ?? e.err?.code) === DUPLICATE_KEY)) {
        return err.insertedDocs?.length ?? err.result?.insertedCount ?? 0;
      }
      throw err;
    }
  }

  /**
   * Writes a change to an admission on the condition that nobody wrote it
   * since it was read (optimistic lock over `revision`).
   *
   * @param {string} tenantId
   * @param {string} id
   * @param {number} revision The revision the change was decided on
   * @param {Object} set The fields to set
   * @param {Object[]} entries The usage log entries to append
   * @returns {Promise<import("../entities/admission/admission").Admission|null>}
   *   The admission as written, null where it changed in between
   */
  static async updateAdmissionIfRevision(tenantId, id, revision, set, entries) {
    const doc = await AdmissionModel.findOneAndUpdate(
      { tenantId, id, revision },
      {
        $set: { ...set, timeUpdated: Date.now() },
        $push: { usage: { $each: entries } },
        $inc: { revision: 1 },
      },
      { new: true },
    );
    return doc ? doc.toEntity() : null;
  }

  /**
   * Sets every live admission of a booking invalid: the state it
   * came from is kept for a reinstatement, the usage log stays.
   *
   * @param {string} tenantId
   * @param {string} bookingId
   * @param {{ at: number, reason: string, userId?: string|null }} entry
   * @returns {Promise<number>} The number invalidated
   */
  static async invalidateAdmissionsOfBooking(tenantId, bookingId, entry) {
    const result = await AdmissionModel.updateMany(
      { tenantId, bookingId, state: { $in: LIVE_STATES } },
      [
        {
          $set: {
            stateBefore: "$state",
            usage: {
              $concatArrays: [
                "$usage",
                [
                  {
                    type: USAGE_EVENTS.INVALIDATE,
                    at: entry.at,
                    fromState: "$state",
                    toState: ADMISSION_STATES.INVALID,
                    reason: { $literal: entry.reason },
                    userId: { $literal: entry.userId ?? null },
                    day: null,
                    dayConsumed: false,
                    deviceId: null,
                    runId: null,
                  },
                ],
              ],
            },
          },
        },
        {
          $set: {
            state: ADMISSION_STATES.INVALID,
            timeUpdated: entry.at,
            revision: { $add: ["$revision", 1] },
          },
        },
      ],
    );
    return result.modifiedCount ?? 0;
  }

  /**
   * Checks every present admission of a facility out (the daily reset):
   * to `consumed` where no day of use is left, `absent` otherwise.
   * Only what entered before the reset was due: a reset made up for late
   * never checks out a guest who came in after its time.
   *
   * @param {string} tenantId
   * @param {string} facilityId
   * @param {{ at: number, runId: string, enteredBefore: number }} entry
   * @returns {Promise<number>} The number checked out
   */
  static async resetPresentAdmissions(tenantId, facilityId, entry) {
    const next = {
      $cond: [
        { $eq: ["$remainingDays", 0] },
        ADMISSION_STATES.CONSUMED,
        ADMISSION_STATES.ABSENT,
      ],
    };
    const result = await AdmissionModel.updateMany(
      {
        tenantId,
        facilityId,
        state: ADMISSION_STATES.PRESENT,
        lastEntryAt: { $lt: entry.enteredBefore },
      },
      [
        {
          $set: {
            usage: {
              $concatArrays: [
                "$usage",
                [
                  {
                    type: USAGE_EVENTS.RESET,
                    at: entry.at,
                    fromState: ADMISSION_STATES.PRESENT,
                    toState: next,
                    runId: { $literal: entry.runId },
                    reason: null,
                    userId: null,
                    day: null,
                    dayConsumed: false,
                    deviceId: null,
                  },
                ],
              ],
            },
            state: next,
            lastExitAt: entry.at,
          },
        },
        {
          $set: {
            timeUpdated: entry.at,
            revision: { $add: ["$revision", 1] },
          },
        },
      ],
    );
    return result.modifiedCount ?? 0;
  }

  /**
   * Moves the admissions of a facility past the end of their validity to
   * `expired`. Blocked and invalid ones keep their state.
   *
   * @param {string} tenantId
   * @param {string} facilityId
   * @param {{ at: number, runId: string }} entry
   * @returns {Promise<number>} The number expired
   */
  static async expireAdmissions(tenantId, facilityId, entry) {
    const result = await AdmissionModel.updateMany(
      {
        tenantId,
        facilityId,
        state: {
          $in: [
            ADMISSION_STATES.ISSUED,
            ADMISSION_STATES.ABSENT,
            ADMISSION_STATES.CONSUMED,
          ],
        },
        "entitlement.validTo": { $lt: entry.at },
      },
      [
        {
          $set: {
            usage: {
              $concatArrays: [
                "$usage",
                [
                  {
                    type: USAGE_EVENTS.EXPIRE,
                    at: entry.at,
                    fromState: "$state",
                    toState: ADMISSION_STATES.EXPIRED,
                    runId: { $literal: entry.runId },
                    reason: null,
                    userId: null,
                    day: null,
                    dayConsumed: false,
                    deviceId: null,
                  },
                ],
              ],
            },
          },
        },
        {
          $set: {
            state: ADMISSION_STATES.EXPIRED,
            timeUpdated: entry.at,
            revision: { $add: ["$revision", 1] },
          },
        },
      ],
    );
    return result.modifiedCount ?? 0;
  }

  /**
   * The number of admissions checked in at a facility, derived
   * from their state: present, and within the stay limit where the facility
   * has one.
   *
   * @param {string} tenantId
   * @param {string} facilityId
   * @param {{ enteredSince?: number|null }} [options] The earliest entry
   *   that still counts as present
   * @returns {Promise<number>}
   */
  static async countPresentAdmissions(
    tenantId,
    facilityId,
    { enteredSince = null } = {},
  ) {
    const condition = {
      tenantId,
      facilityId,
      state: ADMISSION_STATES.PRESENT,
    };
    if (enteredSince !== null) {
      condition.lastEntryAt = { $gte: enteredSince };
    }
    return AdmissionModel.countDocuments(condition);
  }
}

module.exports = AdmissionManager;
