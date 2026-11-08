/**
 * The issuance of admissions and the corrections of the
 * administration, over stubbed managers.
 */

const { expect } = require("chai");
const sinon = require("sinon");
const { DateTime } = require("luxon");

const AdmissionManager = require("../src/commons/data-managers/admission-manager");
const {
  BookableManager,
} = require("../src/commons/data-managers/bookable-manager");
const {
  AdmissionService,
  CORRECTIONS,
} = require("../src/commons/services/admission/admission-service");
const { Admission } = require("../src/commons/entities/admission/admission");
const AdmissionModel = require("../src/commons/data-managers/models/admissionModel");

const TENANT = "tenant-1";
const ZONE = "Europe/Berlin";
const at = (iso) => DateTime.fromISO(iso, { zone: ZONE }).toMillis();
const NOW = at("2026-11-01T12:00");

const FACILITY = {
  id: "freibad",
  tenantId: TENANT,
  // The facility lists its tariffs as children (the hierarchy).
  relatedBookableIds: ["season", "ten", "day", "family"],
  type: "event-location",
  amount: 1500,
  admissionFacility: { resetTime: "03:00", timezone: ZONE },
};

function tariff(id, admission, overrides = {}) {
  return {
    id,
    type: "ticket",
    title: id,
    admission,
    ...overrides,
  };
}

function booking(items, overrides = {}) {
  return {
    id: "B-1",
    tenantId: TENANT,
    timeBegin: at("2026-11-02T00:00"),
    timeEnd: at("2026-11-02T23:59"),
    bookableItems: items.map(([snapshot, amount = 1]) => ({
      bookableId: snapshot.id,
      amount,
      _bookableUsed: snapshot,
    })),
    ...overrides,
  };
}

describe("AdmissionService.issueForBooking", function () {
  let inserted;

  beforeEach(function () {
    inserted = null;
    sinon.stub(AdmissionManager, "getAdmissionsByBooking").resolves([]);
    sinon
      .stub(BookableManager, "getAdmissionFacilitiesOf")
      .resolves([FACILITY]);
    sinon
      .stub(AdmissionManager, "insertAdmissions")
      .callsFake(async (admissions) => {
        inserted = admissions;
        return admissions.length;
      });
  });

  afterEach(function () {
    sinon.restore();
  });

  it("issues nothing and loads nothing for a booking without such a tariff", async function () {
    const result = await AdmissionService.issueForBooking(
      TENANT,
      booking([[{ id: "room", type: "room" }]]),
      { now: NOW },
    );
    expect(result).to.deep.equal({ issued: 0, restored: 0 });
    expect(AdmissionManager.insertAdmissions.called).to.equal(false);
    expect(BookableManager.getAdmissionFacilitiesOf.called).to.equal(false);
  });

  it("copies a season window as whole days of the facility's time zone", async function () {
    const season = tariff("season", {
      validity: { mode: "window", from: "2027-05-01", to: "2027-09-15" },
      usage: { mode: "unlimited" },
      blockMinutes: 180,
    });

    await AdmissionService.issueForBooking(TENANT, booking([[season]]), {
      now: NOW,
    });

    expect(inserted).to.have.length(1);
    const [admission] = inserted;
    expect(admission).to.include({
      tenantId: TENANT,
      bookingId: "B-1",
      itemIndex: 0,
      unitIndex: 0,
      memberIndex: 0,
      bookableId: "season",
      facilityId: "freibad",
      kind: "single",
      state: "issued",
      remainingDays: null,
    });
    expect(admission.entitlement).to.deep.equal({
      validFrom: at("2027-05-01T00:00"),
      validTo: DateTime.fromISO("2027-09-15", { zone: ZONE })
        .endOf("day")
        .toMillis(),
      usage: "unlimited",
      quota: null,
      blockMinutes: 180,
      personalized: false,
      capacityCheck: "booking",
      timezone: ZONE,
    });
    expect(admission.key).to.match(/^[0-9A-X]{20}$/);
    expect(admission.usage).to.deep.equal([
      { type: "issue", at: NOW, toState: "issued" },
    ]);
  });

  it("counts a quota and a duration from the issuance", async function () {
    const tenVisits = tariff("ten", {
      validity: { mode: "duration", days: 365 },
      usage: { mode: "quota", quota: 10 },
    });

    await AdmissionService.issueForBooking(TENANT, booking([[tenVisits]]), {
      now: NOW,
    });

    expect(inserted[0].remainingDays).to.equal(10);
    expect(inserted[0].entitlement).to.include({
      validFrom: NOW,
      validTo: DateTime.fromISO("2027-10-31", { zone: ZONE })
        .endOf("day")
        .toMillis(),
      usage: "quota",
      quota: 10,
    });
  });

  it("takes the period of the booking for a day ticket", async function () {
    const day = tariff("day", {
      validity: { mode: "booking" },
      usage: { mode: "single" },
    });

    await AdmissionService.issueForBooking(TENANT, booking([[day, 2]]), {
      now: NOW,
    });

    expect(inserted.map((a) => [a.unitIndex, a.remainingDays])).to.deep.equal([
      [0, 1],
      [1, 1],
    ]);
    expect(inserted[0].entitlement).to.include({
      validFrom: at("2026-11-02T00:00"),
      validTo: at("2026-11-02T23:59"),
    });
  });

  it("resolves a family ticket into a parent ticket and one admission per person", async function () {
    const family = tariff("family", {
      validity: { mode: "window", from: "2027-05-01", to: "2027-09-15" },
      usage: { mode: "unlimited" },
      admissionsPerUnit: 4,
    });

    await AdmissionService.issueForBooking(TENANT, booking([[family, 2]]), {
      now: NOW,
    });

    expect(inserted).to.have.length(10);
    const bundles = inserted.filter((a) => a.kind === "bundle");
    expect(bundles).to.have.length(2);
    for (const bundle of bundles) {
      const members = inserted.filter((a) => a.bundleId === bundle.id);
      expect(members.map((a) => a.memberIndex)).to.deep.equal([1, 2, 3, 4]);
      expect(members.every((a) => a.kind === "member")).to.equal(true);
      expect(members.every((a) => a.unitIndex === bundle.unitIndex)).to.equal(
        true,
      );
    }
    expect(new Set(inserted.map((a) => a.key)).size).to.equal(10);
  });

  it("issues without a facility where the tariff has none, in the default time zone", async function () {
    BookableManager.getAdmissionFacilitiesOf.resolves([]);
    const lonely = tariff("lonely", { usage: { mode: "single" } });

    await AdmissionService.issueForBooking(TENANT, booking([[lonely]]), {
      now: NOW,
    });

    expect(inserted[0].facilityId).to.equal(null);
    expect(inserted[0].entitlement.timezone).to.equal(ZONE);
  });

  it("restores invalidated admissions first: a reinstatement keeps their codes", async function () {
    const restored = [];
    AdmissionManager.getAdmissionsByBooking.resolves([
      new Admission({
        id: "a-1",
        facilityId: "freibad",
        state: "invalid",
        stateBefore: "absent",
        revision: 4,
        entitlement: { validTo: at("2027-09-15T23:59") },
      }),
      new Admission({ id: "a-2", facilityId: "freibad", state: "issued" }),
    ]);
    sinon
      .stub(AdmissionManager, "updateAdmissionIfRevision")
      .callsFake(async (tenantId, id, revision, set, entries) => {
        restored.push({ id, revision, set, entries });
        return new Admission({ id, ...set });
      });
    AdmissionManager.insertAdmissions.resolves(0);
    const season = tariff("season", { usage: { mode: "unlimited" } });

    const result = await AdmissionService.issueForBooking(
      TENANT,
      booking([[season]]),
      { now: NOW },
    );

    expect(result).to.deep.equal({ issued: 0, restored: 1 });
    expect(
      AdmissionManager.getAdmissionsByBooking.firstCall.args,
    ).to.deep.equal([TENANT, "B-1"]);
    expect(restored).to.deep.equal([
      {
        id: "a-1",
        revision: 4,
        set: { state: "absent", stateBefore: null },
        entries: [
          {
            type: "restore",
            at: NOW,
            fromState: "invalid",
            toState: "absent",
            reason: "booking_reinstated",
            userId: null,
            day: null,
            dayConsumed: false,
            deviceId: null,
            runId: null,
          },
        ],
      },
    ]);
  });

  it("restores as the resets since the cancellation would have left them", async function () {
    // Today's reset at 03:00 passed over the invalid admissions.
    const season = at("2027-09-15T23:59");
    const yesterday = at("2026-10-31T10:00");
    const ended = at("2026-10-31T23:59");
    const invalid = (id, fields, validTo = season) =>
      new Admission({
        id,
        facilityId: "freibad",
        state: "invalid",
        revision: 1,
        entitlement: { validTo },
        ...fields,
      });
    AdmissionManager.getAdmissionsByBooking.resolves([
      // Entered yesterday, never checked out: the reset checks it out.
      invalid("yesterday", {
        stateBefore: "present",
        lastEntryAt: yesterday,
        remainingDays: 3,
      }),
      // The same with no day left.
      invalid("used-up", {
        stateBefore: "present",
        lastEntryAt: yesterday,
        remainingDays: 0,
      }),
      // Entered after today's reset: still present.
      invalid("today", {
        stateBefore: "present",
        lastEntryAt: at("2026-11-01T10:00"),
      }),
      // Valid until yesterday: the reset expired it.
      invalid("ended", { stateBefore: "absent" }, ended),
      invalid(
        "ended-present",
        { stateBefore: "present", lastEntryAt: yesterday },
        ended,
      ),
    ]);
    const restored = {};
    sinon
      .stub(AdmissionManager, "updateAdmissionIfRevision")
      .callsFake(async (tenantId, id, revision, set, entries) => {
        restored[id] = { set, toState: entries[0].toState };
        return new Admission({ id, ...set });
      });

    await AdmissionService.issueForBooking(
      TENANT,
      booking([[tariff("season", { usage: { mode: "unlimited" } })]]),
      { now: NOW },
    );

    const reset = at("2026-11-01T03:00");
    expect(restored).to.deep.equal({
      yesterday: {
        set: { state: "absent", stateBefore: null, lastExitAt: reset },
        toState: "absent",
      },
      "used-up": {
        set: { state: "consumed", stateBefore: null, lastExitAt: reset },
        toState: "consumed",
      },
      today: {
        set: { state: "present", stateBefore: null },
        toState: "present",
      },
      ended: {
        set: { state: "expired", stateBefore: null },
        toState: "expired",
      },
      "ended-present": {
        set: { state: "expired", stateBefore: null, lastExitAt: reset },
        toState: "expired",
      },
    });
  });

  it("restores the state as it was where no facility runs a reset", async function () {
    BookableManager.getAdmissionFacilitiesOf.resolves([]);
    AdmissionManager.getAdmissionsByBooking.resolves([
      new Admission({
        id: "a-1",
        facilityId: null,
        state: "invalid",
        stateBefore: "present",
        lastEntryAt: at("2026-10-20T10:00"),
        revision: 1,
        entitlement: { validTo: at("2027-09-15T23:59") },
      }),
    ]);
    sinon
      .stub(AdmissionManager, "updateAdmissionIfRevision")
      .callsFake(async (tenantId, id, revision, set) => new Admission(set));

    await AdmissionService.issueForBooking(
      TENANT,
      booking([[tariff("season", { usage: { mode: "unlimited" } })]]),
      { now: NOW },
    );

    expect(
      AdmissionManager.updateAdmissionIfRevision.firstCall.args[3],
    ).to.deep.equal({ state: "present", stateBefore: null });
  });
});

describe("AdmissionService.invalidateForBooking", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("hands the reason and the account to the manager, removing nothing", async function () {
    sinon.stub(AdmissionManager, "invalidateAdmissionsOfBooking").resolves(3);

    const result = await AdmissionService.invalidateForBooking(
      TENANT,
      "B-1",
      "booking_cancelled",
      { now: NOW, userId: "admin" },
    );

    expect(result).to.deep.equal({ invalidated: 3 });
    expect(
      AdmissionManager.invalidateAdmissionsOfBooking.firstCall.args,
    ).to.deep.equal([
      TENANT,
      "B-1",
      { at: NOW, reason: "booking_cancelled", userId: "admin" },
    ]);
  });
});

describe("AdmissionService.correct", function () {
  let written;

  function stubbed(fields) {
    const admission = new Admission({
      id: "a-1",
      tenantId: TENANT,
      kind: "single",
      revision: 7,
      remainingDays: null,
      usedDays: [],
      usage: [],
      entryCount: 0,
      ...fields,
    });
    sinon.stub(AdmissionManager, "getAdmission").resolves(admission);
    sinon
      .stub(AdmissionManager, "updateAdmissionIfRevision")
      .callsFake(async (tenantId, id, revision, set, entries) => {
        written = { revision, set, entries };
        return new Admission({ ...admission, ...set });
      });
  }

  const correct = (action, reason = "Fehlbedienung am Eingang") =>
    AdmissionService.correct(TENANT, "a-1", {
      action,
      reason,
      userId: "staff-1",
      now: NOW,
    });

  afterEach(function () {
    sinon.restore();
    written = null;
  });

  it("refuses a correction without a reason", async function () {
    stubbed({ state: "present" });
    let error;
    try {
      await correct(CORRECTIONS.RESET_PRESENCE, "  ");
    } catch (err) {
      error = err;
    }
    expect(error).to.include({ code: "reason_required", statusCode: 400 });
  });

  it("blocks and keeps the state to unblock to, logging account and reason", async function () {
    stubbed({ state: "absent" });

    await correct(CORRECTIONS.BLOCK);

    expect(written.revision).to.equal(7);
    expect(written.set).to.deep.equal({
      state: "blocked",
      stateBefore: "absent",
    });
    expect(written.entries).to.deep.equal([
      {
        type: "block",
        at: NOW,
        fromState: "absent",
        toState: "blocked",
        userId: "staff-1",
        reason: "Fehlbedienung am Eingang",
        day: null,
        dayConsumed: false,
        reverts: null,
      },
    ]);
  });

  it("unblocks to the state it was blocked from", async function () {
    stubbed({
      state: "blocked",
      stateBefore: "present",
      facilityId: "freibad",
      lastEntryAt: at("2026-11-01T10:00"),
    });
    sinon.stub(BookableManager, "getBookablesByIds").resolves([FACILITY]);

    await correct(CORRECTIONS.UNBLOCK);

    expect(written.set).to.deep.equal({ state: "present", stateBefore: null });
    expect(
      BookableManager.getBookablesByIds.firstCall.args.slice(0, 2),
    ).to.deep.equal([TENANT, ["freibad"]]);
  });

  it("unblocks a presence the reset passed over as checked out", async function () {
    // Blocked while present yesterday; today's reset at 03:00 skipped it.
    stubbed({
      state: "blocked",
      stateBefore: "present",
      facilityId: "freibad",
      lastEntryAt: at("2026-10-31T10:00"),
      remainingDays: 2,
      entitlement: { validTo: at("2027-09-15T23:59") },
    });
    sinon.stub(BookableManager, "getBookablesByIds").resolves([FACILITY]);

    await correct(CORRECTIONS.UNBLOCK);

    expect(written.set).to.deep.equal({
      state: "absent",
      stateBefore: null,
      lastExitAt: at("2026-11-01T03:00"),
    });
    expect(written.entries[0]).to.include({
      type: "unblock",
      fromState: "blocked",
      toState: "absent",
    });
  });

  it("unblocks an admission whose validity ended before the reset as expired", async function () {
    stubbed({
      state: "blocked",
      stateBefore: "absent",
      facilityId: "freibad",
      entitlement: { validTo: at("2026-10-31T23:59") },
    });
    sinon.stub(BookableManager, "getBookablesByIds").resolves([FACILITY]);

    await correct(CORRECTIONS.UNBLOCK);

    expect(written.set).to.deep.equal({ state: "expired", stateBefore: null });
  });

  it("resets a presence to absent, or to consumed without days left", async function () {
    stubbed({ state: "present", remainingDays: 0 });
    await correct(CORRECTIONS.RESET_PRESENCE);
    expect(written.set).to.deep.equal({ state: "consumed", lastExitAt: NOW });
  });

  it("takes the last entry back and gives its day of use back", async function () {
    const first = at("2026-10-30T10:00");
    const second = at("2026-11-01T10:00");
    stubbed({
      state: "present",
      remainingDays: 8,
      usedDays: ["2026-10-30", "2026-11-01"],
      entryCount: 2,
      lastEntryAt: second,
      usage: [
        { type: "entry", at: first, day: "2026-10-30", dayConsumed: true },
        { type: "exit", at: first + 3600000 },
        { type: "entry", at: second, day: "2026-11-01", dayConsumed: true },
      ],
    });

    await correct(CORRECTIONS.REVERT_ENTRY);

    expect(written.set).to.deep.equal({
      state: "absent",
      usedDays: ["2026-10-30"],
      remainingDays: 9,
      entryCount: 1,
      lastEntryAt: first,
    });
    expect(written.entries[0]).to.include({
      type: "correction",
      day: "2026-11-01",
      reverts: second,
    });
  });

  it("never takes the same entry back twice", async function () {
    const only = at("2026-11-01T10:00");
    stubbed({
      state: "absent",
      usage: [
        { type: "entry", at: only, day: "2026-11-01", dayConsumed: true },
        { type: "correction", at: only + 1000, reverts: only },
      ],
    });
    let error;
    try {
      await correct(CORRECTIONS.REVERT_ENTRY);
    } catch (err) {
      error = err;
    }
    expect(error).to.include({
      code: "admission_correction_not_applicable",
      statusCode: 409,
    });
  });

  it("refuses to block an invalid admission or a bundle's parent ticket", async function () {
    for (const fields of [
      { state: "invalid" },
      { state: "issued", kind: "bundle" },
    ]) {
      stubbed(fields);
      let error;
      try {
        await correct(CORRECTIONS.BLOCK);
      } catch (err) {
        error = err;
      }
      expect(error?.code).to.equal("admission_correction_not_applicable");
      sinon.restore();
    }
  });

  it("answers 409 where a scan wrote the admission in between", async function () {
    stubbed({ state: "present" });
    AdmissionManager.updateAdmissionIfRevision.resolves(null);
    let error;
    try {
      await correct(CORRECTIONS.RESET_PRESENCE);
    } catch (err) {
      error = err;
    }
    expect(error).to.include({ code: "admission_changed", statusCode: 409 });
  });
});

describe("Admission model", function () {
  it("hands its times out as numbers, which the decision computes with", function () {
    const doc = new AdmissionModel({
      id: "a-1",
      tenantId: TENANT,
      key: "ABCDEFGHJKLMNPQRSTUV",
      bookingId: "B-1",
      itemIndex: 0,
      unitIndex: 0,
      bookableId: "season",
      entitlement: {
        validFrom: NOW,
        validTo: NOW + 1000,
        usage: "unlimited",
        timezone: ZONE,
      },
      lastEntryAt: NOW,
      usage: [{ type: "entry", at: NOW }],
    });
    const admission = doc.toEntity();
    for (const value of [
      admission.entitlement.validFrom,
      admission.entitlement.validTo,
      admission.lastEntryAt,
      admission.usage[0].at,
      admission.timeCreated,
    ]) {
      expect(value).to.be.a("number");
    }
  });
});
