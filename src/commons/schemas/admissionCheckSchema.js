/**
 * One check at an entrance, logged in full: every
 * scan a device or a member of staff sends, granted or not, with the
 * answer it got. A denied check changes no admission, so this log
 * is the only trace it leaves. The answer is kept so that a scan sent twice
 * with the same `requestId` is answered the same without a second effect.
 * Rows expire after `ADMISSION_CHECK_LOG_RETENTION_DAYS`.
 */
const ADMISSION_CHECK_DIRECTIONS = Object.freeze({
  ENTRY: "entry",
  EXIT: "exit",
});

/**
 * The `result` of a check with a `requestId` while it is decided: the row
 * claims the request id first, so a twin sent at the same moment waits for
 * its answer instead of deciding again.
 */
const ADMISSION_CHECK_PENDING = "pending";

/**
 * The `result` of a check that came to no decision because its write kept
 * meeting the writes of other devices (`admission_check_contended`): logged,
 * answered `503`, and decided anew when it is sent again.
 */
const ADMISSION_CHECK_ERROR = "error";

const admissionCheckSchemaDefinition = {
  id: { type: String, required: true },
  tenantId: { type: String, required: true, ref: "Tenant" },
  facilityId: { type: String, required: true },
  direction: {
    type: String,
    enum: Object.values(ADMISSION_CHECK_DIRECTIONS),
    required: true,
  },
  deviceId: { type: String, default: null },
  userId: { type: String, default: null },
  requestId: { type: String, default: null },
  admissionId: { type: String, default: null },
  result: { type: String, required: true },
  reason: { type: String, default: null },
  notices: { type: [String], default: [] },
  answer: { type: Object, default: {} },
  at: { type: Number, required: true },
  expiresAt: { type: Date, default: null },
};

module.exports = {
  ADMISSION_CHECK_DIRECTIONS,
  ADMISSION_CHECK_PENDING,
  ADMISSION_CHECK_ERROR,
  admissionCheckSchemaDefinition,
};
