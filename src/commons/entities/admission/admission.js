const SchemaUtils = require("../../utilities/schemaUtils");
const {
  admissionSchemaDefinition,
  ADMISSION_STATES,
  ADMISSION_KINDS,
  USAGE_EVENTS,
} = require("../../schemas/admissionSchema");

/**
 * An admission (German "Zugangsberechtigung"): the right to enter
 * a facility that a booking hands out, the object every check at the
 * entrance works on. It hangs on its booking and copies what it allows
 * from the tariff at its issuance (`entitlement`); its state and its usage
 * log say what holds for it now and what happened to it.
 *
 * It carries no personal data of the booking: the entrance sees what the
 * admission allows, not who booked it.
 */
class Admission {
  constructor(params = {}) {
    const defaults = SchemaUtils.createDefaults(admissionSchemaDefinition);
    const allowedKeys = Object.keys(admissionSchemaDefinition);
    const filtered = Object.fromEntries(
      Object.entries(params).filter(([key]) => allowedKeys.includes(key)),
    );
    Object.assign(this, defaults, filtered);
  }

  /** Whether this is the parent ticket of a bundle, which admits nobody. */
  get isBundle() {
    return this.kind === ADMISSION_KINDS.BUNDLE;
  }

  /**
   * The admission as the API answers it. The identifier stays out unless
   * asked for: the administration may show the code, the entrance gets it
   * scanned and never needs it back.
   *
   * @param {{ code?: string|null }} [options] The code to add
   * @returns {Object}
   */
  toResponse({ code = null } = {}) {
    return {
      id: this.id,
      tenantId: this.tenantId,
      bookingId: this.bookingId,
      bookableId: this.bookableId,
      bookableTitle: this.bookableTitle,
      facilityId: this.facilityId,
      kind: this.kind,
      bundleId: this.bundleId,
      memberIndex: this.memberIndex,
      entitlement: this.entitlement,
      state: this.state,
      remainingDays: this.remainingDays,
      usedDays: this.usedDays,
      entryCount: this.entryCount,
      lastEntryAt: this.lastEntryAt,
      lastExitAt: this.lastExitAt,
      usage: this.usage,
      timeCreated: this.timeCreated,
      timeUpdated: this.timeUpdated,
      ...(code ? { code } : {}),
    };
  }
}

module.exports = {
  Admission,
  ADMISSION_STATES,
  ADMISSION_KINDS,
  USAGE_EVENTS,
};
