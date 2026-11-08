const { v4: uuidv4 } = require("uuid");
const AdmissionResetRunModel = require("./models/admissionResetRunModel");
const { RESET_RUN_STATUS } = require("../schemas/admissionResetRunSchema");

const DUPLICATE_KEY = 11000;

/**
 * Data manager of the runs of the daily reset (`admissionresetruns`). A
 * run is claimed by inserting it: the index on facility and due time is
 * unique, so of two processes only one gets it. A run that failed, or one
 * whose owner has been gone for `staleMs`, may be claimed again.
 */
class AdmissionResetRunManager {
  /**
   * The run of a facility for a due time, if any.
   *
   * @param {string} tenantId
   * @param {string} facilityId
   * @param {number} dueAt
   * @returns {Promise<Object|null>}
   */
  static async getRun(tenantId, facilityId, dueAt) {
    return AdmissionResetRunModel.findOne(
      { tenantId, facilityId, dueAt },
      { _id: 0, __v: 0 },
    ).lean();
  }

  /**
   * The finished run of a facility with the latest due time, if any.
   *
   * @param {string} tenantId
   * @param {string} facilityId
   * @returns {Promise<Object|null>}
   */
  static async getLastDoneRun(tenantId, facilityId) {
    return AdmissionResetRunModel.findOne(
      { tenantId, facilityId, status: RESET_RUN_STATUS.DONE },
      { _id: 0, __v: 0 },
    )
      .sort({ dueAt: -1 })
      .lean();
  }

  /**
   * Claims the run of a facility for a due time.
   *
   * @param {Object} params
   * @param {string} params.tenantId
   * @param {string} params.facilityId
   * @param {number} params.dueAt
   * @param {string} params.trigger
   * @param {string} params.owner
   * @param {number} params.now
   * @param {number} params.staleMs After how long a running run counts as
   *   abandoned
   * @returns {Promise<Object|null>} The run, null where another process
   *   holds it or it is done
   */
  static async claimRun({
    tenantId,
    facilityId,
    dueAt,
    trigger,
    owner,
    now,
    staleMs,
  }) {
    const run = {
      id: uuidv4(),
      tenantId,
      facilityId,
      dueAt,
      trigger,
      owner,
      status: RESET_RUN_STATUS.RUNNING,
      startedAt: now,
    };
    try {
      await AdmissionResetRunModel.create(run);
      return run;
    } catch (err) {
      if (err.code !== DUPLICATE_KEY) {
        throw err;
      }
    }
    // Taken over: a run that failed, or one abandoned by its owner.
    return AdmissionResetRunModel.findOneAndUpdate(
      {
        tenantId,
        facilityId,
        dueAt,
        $or: [
          { status: RESET_RUN_STATUS.FAILED },
          {
            status: RESET_RUN_STATUS.RUNNING,
            startedAt: { $lt: now - staleMs },
          },
        ],
      },
      {
        $set: {
          trigger,
          owner,
          status: RESET_RUN_STATUS.RUNNING,
          startedAt: now,
          finishedAt: null,
          error: null,
        },
      },
      { new: true, projection: { _id: 0, __v: 0 } },
    ).lean();
  }

  /**
   * @param {string} id
   * @param {{ status: string, finishedAt: number, resetCount?: number,
   *   expiredCount?: number, error?: string|null }} result
   * @returns {Promise<void>}
   */
  static async finishRun(id, result) {
    await AdmissionResetRunModel.updateOne({ id }, { $set: result });
  }

  /**
   * The latest runs of a facility, newest first.
   *
   * @param {string} tenantId
   * @param {string} facilityId
   * @param {{ limit?: number }} [options]
   * @returns {Promise<Object[]>}
   */
  static async getRuns(tenantId, facilityId, { limit } = {}) {
    return AdmissionResetRunModel.find(
      { tenantId, facilityId },
      { _id: 0, __v: 0 },
    )
      .sort({ dueAt: -1 })
      .limit(Math.min(Number.isInteger(limit) && limit > 0 ? limit : 30, 365))
      .lean();
  }
}

module.exports = AdmissionResetRunManager;
