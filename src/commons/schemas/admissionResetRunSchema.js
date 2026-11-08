/**
 * One run of the daily reset of a facility. The row is the lock
 * and the record at once: it is unique per facility and due time, so of
 * two processes that find the same reset due only one inserts it and runs.
 */
const RESET_RUN_STATUS = Object.freeze({
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
});

const RESET_RUN_TRIGGERS = Object.freeze({
  // The run at its due time.
  SCHEDULE: "schedule",
  // A run found missing when the job looked, e.g. after a downtime.
  CATCH_UP: "catchUp",
});

const admissionResetRunSchemaDefinition = {
  id: { type: String, required: true },
  tenantId: { type: String, required: true, ref: "Tenant" },
  facilityId: { type: String, required: true },
  // The reset time this run stands for, in epoch ms.
  dueAt: { type: Number, required: true },
  trigger: {
    type: String,
    enum: Object.values(RESET_RUN_TRIGGERS),
    required: true,
  },
  status: {
    type: String,
    enum: Object.values(RESET_RUN_STATUS),
    default: RESET_RUN_STATUS.RUNNING,
  },
  // Who holds the run: host and process, for a stale lock.
  owner: { type: String, default: null },
  startedAt: { type: Number, required: true },
  finishedAt: { type: Number, default: null },
  resetCount: { type: Number, default: 0 },
  expiredCount: { type: Number, default: 0 },
  error: { type: String, default: null },
};

module.exports = {
  RESET_RUN_STATUS,
  RESET_RUN_TRIGGERS,
  admissionResetRunSchemaDefinition,
};
