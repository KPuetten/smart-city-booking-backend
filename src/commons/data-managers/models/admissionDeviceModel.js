const mongoose = require("mongoose");
const {
  admissionDeviceSchemaDefinition,
} = require("../../schemas/admissionDeviceSchema");

const { Schema } = mongoose;

const AdmissionDeviceSchema = new Schema(admissionDeviceSchemaDefinition);

AdmissionDeviceSchema.index({ tenantId: 1, id: 1 }, { unique: true });

module.exports =
  mongoose.models.AdmissionDevice ||
  mongoose.model("AdmissionDevice", AdmissionDeviceSchema);
