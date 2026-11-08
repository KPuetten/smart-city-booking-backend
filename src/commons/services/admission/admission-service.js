const { v4: uuidv4 } = require("uuid");
const { DateTime } = require("luxon");
const bunyan = require("bunyan");

const AdmissionManager = require("../../data-managers/admission-manager");
const { BookableManager } = require("../../data-managers/bookable-manager");
const { DOMAIN } = require("../authorization/reach");
const {
  admissionPositionsOf,
  normalizeFacility,
  VALIDITY_MODES,
  USAGE_MODES,
  DEFAULT_TIMEZONE,
} = require("../../entities/admission/admission-definition");
const {
  ADMISSION_STATES,
  ADMISSION_KINDS,
  USAGE_EVENTS,
} = require("../../schemas/admissionSchema");
const { generateKey } = require("./admission-code");
const { stateAfterResets } = require("./admission-reset-service");
const {
  BadRequestError,
  ConflictError,
  NotFoundError,
} = require("../../../errors/BaseError");

const logger = bunyan.createLogger({
  name: "admission-service.js",
  level: process.env.LOG_LEVEL,
});

/** Why the admissions of a booking were invalidated, by its transition. */
const INVALIDATION_REASONS = Object.freeze({
  CANCELLED: "booking_cancelled",
  WITHDRAWN: "booking_withdrawn",
  DELETED: "booking_deleted",
});

/** The corrections the administration may make. */
const CORRECTIONS = Object.freeze({
  BLOCK: "block",
  UNBLOCK: "unblock",
  RESET_PRESENCE: "resetPresence",
  REVERT_ENTRY: "revertEntry",
});

/**
 * The validity window of an admission issued at `now`, in epoch
 * ms: a window of calendar days of the facility's time zone, a number of
 * days from the issuance on, or the period of the booking. A booking
 * without a period counts as the day of the issuance.
 */
function validityOf(definition, booking, timezone, now) {
  const { validity } = definition;
  const zoned = (ms) => DateTime.fromMillis(ms, { zone: timezone });
  if (validity.mode === VALIDITY_MODES.WINDOW) {
    return {
      validFrom: DateTime.fromISO(validity.from, { zone: timezone })
        .startOf("day")
        .toMillis(),
      validTo: DateTime.fromISO(validity.to, { zone: timezone })
        .endOf("day")
        .toMillis(),
    };
  }
  if (validity.mode === VALIDITY_MODES.DURATION) {
    return {
      validFrom: now,
      validTo: zoned(now)
        .plus({ days: validity.days - 1 })
        .endOf("day")
        .toMillis(),
    };
  }
  const begin = Number(booking.timeBegin) || null;
  const end = Number(booking.timeEnd) || null;
  return {
    validFrom: begin ?? zoned(now).startOf("day").toMillis(),
    validTo: end ?? zoned(now).endOf("day").toMillis(),
  };
}

function remainingDaysOf(definition) {
  if (definition.usage.mode === USAGE_MODES.SINGLE) return 1;
  if (definition.usage.mode === USAGE_MODES.QUOTA) {
    return definition.usage.quota;
  }
  return null;
}

/**
 * The facility of a tariff: the first of its parents with admission
 * settings. A parent lists its children in `relatedBookableIds`, as the
 * hierarchy of the administration and the capacity checks of the checkout
 * read it, so the facility is the one that lists the tariff.
 */
function facilityOf(tariff, facilities) {
  return (
    facilities.find((facility) =>
      (facility.relatedBookableIds || []).includes(tariff.id),
    ) ?? null
  );
}

class AdmissionService {
  /**
   * Issues the admissions of a booking that became binding: one
   * per unit of a ticket position, a bundle's parent ticket and its members
   * where the tariff issues several per unit. What each allows is
   * copied from the tariff as the booking holds it (`_bookableUsed`), so a
   * later change of the tariff changes no admission. Issuing again issues
   * nothing twice; admissions invalidated by a cancellation get the state
   * back they were invalidated from (a reinstatement), as the daily resets
   * since would have left it (`stateAfterResets`).
   *
   * @param {string} tenantId
   * @param {Object} booking The booking, as the lifecycle holds it
   * @param {{ now?: number }} [options]
   * @returns {Promise<{ issued: number, restored: number }>}
   */
  static async issueForBooking(tenantId, booking, { now = Date.now() } = {}) {
    const positions = admissionPositionsOf(booking);
    if (positions.length === 0) {
      return { issued: 0, restored: 0 };
    }

    const facilities = (
      await BookableManager.getAdmissionFacilitiesOf(
        tenantId,
        [...new Set(positions.map((p) => p.tariff.id))],
        DOMAIN,
      )
    ).filter((facility) => normalizeFacility(facility.admissionFacility));

    const restored = await AdmissionService._restoreInvalidated(
      tenantId,
      booking.id,
      facilities,
      now,
    );

    const admissions = [];
    for (const { itemIndex, item, tariff, definition } of positions) {
      const facility = facilityOf(tariff, facilities);
      if (!facility) {
        logger.warn(
          { tenantId, bookingId: booking.id, bookableId: tariff.id },
          "admission tariff has no facility with admission settings",
        );
      }
      const timezone =
        normalizeFacility(facility?.admissionFacility)?.timezone ??
        DEFAULT_TIMEZONE;
      const entitlement = {
        ...validityOf(definition, booking, timezone, now),
        usage: definition.usage.mode,
        quota: definition.usage.quota,
        blockMinutes: definition.blockMinutes,
        personalized: definition.personalized,
        capacityCheck: definition.capacityCheck,
        timezone,
      };
      const base = {
        tenantId,
        bookingId: booking.id,
        itemIndex,
        bookableId: tariff.id,
        bookableTitle: tariff.title || "",
        facilityId: facility?.id ?? null,
        entitlement,
        state: ADMISSION_STATES.ISSUED,
        remainingDays: remainingDaysOf(definition),
        usage: [
          {
            type: USAGE_EVENTS.ISSUE,
            at: now,
            toState: ADMISSION_STATES.ISSUED,
          },
        ],
        timeCreated: now,
        timeUpdated: now,
      };
      const units = Math.max(1, Number(item.amount) || 1);
      for (let unitIndex = 0; unitIndex < units; unitIndex++) {
        if (definition.admissionsPerUnit === 1) {
          admissions.push({
            ...base,
            id: uuidv4(),
            key: generateKey(),
            unitIndex,
            memberIndex: 0,
            kind: ADMISSION_KINDS.SINGLE,
          });
          continue;
        }
        const bundleId = uuidv4();
        admissions.push({
          ...base,
          id: bundleId,
          key: generateKey(),
          unitIndex,
          memberIndex: 0,
          kind: ADMISSION_KINDS.BUNDLE,
        });
        for (let member = 1; member <= definition.admissionsPerUnit; member++) {
          admissions.push({
            ...base,
            id: uuidv4(),
            key: generateKey(),
            unitIndex,
            memberIndex: member,
            kind: ADMISSION_KINDS.MEMBER,
            bundleId,
          });
        }
      }
    }

    const issued = await AdmissionManager.insertAdmissions(admissions);
    logger.info(
      { tenantId, bookingId: booking.id, issued, restored },
      "admissions issued",
    );
    return { issued, restored };
  }

  /**
   * Restores the invalidated admissions of a reinstated booking to the
   * state they were invalidated from, as the resets of their facility
   * would have left it: a reset passes over an invalid admission. Each is
   * written on the revision it was read on; one changed in between was
   * restored by a reinstatement running at the same time.
   *
   * @param {string} tenantId
   * @param {string} bookingId
   * @param {Object[]} facilities The facilities of the booking's tariffs
   * @param {number} now
   * @returns {Promise<number>} The number restored
   */
  static async _restoreInvalidated(tenantId, bookingId, facilities, now) {
    const invalid = (
      await AdmissionManager.getAdmissionsByBooking(tenantId, bookingId)
    ).filter((admission) => admission.state === ADMISSION_STATES.INVALID);
    let restored = 0;
    for (const admission of invalid) {
      const facility = facilities.find((f) => f.id === admission.facilityId);
      const { set, toState } = returnOf(
        admission,
        normalizeFacility(facility?.admissionFacility),
        now,
      );
      const written = await AdmissionManager.updateAdmissionIfRevision(
        tenantId,
        admission.id,
        admission.revision,
        set,
        [
          {
            type: USAGE_EVENTS.RESTORE,
            at: now,
            fromState: ADMISSION_STATES.INVALID,
            toState,
            reason: "booking_reinstated",
            userId: null,
            day: null,
            dayConsumed: false,
            deviceId: null,
            runId: null,
          },
        ],
      );
      if (written) {
        restored++;
      }
    }
    return restored;
  }

  /**
   * Sets the admissions of a booking invalid: cancelled, withdrawn
   * or deleted. Nothing is removed - the admissions and their usage log
   * stay the record of what was issued and used.
   *
   * @param {string} tenantId
   * @param {string} bookingId
   * @param {string} reason One of `INVALIDATION_REASONS`
   * @param {{ now?: number, userId?: string|null }} [options]
   * @returns {Promise<{ invalidated: number }>}
   */
  static async invalidateForBooking(
    tenantId,
    bookingId,
    reason,
    { now = Date.now(), userId = null } = {},
  ) {
    const invalidated = await AdmissionManager.invalidateAdmissionsOfBooking(
      tenantId,
      bookingId,
      { at: now, reason, userId },
    );
    logger.info(
      { tenantId, bookingId, invalidated, reason },
      "admissions invalidated",
    );
    return { invalidated };
  }

  /**
   * A correction of the administration, with the account and the
   * reason in the usage log:
   *
   *   block           any live state → `blocked`, the state kept
   *   unblock         `blocked` → the state it was blocked from, as the
   *                   daily resets since would have left it
   *   resetPresence   `present` → `absent` (or `consumed`), a forgotten exit
   *   revertEntry     takes the last entry back: the day it consumed is
   *                   given back, and it is checked out
   *
   * Written on the revision it was decided on: a scan in between is a
   * `409 admission_changed`, and the correction is to be made again.
   *
   * @param {string} tenantId
   * @param {string} id
   * @param {Object} params
   * @param {string} params.action One of `CORRECTIONS`
   * @param {string} params.reason Why, required
   * @param {string} params.userId The account that corrects
   * @param {number} [params.now]
   * @returns {Promise<import("../../entities/admission/admission").Admission>}
   */
  static async correct(
    tenantId,
    id,
    { action, reason, userId, now = Date.now() },
  ) {
    const trimmed = typeof reason === "string" ? reason.trim() : "";
    if (!trimmed) {
      throw new BadRequestError("reason_required");
    }
    const admission = await AdmissionManager.getAdmission(tenantId, id);
    if (!admission) {
      throw new NotFoundError("admission_not_found", { id });
    }
    const facility =
      action === CORRECTIONS.UNBLOCK && admission.facilityId
        ? await facilitySettingsOf(tenantId, admission.facilityId)
        : null;
    const change = correctionOf(admission, action, now, facility);
    const entry = {
      type: change.type,
      at: now,
      fromState: admission.state,
      toState: change.set.state ?? admission.state,
      userId,
      reason: trimmed,
      day: change.day ?? null,
      dayConsumed: false,
      reverts: change.reverts ?? null,
    };
    const written = await AdmissionManager.updateAdmissionIfRevision(
      tenantId,
      id,
      admission.revision,
      change.set,
      [entry],
    );
    if (!written) {
      throw new ConflictError("admission_changed", { id });
    }
    logger.info(
      { tenantId, admissionId: id, action, userId },
      "admission corrected",
    );
    return written;
  }
}

/** The normalized settings of a facility, null where it has none. */
async function facilitySettingsOf(tenantId, facilityId) {
  const [facility] = await BookableManager.getBookablesByIds(
    tenantId,
    [facilityId],
    DOMAIN,
  );
  return normalizeFacility(facility?.admissionFacility);
}

/**
 * What an admission set aside by a block or an invalidation writes when it
 * returns: its `stateBefore`, brought up to the resets due since.
 */
function returnOf(admission, facility, now) {
  const { state, checkedOutAt } = stateAfterResets(
    admission,
    admission.stateBefore || ADMISSION_STATES.ISSUED,
    facility,
    now,
  );
  const set = { state, stateBefore: null };
  if (checkedOutAt !== null) {
    set.lastExitAt = checkedOutAt;
  }
  return { set, toState: state };
}

/**
 * What a correction writes, or the refusal of one that does not apply to
 * the admission as it is.
 */
function correctionOf(admission, action, now, facility = null) {
  const { state } = admission;
  const notApplicable = () =>
    new ConflictError("admission_correction_not_applicable", {
      action,
      state,
    });
  const checkedOut = () =>
    admission.remainingDays === 0
      ? ADMISSION_STATES.CONSUMED
      : ADMISSION_STATES.ABSENT;

  switch (action) {
    case CORRECTIONS.BLOCK:
      if (
        [ADMISSION_STATES.BLOCKED, ADMISSION_STATES.INVALID].includes(state) ||
        admission.kind === ADMISSION_KINDS.BUNDLE
      ) {
        throw notApplicable();
      }
      return {
        type: USAGE_EVENTS.BLOCK,
        set: { state: ADMISSION_STATES.BLOCKED, stateBefore: state },
      };
    case CORRECTIONS.UNBLOCK:
      if (state !== ADMISSION_STATES.BLOCKED) {
        throw notApplicable();
      }
      return {
        type: USAGE_EVENTS.UNBLOCK,
        set: returnOf(admission, facility, now).set,
      };
    case CORRECTIONS.RESET_PRESENCE:
      if (state !== ADMISSION_STATES.PRESENT) {
        throw notApplicable();
      }
      return {
        type: USAGE_EVENTS.CORRECTION,
        set: { state: checkedOut(), lastExitAt: now },
      };
    case CORRECTIONS.REVERT_ENTRY: {
      // The entries not taken back yet, oldest first: a correction names
      // the entry it took back (`reverts`), so none is taken back twice.
      const entries = admission.usage || [];
      const reverted = new Set(
        entries.filter((entry) => entry.reverts).map((entry) => entry.reverts),
      );
      const standing = entries.filter(
        (entry) => entry.type === USAGE_EVENTS.ENTRY && !reverted.has(entry.at),
      );
      const last = standing[standing.length - 1];
      if (
        !last ||
        ![
          ADMISSION_STATES.PRESENT,
          ADMISSION_STATES.ABSENT,
          ADMISSION_STATES.CONSUMED,
        ].includes(state)
      ) {
        throw notApplicable();
      }
      const usedDays = last.dayConsumed
        ? (admission.usedDays || []).filter((day) => day !== last.day)
        : admission.usedDays || [];
      const remainingDays =
        last.dayConsumed && admission.remainingDays !== null
          ? admission.remainingDays + 1
          : admission.remainingDays;
      // The entry before the one taken back is the last one again, so the
      // block time runs from it, as if the reverted scan never happened.
      const previous = standing[standing.length - 2] ?? null;
      return {
        type: USAGE_EVENTS.CORRECTION,
        day: last.day,
        reverts: last.at,
        set: {
          state: previous
            ? remainingDays === 0
              ? ADMISSION_STATES.CONSUMED
              : ADMISSION_STATES.ABSENT
            : ADMISSION_STATES.ISSUED,
          usedDays,
          remainingDays,
          entryCount: Math.max(0, (admission.entryCount || 0) - 1),
          lastEntryAt: previous ? previous.at : null,
        },
      };
    }
    default:
      throw new BadRequestError("admission_correction_unknown", { action });
  }
}

module.exports = {
  AdmissionService,
  INVALIDATION_REASONS,
  CORRECTIONS,
  validityOf,
};
