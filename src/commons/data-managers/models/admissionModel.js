const mongoose = require("mongoose");
const { admissionSchemaDefinition } = require("../../schemas/admissionSchema");

const { Schema } = mongoose;

const AdmissionSchema = new Schema(admissionSchemaDefinition);

AdmissionSchema.index({ tenantId: 1, id: 1 }, { unique: true });
// The lookup of a scan: the identifier the code carries.
AdmissionSchema.index({ tenantId: 1, key: 1 }, { unique: true });
// One admission per place in the booking: an issuance that runs twice
// inserts nothing the second time.
AdmissionSchema.index(
  { tenantId: 1, bookingId: 1, itemIndex: 1, unitIndex: 1, memberIndex: 1 },
  { unique: true },
);
AdmissionSchema.index({ tenantId: 1, facilityId: 1, state: 1 });

AdmissionSchema.methods.toEntity = function () {
  const { Admission } = require("../../entities/admission/admission");
  return new Admission(this.toObject());
};

module.exports =
  mongoose.models.Admission || mongoose.model("Admission", AdmissionSchema);
