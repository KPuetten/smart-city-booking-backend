const mongoose = require("mongoose");
const {
  admissionCheckSchemaDefinition,
} = require("../../schemas/admissionCheckSchema");

const { Schema } = mongoose;

const AdmissionCheckSchema = new Schema(admissionCheckSchemaDefinition);

AdmissionCheckSchema.index({ tenantId: 1, facilityId: 1, at: -1 });
AdmissionCheckSchema.index({ tenantId: 1, admissionId: 1, at: -1 });
// One check per request id of a device or a person: the claim of a scan
// sent twice at the same moment (`AdmissionCheckManager.claimCheck`).
AdmissionCheckSchema.index(
  { tenantId: 1, deviceId: 1, userId: 1, requestId: 1 },
  { unique: true, partialFilterExpression: { requestId: { $type: "string" } } },
);
AdmissionCheckSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports =
  mongoose.models.AdmissionCheck ||
  mongoose.model("AdmissionCheck", AdmissionCheckSchema);
