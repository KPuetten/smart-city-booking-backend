const os = require("os");
const { DateTime } = require("luxon");
const bunyan = require("bunyan");

const AdmissionManager = require("../../data-managers/admission-manager");
const AdmissionResetRunManager = require("../../data-managers/admission-reset-run-manager");
const { BookableManager } = require("../../data-managers/bookable-manager");
const { DOMAIN } = require("../authorization/reach");
const {
  normalizeFacility,
} = require("../../entities/admission/admission-definition");
const {
  RESET_RUN_STATUS,
  RESET_RUN_TRIGGERS,
} = require("../../schemas/admissionResetRunSchema");
const { ADMISSION_STATES } = require("../../schemas/admissionSchema");

const logger = bunyan.createLogger({
  name: "admission-reset-service.js",
  level: process.env.LOG_LEVEL,
});

const MINUTE = 60 * 1000;

/** A run found later than this after its due time counts as made up. */
const CATCH_UP_AFTER_MS = 5 * MINUTE;

/** A running run whose owner is silent this long may be taken over. */
const STALE_RUN_MS = 15 * MINUTE;

const HOUR = 60 * MINUTE;

/**
 * Two resets of one facility closer than this are one operating day: the
 * days of a facility are 23 to 25 hours apart, so only a changed reset
 * time brings two due times this close.
 */
const SAME_DAY_MS = 20 * HOUR;

/**
 * A due time that a changed reset time put before the change is made up
 * all the same where skipping it would leave more than this between two
 * resets.
 */
const MAX_RESET_GAP_MS = 36 * HOUR;

/** Who runs: host and process, for the record of a run. */
const OWNER = `${os.hostname()}:${process.pid}`;

/**
 * The reset time of a facility on the day of `day`. Where the clock is set
 * back and the time comes twice (02:30 on the last Sunday of October in
 * Berlin), the first one counts, so every day has one due time; where it
 * is set forward past the time, the time after the gap.
 *
 * @param {Object} settings Normalized facility settings
 * @param {DateTime} day Any time of the day, in the facility's time zone
 * @returns {DateTime}
 */
function resetTimeOn(settings, day) {
  const [hour, minute] = settings.resetTime.split(":").map(Number);
  const at = day.set({ hour, minute, second: 0, millisecond: 0 });
  const setBack = at.minus({ hours: 3 }).offset - at.offset;
  if (setBack > 0) {
    const first = at.minus({ minutes: setBack });
    if (first.hour === hour && first.minute === minute) {
      return first;
    }
  }
  return at;
}

/**
 * The latest time the reset of a facility was due at or before `now`: today
 * at its reset time in its time zone, or yesterday's where today's has not
 * come yet. Daylight saving moves the hour with the clock of the facility.
 *
 * @param {Object} settings Normalized facility settings
 * @param {number} now Epoch ms
 * @returns {number} Epoch ms
 */
function dueTimeOf(settings, now) {
  const day = DateTime.fromMillis(now, { zone: settings.timezone });
  const today = resetTimeOn(settings, day);
  return (
    today.toMillis() <= now
      ? today
      : resetTimeOn(settings, day.minus({ days: 1 }))
  ).toMillis();
}

/** The due time of a facility's reset the day after `dueAt`. */
function nextDueTimeOf(settings, dueAt) {
  const day = DateTime.fromMillis(dueAt, { zone: settings.timezone });
  return resetTimeOn(settings, day.plus({ days: 1 })).toMillis();
}

/**
 * The state an admission returns to from a block or an invalidation, as
 * the daily reset would have left it. The reset passes over a blocked or
 * invalid admission, so the state it was set aside in may be one the reset
 * has changed since: a presence from before the latest due reset is
 * checked out (`absent`, or `consumed` without a day left), and an
 * admission whose validity ended before that reset expires. Without
 * settings of its facility no reset runs for it, and the state stays.
 *
 * @param {Object} admission With `lastEntryAt`, `remainingDays` and
 *   `entitlement.validTo`
 * @param {string} state The state it returns to, its `stateBefore`
 * @param {Object|null} settings Normalized settings of its facility
 * @param {number} now Epoch ms
 * @returns {{ state: string, checkedOutAt: number|null }} The state, and
 *   the due time of the reset that checked it out, if one did
 */
function stateAfterResets(admission, state, settings, now) {
  if (!settings) {
    return { state, checkedOutAt: null };
  }
  const dueAt = dueTimeOf(settings, now);
  let next = state;
  let checkedOutAt = null;
  if (
    next === ADMISSION_STATES.PRESENT &&
    (admission.lastEntryAt ?? -Infinity) < dueAt
  ) {
    next =
      admission.remainingDays === 0
        ? ADMISSION_STATES.CONSUMED
        : ADMISSION_STATES.ABSENT;
    checkedOutAt = dueAt;
  }
  if (
    [
      ADMISSION_STATES.ISSUED,
      ADMISSION_STATES.ABSENT,
      ADMISSION_STATES.CONSUMED,
    ].includes(next) &&
    admission.entitlement?.validTo < dueAt
  ) {
    next = ADMISSION_STATES.EXPIRED;
  }
  return { state: next, checkedOutAt };
}

/**
 * The daily reset: at the reset time of each facility every open
 * presence is checked out and every admission past its validity expires.
 * It cannot be switched off.
 *
 * `runDue` asks, for every facility, whether its latest due reset has run,
 * and runs it where not. Called once a minute by the job and once at the
 * start, it makes up a reset missed while no process ran - only the latest
 * one: an older one has nothing to add, the latest checks out every
 * presence from before its time. The run is claimed in MongoDB first
 * (`AdmissionResetRunManager.claimRun`), so of several processes only one
 * runs it; the run row is the record that it happened.
 *
 * One reset per operating day: a due time is not run where a reset of a
 * later due time ran, nor where the reset time was changed to an hour
 * already past on a day whose reset had run (`isRescheduledPast`) - the
 * changed time counts from its next due time on.
 */
class AdmissionResetService {
  /**
   * @param {{ now?: number, owner?: string }} [options]
   * @returns {Promise<Object[]>} The runs this call made
   */
  static async runDue({ now = Date.now(), owner = OWNER } = {}) {
    const facilities = await BookableManager.getAdmissionFacilities(
      null,
      DOMAIN,
    );
    const runs = [];
    for (const facility of facilities) {
      const settings = normalizeFacility(facility.admissionFacility);
      if (!settings) {
        continue;
      }
      try {
        const run = await AdmissionResetService.runFacility(
          facility,
          settings,
          { now, owner },
        );
        if (run) {
          runs.push(run);
        }
      } catch (err) {
        // One facility that fails keeps no other from its reset.
        logger.error(
          { err, tenantId: facility.tenantId, facilityId: facility.id },
          "admission reset failed",
        );
      }
    }
    return runs;
  }

  /**
   * Runs the latest due reset of one facility, unless it ran or another
   * process holds it.
   *
   * @param {Object} facility The facility bookable
   * @param {Object} settings Its normalized settings
   * @param {{ now: number, owner: string }} options
   * @returns {Promise<Object|null>} The finished run, null where nothing ran
   */
  static async runFacility(facility, settings, { now, owner }) {
    const tenantId = facility.tenantId;
    const facilityId = facility.id;
    const dueAt = dueTimeOf(settings, now);

    const existing = await AdmissionResetRunManager.getRun(
      tenantId,
      facilityId,
      dueAt,
    );
    if (existing?.status === RESET_RUN_STATUS.DONE) {
      return null;
    }
    const last = await AdmissionResetRunManager.getLastDoneRun(
      tenantId,
      facilityId,
    );
    if (
      last &&
      (last.dueAt > dueAt || isRescheduledPast(facility, settings, dueAt, last))
    ) {
      return null;
    }

    const trigger =
      now - dueAt > CATCH_UP_AFTER_MS
        ? RESET_RUN_TRIGGERS.CATCH_UP
        : RESET_RUN_TRIGGERS.SCHEDULE;
    const run = await AdmissionResetRunManager.claimRun({
      tenantId,
      facilityId,
      dueAt,
      trigger,
      owner,
      now,
      staleMs: STALE_RUN_MS,
    });
    if (!run) {
      return null;
    }

    try {
      const entry = { at: now, runId: run.id, enteredBefore: dueAt };
      const resetCount = await AdmissionManager.resetPresentAdmissions(
        tenantId,
        facilityId,
        entry,
      );
      const expiredCount = await AdmissionManager.expireAdmissions(
        tenantId,
        facilityId,
        entry,
      );
      const result = {
        status: RESET_RUN_STATUS.DONE,
        finishedAt: Date.now(),
        resetCount,
        expiredCount,
      };
      await AdmissionResetRunManager.finishRun(run.id, result);
      logger.info(
        { tenantId, facilityId, dueAt, trigger, resetCount, expiredCount },
        "admission reset done",
      );
      return { ...run, ...result };
    } catch (err) {
      await AdmissionResetRunManager.finishRun(run.id, {
        status: RESET_RUN_STATUS.FAILED,
        finishedAt: Date.now(),
        error: err.message,
      });
      throw err;
    }
  }
}

/**
 * Whether a due time is one a changed reset time put before the change, on
 * a day whose reset had run: the schedule of the reset was changed after it
 * (`admissionFacility.scheduleChangedAt`, stamped on the write; not the
 * bookable's `timeUpdated`, which the entity sets when it is built), a reset
 * ran less than `SAME_DAY_MS` before it, and the next due time comes
 * within `MAX_RESET_GAP_MS` of that reset. A reset at 03:00 that ran, and
 * the time changed at 14:00 to 10:00: today's 10:00 is not made up, the
 * next reset is tomorrow at 10:00.
 *
 * @param {Object} facility The facility bookable, with `timeUpdated`
 * @param {Object} settings Its normalized settings
 * @param {number} dueAt The due time in question
 * @param {Object} last The facility's latest finished run
 * @returns {boolean}
 */
function isRescheduledPast(facility, settings, dueAt, last) {
  const changedAt = Number(facility.admissionFacility?.scheduleChangedAt);
  return (
    Number.isFinite(changedAt) &&
    changedAt > dueAt &&
    dueAt - last.dueAt < SAME_DAY_MS &&
    nextDueTimeOf(settings, dueAt) - last.dueAt <= MAX_RESET_GAP_MS
  );
}

module.exports = { AdmissionResetService, dueTimeOf, stateAfterResets };
