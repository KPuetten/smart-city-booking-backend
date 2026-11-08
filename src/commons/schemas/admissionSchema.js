const { Schema } = require("mongoose");
const {
  USAGE_MODES,
  CAPACITY_CHECKS,
} = require("../entities/admission/admission-definition");

/**
 * The states of an admission (German "Zugangsberechtigung"). The
 * state is written only by a granted check, a correction of the
 * administration, the daily reset and the booking lifecycle; everything
 * else about an admission is read off its usage log.
 */
const ADMISSION_STATES = Object.freeze({
  // Issued, never used.
  ISSUED: "issued",
  // Checked in, no exit recorded since.
  PRESENT: "present",
  // Used before, checked out (by a scan, the reset or the stay limit).
  ABSENT: "absent",
  // No day of use left; a re-entry on the day last used stays possible.
  CONSUMED: "consumed",
  // Past the end of its validity.
  EXPIRED: "expired",
  // Blocked by the administration, restorable.
  BLOCKED: "blocked",
  // Its booking was cancelled, withdrawn or deleted.
  INVALID: "invalid",
});

/** What an admission is within its booking. */
const ADMISSION_KINDS = Object.freeze({
  // One person, one admission.
  SINGLE: "single",
  // The parent ticket of a bundle: groups its members, admits nobody.
  BUNDLE: "bundle",
  // One person of a bundle.
  MEMBER: "member",
});

/** The entries of the usage log. */
const USAGE_EVENTS = Object.freeze({
  ISSUE: "issue",
  ENTRY: "entry",
  EXIT: "exit",
  // The stay limit of the facility passed without an exit scan.
  AUTO_EXIT: "autoExit",
  RESET: "reset",
  EXPIRE: "expire",
  BLOCK: "block",
  UNBLOCK: "unblock",
  INVALIDATE: "invalidate",
  RESTORE: "restore",
  // A correction of the administration: presence reset, entry taken back.
  CORRECTION: "correction",
});

const usageEntrySchemaDefinition = {
  type: {
    type: String,
    enum: Object.values(USAGE_EVENTS),
    required: true,
  },
  at: { type: Number, required: true },
  // The local calendar day of the facility the entry belongs to.
  day: { type: String, default: null },
  // Whether the entry consumed a day of use (a first entry of the day).
  dayConsumed: { type: Boolean, default: false },
  fromState: { type: String, default: null },
  toState: { type: String, default: null },
  deviceId: { type: String, default: null },
  userId: { type: String, default: null },
  reason: { type: String, default: null },
  runId: { type: String, default: null },
  // A correction that takes an entry back names it by its time.
  reverts: { type: Number, default: null },
};

// The definition of the tariff as it was at the issuance: never
// a live reference to the bookable.
const entitlementSchemaDefinition = {
  validFrom: { type: Number, required: true },
  validTo: { type: Number, required: true },
  usage: { type: String, enum: Object.values(USAGE_MODES), required: true },
  quota: { type: Number, default: null },
  blockMinutes: { type: Number, default: 0 },
  personalized: { type: Boolean, default: false },
  capacityCheck: {
    type: String,
    enum: Object.values(CAPACITY_CHECKS),
    default: CAPACITY_CHECKS.BOOKING,
  },
  timezone: { type: String, required: true },
};

const admissionSchemaDefinition = {
  id: { type: String, required: true },
  tenantId: { type: String, required: true, ref: "Tenant" },
  // The random identifier the code carries (German "Zugangskennung").
  key: { type: String, required: true },
  bookingId: { type: String, required: true },
  // Where in the booking it comes from: position, unit, bundle member.
  itemIndex: { type: Number, required: true },
  unitIndex: { type: Number, required: true },
  memberIndex: { type: Number, default: 0 },
  bookableId: { type: String, required: true },
  bookableTitle: { type: String, default: "" },
  // The facility it is checked at: the tariff's parent with admission
  // settings, null where the tariff has none.
  facilityId: { type: String, default: null },
  kind: {
    type: String,
    enum: Object.values(ADMISSION_KINDS),
    default: ADMISSION_KINDS.SINGLE,
  },
  bundleId: { type: String, default: null },
  entitlement: {
    type: new Schema(entitlementSchemaDefinition, { _id: false }),
    required: true,
  },
  state: {
    type: String,
    enum: Object.values(ADMISSION_STATES),
    default: ADMISSION_STATES.ISSUED,
  },
  // The state a block or an invalidation came from, to restore it.
  stateBefore: { type: String, default: null },
  // Days of use left: 1 for `single`, the quota for `quota`, null unlimited.
  remainingDays: { type: Number, default: null },
  usedDays: { type: [String], default: [] },
  entryCount: { type: Number, default: 0 },
  lastEntryAt: { type: Number, default: null },
  lastExitAt: { type: Number, default: null },
  usage: {
    type: [new Schema(usageEntrySchemaDefinition, { _id: false })],
    default: [],
  },
  // Bumped by every write: the check writes on the revision it decided on.
  revision: { type: Number, default: 0 },
  timeCreated: { type: Number, default: () => Date.now() },
  timeUpdated: { type: Number, default: () => Date.now() },
};

module.exports = {
  ADMISSION_STATES,
  ADMISSION_KINDS,
  USAGE_EVENTS,
  admissionSchemaDefinition,
  usageEntrySchemaDefinition,
  entitlementSchemaDefinition,
};
