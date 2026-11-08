/**
 * The admission decision: the six steps in their fixed order,
 * every refusal by its step, the re-entry on the same day, the days of use
 * of a quota, the block time, the capacity of the facility, and the state
 * each granted entry and exit writes. Pure: no stubs, no database.
 */

const { expect } = require("chai");
const { DateTime } = require("luxon");

const {
  decideEntry,
  decideExit,
  isPresent,
} = require("../src/commons/services/admission/admission-decision");
const {
  CHECK_RESULTS,
  DENIAL_REASONS,
  NOTICES,
} = require("../src/commons/services/admission/admission-reasons");
const {
  CODE_STATUS,
} = require("../src/commons/services/admission/admission-code");
const {
  ADMISSION_STATES,
  USAGE_EVENTS,
} = require("../src/commons/schemas/admissionSchema");

const ZONE = "Europe/Berlin";
const MINUTE = 60 * 1000;
const at = (iso) => DateTime.fromISO(iso, { zone: ZONE }).toMillis();

const NOW = at("2027-07-01T10:00");
const FACILITY = "freibad";

/** An admission of a season ticket, never used, valid at NOW. */
function admission(overrides = {}) {
  const { entitlement, ...rest } = overrides;
  return {
    id: "a-1",
    facilityId: FACILITY,
    kind: "single",
    state: ADMISSION_STATES.ISSUED,
    remainingDays: null,
    usedDays: [],
    entryCount: 0,
    lastEntryAt: null,
    lastExitAt: null,
    revision: 0,
    entitlement: {
      validFrom: at("2027-05-01T00:00"),
      validTo: at("2027-09-15T23:59:59"),
      usage: "unlimited",
      quota: null,
      blockMinutes: 0,
      personalized: false,
      capacityCheck: "booking",
      timezone: ZONE,
      ...entitlement,
    },
    ...rest,
  };
}

const settings = (overrides = {}) => ({
  resetTime: "03:00",
  exitScan: true,
  maxStayMinutes: null,
  timezone: ZONE,
  ...overrides,
});

function entry(a, overrides = {}) {
  return decideEntry({
    integrity: CODE_STATUS.OK,
    admission: a,
    facilityId: FACILITY,
    facility: settings(),
    now: NOW,
    actor: { deviceId: "device-1" },
    ...overrides,
  });
}

function exit(a, overrides = {}) {
  return decideExit({
    integrity: CODE_STATUS.OK,
    admission: a,
    facilityId: FACILITY,
    facility: settings(),
    now: NOW,
    actor: { deviceId: "device-1" },
    ...overrides,
  });
}

/** An admission as the granted decision leaves it. */
function after(a, decision) {
  return { ...a, ...decision.effect.set, usage: decision.effect.entries };
}

describe("admission decision: the entry, step by step", function () {
  describe("step 1: the code is an admission's, unaltered, of this facility", function () {
    it("refuses a malformed code", function () {
      const d = entry(null, { integrity: CODE_STATUS.MALFORMED });
      expect(d).to.include({
        result: CHECK_RESULTS.DENIED,
        step: 1,
        reason: DENIAL_REASONS.CODE_MALFORMED,
        effect: null,
      });
      expect(d.message).to.match(/Kein Ticketcode erkannt/);
    });

    it("refuses a forged code before anything is looked up", function () {
      const d = entry(admission(), { integrity: CODE_STATUS.FORGED });
      expect(d).to.include({ step: 1, reason: DENIAL_REASONS.CODE_FORGED });
    });

    it("refuses a code no admission carries", function () {
      expect(entry(null).reason).to.equal(DENIAL_REASONS.ADMISSION_UNKNOWN);
    });

    it("refuses an admission of another facility", function () {
      const d = entry(admission({ facilityId: "hallenbad" }));
      expect(d).to.include({ step: 1, reason: DENIAL_REASONS.WRONG_FACILITY });
    });

    it("refuses the parent ticket of a bundle: its members are scanned", function () {
      const d = entry(admission({ kind: "bundle" }));
      expect(d).to.include({ step: 1, reason: DENIAL_REASONS.BUNDLE_CODE });
    });
  });

  describe("step 2: the admission is valid", function () {
    it("refuses an invalid admission (booking cancelled)", function () {
      const d = entry(admission({ state: ADMISSION_STATES.INVALID }));
      expect(d).to.include({
        step: 2,
        reason: DENIAL_REASONS.ADMISSION_INVALID,
      });
    });

    it("refuses a blocked admission", function () {
      const d = entry(admission({ state: ADMISSION_STATES.BLOCKED }));
      expect(d).to.include({
        step: 2,
        reason: DENIAL_REASONS.ADMISSION_BLOCKED,
      });
    });

    it("refuses before the validity and names its start", function () {
      const d = entry(admission(), { now: at("2027-04-30T18:00") });
      expect(d).to.include({ step: 2, reason: DENIAL_REASONS.NOT_YET_VALID });
      expect(d.message).to.equal("Noch nicht gültig, gültig ab 01.05.2027.");
    });

    it("refuses after the validity and names its end", function () {
      const d = entry(admission(), { now: at("2027-09-16T09:00") });
      expect(d).to.include({ step: 2, reason: DENIAL_REASONS.EXPIRED });
      expect(d.message).to.equal("Abgelaufen, gültig war es bis 15.09.2027.");
    });

    it("refuses an admission the reset has moved to expired", function () {
      const d = entry(admission({ state: ADMISSION_STATES.EXPIRED }));
      expect(d.reason).to.equal(DENIAL_REASONS.EXPIRED);
    });

    it("checks validity before usage: a blocked, used-up card is reported blocked", function () {
      const d = entry(
        admission({
          state: ADMISSION_STATES.BLOCKED,
          remainingDays: 0,
          entitlement: { usage: "quota", quota: 10 },
        }),
      );
      expect(d.reason).to.equal(DENIAL_REASONS.ADMISSION_BLOCKED);
    });
  });

  describe("step 3: the usage allows an entry", function () {
    const single = (overrides = {}) =>
      admission({
        remainingDays: 1,
        entitlement: { usage: "single" },
        ...overrides,
      });
    const quota = (overrides = {}) =>
      admission({
        remainingDays: 10,
        entitlement: { usage: "quota", quota: 10 },
        ...overrides,
      });

    it("grants a single ticket its day and consumes it", function () {
      const d = entry(single());
      expect(d.result).to.equal(CHECK_RESULTS.GRANTED);
      expect(d.effect.set).to.include({ remainingDays: 0, entryCount: 1 });
      expect(d.effect.set.usedDays).to.deep.equal(["2027-07-01"]);
    });

    it("refuses a single ticket used on another day", function () {
      const d = entry(
        single({
          state: ADMISSION_STATES.CONSUMED,
          remainingDays: 0,
          usedDays: ["2027-06-30"],
          entryCount: 1,
          lastEntryAt: at("2027-06-30T11:00"),
        }),
      );
      expect(d).to.include({ step: 3, reason: DENIAL_REASONS.ALREADY_USED });
      expect(d.message).to.equal(
        "Bereits genutzt (Einzeleintritt am 30.06.2027).",
      );
    });

    it("lets a single ticket in again on its day, after an exit, consuming nothing", function () {
      const d = entry(
        single({
          state: ADMISSION_STATES.CONSUMED,
          remainingDays: 0,
          usedDays: ["2027-07-01"],
          entryCount: 1,
          lastEntryAt: at("2027-07-01T08:00"),
        }),
      );
      expect(d.result).to.equal(CHECK_RESULTS.GRANTED_WITH_NOTICE);
      expect(d.notices.map((n) => n.code)).to.deep.equal([NOTICES.REENTRY]);
      expect(d.effect.set).to.include({ remainingDays: 0, entryCount: 2 });
      expect(d.effect.entries[0]).to.include({ dayConsumed: false });
    });

    it("counts a quota by days: the first entry of a day takes one", function () {
      const d = entry(quota());
      expect(d.result).to.equal(CHECK_RESULTS.GRANTED);
      expect(d.effect.set.remainingDays).to.equal(9);
      expect(d.effect.entries[0]).to.include({
        type: USAGE_EVENTS.ENTRY,
        day: "2027-07-01",
        dayConsumed: true,
      });
    });

    it("counts a quota by days: a re-entry on the same day takes none", function () {
      const d = entry(
        quota({
          state: ADMISSION_STATES.ABSENT,
          remainingDays: 9,
          usedDays: ["2027-07-01"],
          entryCount: 1,
          lastEntryAt: at("2027-07-01T08:00"),
        }),
      );
      expect(d.effect.set.remainingDays).to.equal(9);
      expect(d.notices.map((n) => n.code)).to.include(NOTICES.REENTRY);
    });

    it("counts the day by the facility's calendar, not by 24 hours", function () {
      const d = entry(
        quota({
          state: ADMISSION_STATES.ABSENT,
          remainingDays: 9,
          usedDays: ["2027-06-30"],
          lastEntryAt: at("2027-06-30T23:30"),
        }),
        { now: at("2027-07-01T00:10") },
      );
      expect(d.effect.set.remainingDays).to.equal(8);
    });

    it("points to the last day of a quota", function () {
      const d = entry(quota({ remainingDays: 1, usedDays: ["2027-06-01"] }));
      expect(d.effect.set.remainingDays).to.equal(0);
      expect(d.notices.map((n) => n.code)).to.deep.equal([NOTICES.LAST_DAY]);
    });

    it("refuses a quota with no day left", function () {
      const d = entry(
        quota({
          state: ADMISSION_STATES.CONSUMED,
          remainingDays: 0,
          usedDays: ["2027-06-29"],
        }),
      );
      expect(d).to.include({ step: 3, reason: DENIAL_REASONS.QUOTA_EXHAUSTED });
    });

    it("lets a used-up quota in again on the day it was used up", function () {
      const d = entry(
        quota({
          state: ADMISSION_STATES.CONSUMED,
          remainingDays: 0,
          usedDays: ["2027-07-01"],
        }),
      );
      expect(d.result).to.equal(CHECK_RESULTS.GRANTED_WITH_NOTICE);
      expect(d.effect.set.remainingDays).to.equal(0);
    });

    it("never counts an unlimited ticket down, but records the day", function () {
      const d = entry(admission());
      expect(d.effect.set.remainingDays).to.equal(null);
      expect(d.effect.set.usedDays).to.deep.equal(["2027-07-01"]);
    });
  });

  describe("step 4: checked out, or an entry without an exit", function () {
    const present = (overrides = {}) =>
      admission({
        state: ADMISSION_STATES.PRESENT,
        usedDays: ["2027-07-01"],
        entryCount: 1,
        lastEntryAt: at("2027-07-01T09:00"),
        ...overrides,
      });

    it("refuses a second entry without an exit", function () {
      const d = entry(present());
      expect(d).to.include({ step: 4, reason: DENIAL_REASONS.ALREADY_PRESENT });
      expect(d.message).to.equal(
        "Bereits eingecheckt, seitdem kein Austritt erfasst.",
      );
    });

    it("lets it in once the stay limit has passed, recording the automatic exit", function () {
      const d = entry(present(), {
        facility: settings({ maxStayMinutes: 30 }),
      });
      expect(d.result).to.equal(CHECK_RESULTS.GRANTED_WITH_NOTICE);
      expect(d.effect.entries.map((e) => e.type)).to.deep.equal([
        USAGE_EVENTS.AUTO_EXIT,
        USAGE_EVENTS.ENTRY,
      ]);
      expect(d.effect.entries[0].at).to.equal(at("2027-07-01T09:30"));
      expect(d.notices.map((n) => n.code)).to.include(
        NOTICES.STAY_LIMIT_PASSED,
      );
    });

    it("does not ask for an exit where the facility scans none", function () {
      const d = entry(present(), { facility: settings({ exitScan: false }) });
      expect(d.result).to.equal(CHECK_RESULTS.GRANTED_WITH_NOTICE);
      expect(d.notices.map((n) => n.code)).to.deep.equal([NOTICES.REENTRY]);
    });
  });

  describe("step 5: the block time since the last entry", function () {
    const blocked = (overrides = {}) =>
      admission({
        state: ADMISSION_STATES.ABSENT,
        usedDays: ["2027-07-01"],
        entryCount: 1,
        lastEntryAt: at("2027-07-01T08:00"),
        lastExitAt: at("2027-07-01T08:30"),
        entitlement: { blockMinutes: 180 },
        ...overrides,
      });

    it("refuses a new entry within the block time, after an exit too, and names its end", function () {
      const d = entry(blocked());
      expect(d).to.include({ step: 5, reason: DENIAL_REASONS.BLOCK_TIME });
      expect(d.message).to.equal(
        "Sperrzeit läuft, erneuter Eintritt ab 11:00 Uhr.",
      );
    });

    it("grants once the block time has passed", function () {
      const d = entry(blocked(), { now: at("2027-07-01T11:00") });
      expect(d.result).to.equal(CHECK_RESULTS.GRANTED_WITH_NOTICE);
    });

    it("checks presence before the block time: a card inside is reported present", function () {
      const d = entry(blocked({ state: ADMISSION_STATES.PRESENT }));
      expect(d.reason).to.equal(DENIAL_REASONS.ALREADY_PRESENT);
    });
  });

  describe("step 6: the capacity of the facility, where the tariff checks it", function () {
    const atEntry = admission({ entitlement: { capacityCheck: "entry" } });

    it("refuses when the facility is full and names the count", function () {
      const d = entry(atEntry, { capacity: 2, presentCount: 2 });
      expect(d).to.include({
        step: 6,
        reason: DENIAL_REASONS.CAPACITY_REACHED,
      });
      expect(d.message).to.equal(
        "Einrichtung voll: 2 von 2 Berechtigungen eingecheckt.",
      );
    });

    it("grants below the capacity", function () {
      expect(entry(atEntry, { capacity: 3, presentCount: 2 }).result).to.equal(
        CHECK_RESULTS.GRANTED,
      );
    });

    it("ignores the capacity where the tariff checks at the booking or never", function () {
      for (const capacityCheck of ["booking", "none"]) {
        const d = entry(admission({ entitlement: { capacityCheck } }), {
          capacity: 1,
          presentCount: 5,
        });
        expect(d.result, capacityCheck).to.equal(CHECK_RESULTS.GRANTED);
      }
    });

    it("does not count an admission against itself", function () {
      const d = entry(
        admission({
          state: ADMISSION_STATES.PRESENT,
          lastEntryAt: at("2027-07-01T09:00"),
          usedDays: ["2027-07-01"],
          entitlement: { capacityCheck: "entry" },
        }),
        {
          capacity: 1,
          presentCount: 1,
          facility: settings({ exitScan: false }),
        },
      );
      expect(d.result).to.equal(CHECK_RESULTS.GRANTED_WITH_NOTICE);
    });
  });

  describe("the granted entry", function () {
    it("writes the state, the counters and the usage log with the device", function () {
      const d = entry(admission());
      expect(d.effect.set).to.deep.equal({
        state: ADMISSION_STATES.PRESENT,
        lastEntryAt: NOW,
        entryCount: 1,
        usedDays: ["2027-07-01"],
        remainingDays: null,
      });
      expect(d.effect.entries).to.deep.equal([
        {
          type: USAGE_EVENTS.ENTRY,
          at: NOW,
          day: "2027-07-01",
          dayConsumed: true,
          fromState: ADMISSION_STATES.ISSUED,
          toState: ADMISSION_STATES.PRESENT,
          deviceId: "device-1",
          userId: null,
        },
      ]);
    });

    it("points to the photo of a personal ticket and to recent refusals", function () {
      const d = entry(admission({ entitlement: { personalized: true } }), {
        recentDenials: 3,
      });
      expect(d.notices).to.deep.equal([
        {
          code: NOTICES.RECENT_DENIALS,
          message:
            "3 abgewiesene Versuche mit diesem Ticket in der letzten Stunde.",
        },
        {
          code: NOTICES.CHECK_PHOTO,
          message: "Personengebundenes Ticket: Lichtbild prüfen.",
        },
      ]);
    });

    it("writes nothing on a refusal", function () {
      for (const a of [
        admission({ state: ADMISSION_STATES.BLOCKED }),
        admission({ state: ADMISSION_STATES.INVALID }),
      ]) {
        expect(entry(a).effect).to.equal(null);
      }
    });
  });
});

describe("admission decision: the exit", function () {
  const present = (overrides = {}) =>
    admission({
      state: ADMISSION_STATES.PRESENT,
      usedDays: ["2027-07-01"],
      entryCount: 1,
      lastEntryAt: at("2027-07-01T09:00"),
      ...overrides,
    });

  it("checks a present admission out to absent", function () {
    const d = exit(present());
    expect(d.result).to.equal(CHECK_RESULTS.GRANTED);
    expect(d.message).to.equal("Austritt erfasst.");
    expect(d.effect.set).to.deep.equal({
      state: ADMISSION_STATES.ABSENT,
      lastExitAt: NOW,
    });
    expect(d.effect.entries[0]).to.include({ type: USAGE_EVENTS.EXIT });
  });

  it("checks an admission without days left out to consumed", function () {
    const d = exit(present({ remainingDays: 0 }));
    expect(d.effect.set.state).to.equal(ADMISSION_STATES.CONSUMED);
  });

  it("refuses an exit of an admission not checked in", function () {
    const d = exit(admission({ state: ADMISSION_STATES.ABSENT }));
    expect(d).to.include({ reason: DENIAL_REASONS.NOT_PRESENT, effect: null });
  });

  it("refuses an exit where the facility scans none", function () {
    const d = exit(present(), { facility: settings({ exitScan: false }) });
    expect(d.reason).to.equal(DENIAL_REASONS.EXIT_DISABLED);
  });

  it("runs step 1 for the exit too", function () {
    expect(exit(null, { integrity: CODE_STATUS.FORGED }).reason).to.equal(
      DENIAL_REASONS.CODE_FORGED,
    );
  });

  it("follows one admission through a day: in, out, in again, refused in again", function () {
    let a = admission({
      remainingDays: 10,
      entitlement: { usage: "quota", quota: 10 },
    });
    a = after(a, entry(a));
    expect(a).to.include({ state: ADMISSION_STATES.PRESENT, remainingDays: 9 });
    expect(entry(a, { now: NOW + MINUTE }).reason).to.equal(
      DENIAL_REASONS.ALREADY_PRESENT,
    );
    a = after(a, exit(a, { now: NOW + 60 * MINUTE }));
    expect(a.state).to.equal(ADMISSION_STATES.ABSENT);
    const again = entry(a, { now: NOW + 90 * MINUTE });
    expect(again.notices.map((n) => n.code)).to.deep.equal([NOTICES.REENTRY]);
    a = after(a, again);
    expect(a).to.include({ state: ADMISSION_STATES.PRESENT, remainingDays: 9 });
  });
});

describe("admission decision: isPresent", function () {
  it("is false for every state but present, and past the stay limit", function () {
    for (const state of Object.values(ADMISSION_STATES)) {
      const a = admission({ state, lastEntryAt: NOW - 10 * MINUTE });
      expect(isPresent(a, settings(), NOW), state).to.equal(
        state === ADMISSION_STATES.PRESENT,
      );
    }
    const a = admission({
      state: ADMISSION_STATES.PRESENT,
      lastEntryAt: NOW - 10 * MINUTE,
    });
    expect(isPresent(a, settings({ maxStayMinutes: 5 }), NOW)).to.equal(false);
  });
});
