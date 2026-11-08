const { DateTime, IANAZone } = require("luxon");
const { ValidationError } = require("../../../errors/ValidationError");

/**
 * The admission definition of a tariff (German "Berechtigungsdefinition"):
 * what a ticket bookable hands to every admission it issues, and the
 * settings of the facility (German "Einrichtung") its admissions are
 * checked at. Both are plain data on the bookable (`admission` on a
 * ticket, `admissionFacility` on its parent); this module names their
 * vocabulary, fills in the defaults and validates them. It loads nothing.
 */

/** How the validity of an admission is found. */
const VALIDITY_MODES = Object.freeze({
  // A fixed window of calendar days, e.g. a season.
  WINDOW: "window",
  // A number of days from the issuance on, e.g. twelve months from purchase.
  DURATION: "duration",
  // The period of the booking itself, e.g. a day ticket or a time-limited
  // access for contractors.
  BOOKING: "booking",
});

/** What an admission allows within its validity. */
const USAGE_MODES = Object.freeze({
  // One day of use. A re-entry on that day consumes nothing.
  SINGLE: "single",
  // Every day of the validity.
  UNLIMITED: "unlimited",
  // A number of days of use, counted on the admission.
  QUOTA: "quota",
});

/** When the capacity of the facility is checked for a tariff. */
const CAPACITY_CHECKS = Object.freeze({
  BOOKING: "booking",
  ENTRY: "entry",
  NONE: "none",
});

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const MAX_BLOCK_MINUTES = 24 * 60;
const MAX_ADMISSIONS_PER_UNIT = 50;
const DEFAULT_TIMEZONE = "Europe/Berlin";
const DEFAULT_RESET_TIME = "03:00";

const isInteger = (value) => Number.isInteger(value);

/** A day of the calendar as `YYYY-MM-DD`: well formed and one that exists. */
const isCalendarDate = (value) =>
  typeof value === "string" &&
  DATE_PATTERN.test(value) &&
  DateTime.fromISO(value).isValid;

/**
 * The definition of a tariff with every default filled in, or `null` where
 * the tariff issues no admissions.
 *
 * @param {Object|null|undefined} definition `bookable.admission`
 * @returns {Object|null}
 */
function normalizeDefinition(definition) {
  if (!definition || definition.enabled === false) {
    return null;
  }
  const usageMode = definition.usage?.mode ?? USAGE_MODES.SINGLE;
  return {
    validity: {
      mode: definition.validity?.mode ?? VALIDITY_MODES.BOOKING,
      from: definition.validity?.from ?? null,
      to: definition.validity?.to ?? null,
      days: definition.validity?.days ?? null,
    },
    usage: {
      mode: usageMode,
      quota: usageMode === USAGE_MODES.QUOTA ? definition.usage?.quota : null,
    },
    blockMinutes: definition.blockMinutes ?? 0,
    personalized: definition.personalized === true,
    admissionsPerUnit: definition.admissionsPerUnit ?? 1,
    capacityCheck: definition.capacityCheck ?? CAPACITY_CHECKS.BOOKING,
  };
}

/**
 * The settings of a facility with every default filled in, or `null` where
 * the bookable is no facility with admission checks.
 *
 * @param {Object|null|undefined} settings `bookable.admissionFacility`
 * @returns {Object|null}
 */
function normalizeFacility(settings) {
  if (!settings || settings.enabled === false) {
    return null;
  }
  return {
    resetTime: settings.resetTime ?? DEFAULT_RESET_TIME,
    exitScan: settings.exitScan !== false,
    maxStayMinutes: settings.maxStayMinutes ?? null,
    timezone: settings.timezone ?? DEFAULT_TIMEZONE,
  };
}

/**
 * Whether a bookable is a tariff whose admissions are valid for the booked
 * period (`validity.mode` `booking`, a day ticket): it is sold while that
 * period lasts, not only before it begins.
 *
 * @param {Object} bookable
 * @returns {boolean}
 */
function isValidForBookedPeriod(bookable) {
  if (bookable?.type !== "ticket") {
    return false;
  }
  return (
    normalizeDefinition(bookable.admission)?.validity.mode ===
    VALIDITY_MODES.BOOKING
  );
}

/** What decides when the daily reset of a facility is due. */
function scheduleOf(settings) {
  return [
    settings.enabled !== false,
    settings.resetTime ?? DEFAULT_RESET_TIME,
    settings.timezone ?? DEFAULT_TIMEZONE,
  ].join("|");
}

/**
 * The facility settings to store, with `scheduleChangedAt`: the time the
 * schedule of the daily reset (reset time, time zone, switched on) last
 * changed. The daily reset reads it to tell a reset time moved after the
 * day's reset ran (`isRescheduledPast`). Taken from the stored settings
 * where the schedule is unchanged, so neither another edit of the
 * bookable nor a value sent by a client moves it.
 *
 * @param {Object|null|undefined} next The settings as they are to be stored
 * @param {Object|null|undefined} stored The settings as they are stored
 * @param {number} now Epoch ms
 * @returns {Object|null|undefined}
 */
function stampFacilitySchedule(next, stored, now) {
  if (!next) {
    return next;
  }
  const changed = !stored || scheduleOf(next) !== scheduleOf(stored);
  return {
    ...next,
    scheduleChangedAt: changed ? now : stored.scheduleChangedAt ?? null,
  };
}

/**
 * The validation errors of a definition, as `SchemaUtils` names them.
 *
 * @param {Object} definition A normalized definition
 * @returns {Object[]}
 */
function definitionErrors(definition) {
  const errors = [];
  const error = (field, code, params = {}) =>
    errors.push({ field: `admission.${field}`, code, params });

  const { validity, usage } = definition;
  if (!Object.values(VALIDITY_MODES).includes(validity.mode)) {
    error("validity.mode", "invalid_enum", {
      allowed: Object.values(VALIDITY_MODES),
    });
  }
  if (validity.mode === VALIDITY_MODES.WINDOW) {
    if (!isCalendarDate(validity.from)) {
      error("validity.from", "invalid_format", { format: "YYYY-MM-DD" });
    }
    if (!isCalendarDate(validity.to)) {
      error("validity.to", "invalid_format", { format: "YYYY-MM-DD" });
    }
    if (errors.length === 0 && validity.from > validity.to) {
      error("validity.to", "greater_equal_than", { field: "validity.from" });
    }
  }
  if (
    validity.mode === VALIDITY_MODES.DURATION &&
    !(isInteger(validity.days) && validity.days >= 1)
  ) {
    error("validity.days", "min_value", { min: 1 });
  }
  if (!Object.values(USAGE_MODES).includes(usage.mode)) {
    error("usage.mode", "invalid_enum", {
      allowed: Object.values(USAGE_MODES),
    });
  }
  if (
    usage.mode === USAGE_MODES.QUOTA &&
    !(isInteger(usage.quota) && usage.quota >= 1)
  ) {
    error("usage.quota", "min_value", { min: 1 });
  }
  if (
    !isInteger(definition.blockMinutes) ||
    definition.blockMinutes < 0 ||
    definition.blockMinutes > MAX_BLOCK_MINUTES
  ) {
    error("blockMinutes", "invalid_custom", { min: 0, max: MAX_BLOCK_MINUTES });
  }
  if (
    !isInteger(definition.admissionsPerUnit) ||
    definition.admissionsPerUnit < 1 ||
    definition.admissionsPerUnit > MAX_ADMISSIONS_PER_UNIT
  ) {
    error("admissionsPerUnit", "invalid_custom", {
      min: 1,
      max: MAX_ADMISSIONS_PER_UNIT,
    });
  }
  if (!Object.values(CAPACITY_CHECKS).includes(definition.capacityCheck)) {
    error("capacityCheck", "invalid_enum", {
      allowed: Object.values(CAPACITY_CHECKS),
    });
  }
  return errors;
}

/**
 * The validation errors of facility settings.
 *
 * @param {Object} settings Normalized facility settings
 * @returns {Object[]}
 */
function facilityErrors(settings) {
  const errors = [];
  const error = (field, code, params = {}) =>
    errors.push({ field: `admissionFacility.${field}`, code, params });

  if (!TIME_PATTERN.test(settings.resetTime)) {
    error("resetTime", "invalid_format", { format: "HH:mm" });
  }
  if (
    settings.maxStayMinutes !== null &&
    !(isInteger(settings.maxStayMinutes) && settings.maxStayMinutes >= 1)
  ) {
    error("maxStayMinutes", "min_value", { min: 1 });
  }
  if (!IANAZone.isValidZone(settings.timezone)) {
    error("timezone", "invalid_format", { format: "IANA time zone" });
  }
  return errors;
}

/**
 * The positions of a booking that issue admissions: the tickets whose
 * snapshot (`_bookableUsed`, the tariff as it was booked) carries an
 * admission definition. Read off the booking alone, so the booking
 * lifecycle can tell without a load whether a booking has any - every
 * other booking runs the pipeline it ran before.
 *
 * @param {Object} booking
 * @returns {{ itemIndex: number, item: Object, tariff: Object,
 *   definition: Object }[]}
 */
function admissionPositionsOf(booking) {
  return (booking?.bookableItems || []).flatMap((item, itemIndex) => {
    const tariff = item?._bookableUsed;
    const definition =
      tariff?.type === "ticket" ? normalizeDefinition(tariff.admission) : null;
    return definition ? [{ itemIndex, item, tariff, definition }] : [];
  });
}

/** Whether a booking issues admissions. */
function hasAdmissionPositions(booking) {
  return admissionPositionsOf(booking).length > 0;
}

/**
 * Validates the admission fields of a bookable: a definition only on a
 * ticket, facility settings only on a bookable that is no ticket, each
 * well formed.
 *
 * @param {Object} bookable The bookable entity
 * @throws {ValidationError} With the errors of both fields
 */
function validateAdmissionFields(bookable) {
  const errors = [];
  const definition = normalizeDefinition(bookable.admission);
  if (definition) {
    if (bookable.type !== "ticket") {
      errors.push({
        field: "admission",
        code: "admission_ticket_only",
        params: {},
      });
    }
    errors.push(...definitionErrors(definition));
  }
  const facility = normalizeFacility(bookable.admissionFacility);
  if (facility) {
    if (bookable.type === "ticket") {
      errors.push({
        field: "admissionFacility",
        code: "admission_facility_not_ticket",
        params: {},
      });
    }
    errors.push(...facilityErrors(facility));
  }
  if (errors.length > 0) {
    throw new ValidationError(errors);
  }
}

module.exports = {
  VALIDITY_MODES,
  USAGE_MODES,
  CAPACITY_CHECKS,
  DEFAULT_TIMEZONE,
  normalizeDefinition,
  normalizeFacility,
  isValidForBookedPeriod,
  stampFacilitySchedule,
  validateAdmissionFields,
  admissionPositionsOf,
  hasAdmissionPositions,
};
