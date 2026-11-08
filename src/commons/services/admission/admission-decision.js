const { DateTime } = require("luxon");
const {
  CHECK_RESULTS,
  DENIAL_REASONS,
  DENIAL_STEP,
  NOTICES,
  messageOf,
} = require("./admission-reasons");
const { CODE_STATUS } = require("./admission-code");
const {
  ADMISSION_STATES,
  ADMISSION_KINDS,
  USAGE_EVENTS,
} = require("../../schemas/admissionSchema");
const {
  USAGE_MODES,
  CAPACITY_CHECKS,
} = require("../../entities/admission/admission-definition");

/**
 * The admission decision: the one answer to "may this admission
 * enter this facility now?", and to "may it leave?".
 *
 * Both functions are pure and synchronous - data in, decision out - like
 * the access decision of the doors (`access/access-decision.js`). They load
 * nothing and write nothing: the caller verifies the code, loads the
 * admission, counts who is checked in, and writes the effect the decision
 * hands back - on a granted check only, so a denied one leaves the
 * admission as it was.
 *
 * The entry runs the six steps of the check in their fixed order and stops at
 * the first that refuses:
 *
 *   1  the code is an admission's and unaltered, of this facility, and no
 *      bundle's parent ticket
 *   2  the admission is valid: not invalid, not blocked, within its validity
 *   3  its usage allows an entry: a day of use is left, or today is one
 *      already (a re-entry on the same day consumes nothing)
 *   4  it is checked out: no entry without an exit (where the facility
 *      scans exits; an entry past the stay limit counts as left)
 *   5  the block time since its last entry has passed
 *   6  the facility has room, where the tariff checks at the entry
 *
 * The days of use are local calendar days of the facility's time zone.
 *
 * @typedef {Object} Decision
 * @property {"granted"|"granted_with_notice"|"denied"} result
 * @property {number|null} step The step that refused, null where granted
 * @property {string|null} reason The refusal, from `DENIAL_REASONS`
 * @property {string} message The answer in German, for the entrance
 * @property {{ code: string, message: string }[]} notices What a granted
 *   check points the staff to; empty where denied
 * @property {Object} params The values the message names
 * @property {{ set: Object, entries: Object[] }|null} effect What to write
 *   to the admission, on the revision it was decided on; null where denied
 */

const MINUTE = 60 * 1000;

function dayOf(ms, timezone) {
  return DateTime.fromMillis(ms, { zone: timezone }).toISODate();
}

function dateOf(ms, timezone) {
  return DateTime.fromMillis(ms, { zone: timezone }).toFormat("dd.MM.yyyy");
}

function timeOf(ms, timezone) {
  return DateTime.fromMillis(ms, { zone: timezone }).toFormat("HH:mm");
}

function denied(reason, params = {}) {
  return {
    result: CHECK_RESULTS.DENIED,
    step: DENIAL_STEP[reason],
    reason,
    message: messageOf(reason, params),
    notices: [],
    params,
    effect: null,
  };
}

function granted(message, notices, params, effect) {
  return {
    result:
      notices.length > 0
        ? CHECK_RESULTS.GRANTED_WITH_NOTICE
        : CHECK_RESULTS.GRANTED,
    step: null,
    reason: null,
    message,
    notices: notices.map((code) => ({
      code,
      message: messageOf(code, params),
    })),
    params,
    effect,
  };
}

/**
 * Whether the admission counts as checked in at `now`: present, and not
 * past the stay limit of the facility (automatic exit).
 *
 * @param {Object} admission
 * @param {Object} facility Normalized facility settings
 * @param {number} now
 * @returns {boolean}
 */
function isPresent(admission, facility, now) {
  if (admission.state !== ADMISSION_STATES.PRESENT) {
    return false;
  }
  return !stayLimitPassed(admission, facility, now);
}

function stayLimitPassed(admission, facility, now) {
  return (
    admission.state === ADMISSION_STATES.PRESENT &&
    Number.isInteger(facility.maxStayMinutes) &&
    admission.lastEntryAt !== null &&
    admission.lastEntryAt + facility.maxStayMinutes * MINUTE < now
  );
}

/** Step 1, shared by entry and exit. */
function identify({ integrity, admission, facilityId }) {
  if (integrity === CODE_STATUS.MALFORMED) {
    return denied(DENIAL_REASONS.CODE_MALFORMED);
  }
  if (integrity === CODE_STATUS.FORGED) {
    return denied(DENIAL_REASONS.CODE_FORGED);
  }
  if (!admission) {
    return denied(DENIAL_REASONS.ADMISSION_UNKNOWN);
  }
  if (admission.facilityId !== facilityId) {
    return denied(DENIAL_REASONS.WRONG_FACILITY);
  }
  if (admission.kind === ADMISSION_KINDS.BUNDLE) {
    return denied(DENIAL_REASONS.BUNDLE_CODE);
  }
  return null;
}

/**
 * Decide an entry.
 *
 * @param {Object} input
 * @param {string} input.integrity The `CODE_STATUS` of the code
 * @param {Object|null} input.admission The admission the code names
 * @param {string} input.facilityId The facility checked at
 * @param {Object} input.facility Its normalized settings
 * @param {number|null} [input.capacity] Its capacity, null for none
 * @param {number} [input.presentCount] The admissions checked in there now
 * @param {number} [input.recentDenials] Refused checks of this admission in
 *   the last hour
 * @param {{ deviceId?: string|null, userId?: string|null }} [input.actor]
 * @param {number} input.now
 * @returns {Decision}
 */
function decideEntry({
  integrity,
  admission,
  facilityId,
  facility,
  capacity = null,
  presentCount = 0,
  recentDenials = 0,
  actor = {},
  now,
}) {
  const refused = identify({ integrity, admission, facilityId });
  if (refused) {
    return refused;
  }

  const { entitlement } = admission;
  const timezone = entitlement.timezone;
  const today = dayOf(now, timezone);

  // Step 2: valid.
  if (admission.state === ADMISSION_STATES.INVALID) {
    return denied(DENIAL_REASONS.ADMISSION_INVALID);
  }
  if (admission.state === ADMISSION_STATES.BLOCKED) {
    return denied(DENIAL_REASONS.ADMISSION_BLOCKED);
  }
  if (now < entitlement.validFrom) {
    return denied(DENIAL_REASONS.NOT_YET_VALID, {
      validFrom: dateOf(entitlement.validFrom, timezone),
    });
  }
  if (
    now > entitlement.validTo ||
    admission.state === ADMISSION_STATES.EXPIRED
  ) {
    return denied(DENIAL_REASONS.EXPIRED, {
      validTo: dateOf(entitlement.validTo, timezone),
    });
  }

  // Step 3: a day of use left, or today is one already.
  const usedDays = admission.usedDays || [];
  const reentry = usedDays.includes(today);
  const limited = entitlement.usage !== USAGE_MODES.UNLIMITED;
  if (!reentry && limited && !(admission.remainingDays > 0)) {
    return entitlement.usage === USAGE_MODES.SINGLE
      ? denied(DENIAL_REASONS.ALREADY_USED, {
          lastDay: usedDays.length
            ? DateTime.fromISO(usedDays[usedDays.length - 1]).toFormat(
                "dd.MM.yyyy",
              )
            : null,
        })
      : denied(DENIAL_REASONS.QUOTA_EXHAUSTED);
  }

  // Step 4: checked out. Where the facility scans no exits, only the
  // reset and the stay limit check anybody out; the block time keeps the
  // card from being passed back meanwhile.
  const present = isPresent(admission, facility, now);
  if (facility.exitScan && present) {
    return denied(DENIAL_REASONS.ALREADY_PRESENT);
  }

  // Step 5: the block time since the last entry.
  if (entitlement.blockMinutes > 0 && admission.lastEntryAt !== null) {
    const blockedUntil =
      admission.lastEntryAt + entitlement.blockMinutes * MINUTE;
    if (now < blockedUntil) {
      return denied(DENIAL_REASONS.BLOCK_TIME, {
        blockedUntil: timeOf(blockedUntil, timezone),
      });
    }
  }

  // Step 6: room at the facility, where the tariff checks at the entry. An
  // admission still counted present does not take its own place.
  if (
    entitlement.capacityCheck === CAPACITY_CHECKS.ENTRY &&
    Number.isInteger(capacity) &&
    capacity > 0
  ) {
    const others = presentCount - (present ? 1 : 0);
    if (others >= capacity) {
      return denied(DENIAL_REASONS.CAPACITY_REACHED, {
        present: others,
        capacity,
      });
    }
  }

  // Granted: what the entry writes.
  const consumesDay = !reentry;
  const remainingDays =
    limited && consumesDay
      ? admission.remainingDays - 1
      : admission.remainingDays;
  const entries = [];
  const autoExit = stayLimitPassed(admission, facility, now);
  if (autoExit) {
    entries.push({
      type: USAGE_EVENTS.AUTO_EXIT,
      at: admission.lastEntryAt + facility.maxStayMinutes * MINUTE,
      day: null,
      dayConsumed: false,
      fromState: ADMISSION_STATES.PRESENT,
      toState: ADMISSION_STATES.ABSENT,
    });
  }
  entries.push({
    type: USAGE_EVENTS.ENTRY,
    at: now,
    day: today,
    dayConsumed: consumesDay,
    fromState: autoExit ? ADMISSION_STATES.ABSENT : admission.state,
    toState: ADMISSION_STATES.PRESENT,
    deviceId: actor.deviceId ?? null,
    userId: actor.userId ?? null,
  });

  const notices = [];
  if (reentry) {
    notices.push(NOTICES.REENTRY);
  }
  if (
    entitlement.usage === USAGE_MODES.QUOTA &&
    consumesDay &&
    remainingDays === 0
  ) {
    notices.push(NOTICES.LAST_DAY);
  }
  if (autoExit) {
    notices.push(NOTICES.STAY_LIMIT_PASSED);
  }
  if (recentDenials > 0) {
    notices.push(NOTICES.RECENT_DENIALS);
  }
  if (entitlement.personalized) {
    notices.push(NOTICES.CHECK_PHOTO);
  }

  return granted(
    messageOf(CHECK_RESULTS.GRANTED),
    notices,
    { recentDenials, remainingDays },
    {
      set: {
        state: ADMISSION_STATES.PRESENT,
        lastEntryAt: now,
        entryCount: (admission.entryCount || 0) + 1,
        usedDays: consumesDay ? [...usedDays, today] : usedDays,
        remainingDays,
      },
      entries,
    },
  );
}

/**
 * Decide an exit: only where the facility scans exits, only of an
 * admission checked in. It leaves as `consumed` where no day of use is
 * left, `absent` otherwise.
 *
 * @param {Object} input
 * @param {string} input.integrity
 * @param {Object|null} input.admission
 * @param {string} input.facilityId
 * @param {Object} input.facility
 * @param {{ deviceId?: string|null, userId?: string|null }} [input.actor]
 * @param {number} input.now
 * @returns {Decision}
 */
function decideExit({
  integrity,
  admission,
  facilityId,
  facility,
  actor = {},
  now,
}) {
  const refused = identify({ integrity, admission, facilityId });
  if (refused) {
    return refused;
  }
  if (!facility.exitScan) {
    return denied(DENIAL_REASONS.EXIT_DISABLED);
  }
  if (!isPresent(admission, facility, now)) {
    return denied(DENIAL_REASONS.NOT_PRESENT);
  }
  const toState =
    admission.remainingDays === 0
      ? ADMISSION_STATES.CONSUMED
      : ADMISSION_STATES.ABSENT;
  return granted(
    messageOf("exitGranted"),
    [],
    {},
    {
      set: { state: toState, lastExitAt: now },
      entries: [
        {
          type: USAGE_EVENTS.EXIT,
          at: now,
          day: dayOf(now, admission.entitlement.timezone),
          dayConsumed: false,
          fromState: ADMISSION_STATES.PRESENT,
          toState,
          deviceId: actor.deviceId ?? null,
          userId: actor.userId ?? null,
        },
      ],
    },
  );
}

module.exports = {
  decideEntry,
  decideExit,
  isPresent,
  dayOf,
};
