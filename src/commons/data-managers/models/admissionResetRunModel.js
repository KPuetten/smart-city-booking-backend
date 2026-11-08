const mongoose = require("mongoose");
const {
  admissionResetRunSchemaDefinition,
} = require("../../schemas/admissionResetRunSchema");

const { Schema } = mongoose;

const AdmissionResetRunSchema = new Schema(admissionResetRunSchemaDefinition);

// The lock: one run per facility and due time.
AdmissionResetRunSchema.index(
  { tenantId: 1, facilityId: 1, dueAt: 1 },
  { unique: true },
);

module.exports =
  mongoose.models.AdmissionResetRun ||
  mongoose.model("AdmissionResetRun", AdmissionResetRunSchema);
