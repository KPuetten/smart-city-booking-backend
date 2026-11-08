/**
 * An admission device (German "Einlassgerät"): a scanner or a
 * browser at the entrance of one facility, authorized by a token of its
 * own. Only the SHA-256 of the token is stored; the token itself is
 * answered once, when the device is created or its token renewed.
 */
const ADMISSION_DEVICE_STATUS = Object.freeze({
  ACTIVE: "active",
  BLOCKED: "blocked",
});

const admissionDeviceSchemaDefinition = {
  id: { type: String, required: true },
  tenantId: { type: String, required: true, ref: "Tenant" },
  facilityId: { type: String, required: true },
  label: { type: String, required: true },
  tokenHash: { type: String, required: true },
  // The last characters of the token, so staff can tell two tokens apart.
  tokenHint: { type: String, default: "" },
  status: {
    type: String,
    enum: Object.values(ADMISSION_DEVICE_STATUS),
    default: ADMISSION_DEVICE_STATUS.ACTIVE,
  },
  blockReason: { type: String, default: null },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null },
  lastSeenAt: { type: Number, default: null },
  tokenRenewedAt: { type: Number, default: null },
  timeCreated: { type: Number, default: () => Date.now() },
  timeUpdated: { type: Number, default: () => Date.now() },
};

module.exports = { ADMISSION_DEVICE_STATUS, admissionDeviceSchemaDefinition };
