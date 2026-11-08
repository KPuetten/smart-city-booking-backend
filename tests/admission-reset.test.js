/**
 * The daily reset: due at the reset time of each facility in its
 * time zone, made up after a downtime (only the latest one, and only for
 * guests who came in before its time), held by a lock in MongoDB so that
 * of several processes one runs it, recorded run by run, and started with
 * the backend whatever the rule engine says.
 */

const { expect } = require("chai");
const sinon = require("sinon");
const { DateTime } = require("luxon");

const AdmissionManager = require("../src/commons/data-managers/admission-manager");
const AdmissionResetRunManager = require("../src/commons/data-managers/admission-reset-run-manager");
const AdmissionResetRunModel = require("../src/commons/data-managers/models/admissionResetRunModel");
const {
  BookableManager,
} = require("../src/commons/data-managers/bookable-manager");
const {
  AdmissionResetService,
  dueTimeOf,
} = require("../src/commons/services/admission/admission-reset-service");
const AdmissionResetJob = require("../src/commons/services/admission/admission-reset-job");

const ZONE = "Europe/Berlin";
const at = (iso) => DateTime.fromISO(iso, { zone: ZONE }).toMillis();
const settings = (overrides = {}) => ({
  resetTime: "03:00",
  exitScan: true,
  maxStayMinutes: null,
  timezone: ZONE,
  ...overrides,
});

function facility(id, admissionFacility = {}, tenantId = "tenant-1") {
  return {
    id,
    tenantId,
    admissionFacility: {
      resetTime: "03:00",
      timezone: ZONE,
      ...admissionFacility,
    },
  };
}

describe("admission reset: when it is due", function () {
  it("is today's reset time once it has passed, yesterday's before", function () {
    expect(dueTimeOf(settings(), at("2027-07-01T10:00"))).to.equal(
      at("2027-07-01T03:00"),
    );
    expect(dueTimeOf(settings(), at("2027-07-01T02:59"))).to.equal(
      at("2027-06-30T03:00"),
    );
    expect(dueTimeOf(settings(), at("2027-07-01T03:00"))).to.equal(
      at("2027-07-01T03:00"),
    );
  });

  it("follows the clock of the facility over a change of daylight saving time", function () {
    // 31.10.2027: CEST ends at 03:00, the reset at 04:00 local time is 03:00 UTC.
    const due = dueTimeOf(
      settings({ resetTime: "04:00" }),
      at("2027-10-31T12:00"),
    );
    expect(new Date(due).toISOString()).to.equal("2027-10-31T03:00:00.000Z");
    const summer = dueTimeOf(
      settings({ resetTime: "04:00" }),
      at("2027-10-30T12:00"),
    );
    expect(new Date(summer).toISOString()).to.equal("2027-10-30T02:00:00.000Z");
  });

  it("is due once on the night the clock is set back, at the first of the two times", function () {
    // 31.10.2027: 03:00 CEST becomes 02:00 CET, so 02:30 comes twice -
    // at 00:30 UTC (CEST) and at 01:30 UTC (CET).
    const night = settings({ resetTime: "02:30" });
    const first = Date.parse("2027-10-31T00:30:00Z");
    for (const now of [
      "2027-10-31T00:31:00Z", // 02:31 CEST
      "2027-10-31T01:10:00Z", // 02:10 CET, the hour again
      "2027-10-31T01:31:00Z", // 02:31 CET
      "2027-10-31T12:00:00Z",
    ]) {
      expect(dueTimeOf(night, Date.parse(now)), now).to.equal(first);
    }
    expect(dueTimeOf(night, Date.parse("2027-11-01T01:31:00Z"))).to.equal(
      Date.parse("2027-11-01T01:30:00Z"),
    );
  });

  it("is due after the gap where the clock is set forward past it", function () {
    // 28.03.2027: 02:00 CET becomes 03:00 CEST, 02:30 does not exist.
    const due = dueTimeOf(
      settings({ resetTime: "02:30" }),
      at("2027-03-28T12:00"),
    );
    expect(new Date(due).toISOString()).to.equal("2027-03-28T01:30:00.000Z");
  });
});

describe("admission reset: the run", function () {
  let runs;

  beforeEach(function () {
    runs = new Map();
    sinon
      .stub(BookableManager, "getAdmissionFacilities")
      .resolves([
        facility("freibad"),
        facility("hallenbad", { resetTime: "22:00" }),
      ]);
    sinon
      .stub(AdmissionResetRunManager, "getRun")
      .callsFake(
        async (tenantId, facilityId, dueAt) =>
          runs.get(`${facilityId}@${dueAt}`) ?? null,
      );
    sinon
      .stub(AdmissionResetRunManager, "claimRun")
      .callsFake(async (claim) => {
        const key = `${claim.facilityId}@${claim.dueAt}`;
        if (runs.has(key) && runs.get(key).status !== "failed") return null;
        const run = { id: `run-${key}`, ...claim, status: "running" };
        runs.set(key, run);
        return run;
      });
    sinon
      .stub(AdmissionResetRunManager, "getLastDoneRun")
      .callsFake(async (tenantId, facilityId) => {
        const done = [...runs.values()].filter(
          (run) => run.facilityId === facilityId && run.status === "done",
        );
        return done.sort((a, b) => b.dueAt - a.dueAt)[0] ?? null;
      });
    sinon
      .stub(AdmissionResetRunManager, "finishRun")
      .callsFake(async (id, result) => {
        for (const run of runs.values()) {
          if (run.id === id) Object.assign(run, result);
        }
      });
    sinon.stub(AdmissionManager, "resetPresentAdmissions").resolves(12);
    sinon.stub(AdmissionManager, "expireAdmissions").resolves(3);
  });

  afterEach(function () {
    sinon.restore();
  });

  it("runs the reset of each facility at its own time, once", async function () {
    const now = at("2027-07-01T03:00:30");

    const made = await AdmissionResetService.runDue({ now, owner: "test" });

    expect(made.map((r) => [r.facilityId, r.dueAt, r.trigger])).to.deep.equal([
      ["freibad", at("2027-07-01T03:00"), "schedule"],
      // The pool's reset at 22:00 was due yesterday and had not run.
      ["hallenbad", at("2027-06-30T22:00"), "catchUp"],
    ]);
    expect(made[0]).to.include({
      status: "done",
      resetCount: 12,
      expiredCount: 3,
    });

    const again = await AdmissionResetService.runDue({
      now: now + 60000,
      owner: "test",
    });
    expect(again).to.deep.equal([]);
    expect(AdmissionManager.resetPresentAdmissions.callCount).to.equal(2);
  });

  it("checks out only who entered before the reset was due", async function () {
    const now = at("2027-07-01T09:00");
    await AdmissionResetService.runDue({ now, owner: "test" });

    const [tenantId, facilityId, entry] =
      AdmissionManager.resetPresentAdmissions.firstCall.args;
    expect([tenantId, facilityId]).to.deep.equal(["tenant-1", "freibad"]);
    expect(entry).to.include({
      at: now,
      enteredBefore: at("2027-07-01T03:00"),
    });
    expect(entry.runId).to.equal(`run-freibad@${at("2027-07-01T03:00")}`);
  });

  it("makes up after a downtime only the latest reset missed, marked as made up", async function () {
    // Down from 30.06. 20:00 to 03.07. 11:00: three resets of the pool missed.
    const made = await AdmissionResetService.runDue({
      now: at("2027-07-03T11:00"),
      owner: "test",
    });

    const pool = made.find((r) => r.facilityId === "freibad");
    expect(pool).to.include({
      dueAt: at("2027-07-03T03:00"),
      trigger: "catchUp",
    });
    expect(made.filter((r) => r.facilityId === "freibad")).to.have.length(1);
  });

  it("does nothing where another process holds the run", async function () {
    AdmissionResetRunManager.claimRun.resolves(null);

    const made = await AdmissionResetService.runDue({
      now: at("2027-07-01T03:00:30"),
      owner: "test",
    });

    expect(made).to.deep.equal([]);
    expect(AdmissionManager.resetPresentAdmissions.called).to.equal(false);
  });

  it("records a failed run, keeps the other facilities going, and runs it again next time", async function () {
    AdmissionManager.resetPresentAdmissions
      .onFirstCall()
      .rejects(new Error("database gone"));
    const now = at("2027-07-01T03:00:30");

    const made = await AdmissionResetService.runDue({ now, owner: "test" });

    expect(made.map((r) => r.facilityId)).to.deep.equal(["hallenbad"]);
    expect(runs.get(`freibad@${at("2027-07-01T03:00")}`)).to.include({
      status: "failed",
      error: "database gone",
    });

    const retried = await AdmissionResetService.runDue({
      now: now + 60000,
      owner: "test",
    });
    expect(retried.map((r) => [r.facilityId, r.status])).to.deep.equal([
      ["freibad", "done"],
    ]);
  });
});

describe("admission reset: one reset per operating day", function () {
  let runs;

  beforeEach(function () {
    runs = new Map();
    sinon.stub(BookableManager, "getAdmissionFacilities").resolves([]);
    sinon
      .stub(AdmissionResetRunManager, "getRun")
      .callsFake(
        async (tenantId, facilityId, dueAt) =>
          runs.get(`${facilityId}@${dueAt}`) ?? null,
      );
    sinon
      .stub(AdmissionResetRunManager, "getLastDoneRun")
      .callsFake(async (tenantId, facilityId) => {
        const done = [...runs.values()].filter(
          (run) => run.facilityId === facilityId && run.status === "done",
        );
        return done.sort((a, b) => b.dueAt - a.dueAt)[0] ?? null;
      });
    sinon
      .stub(AdmissionResetRunManager, "claimRun")
      .callsFake(async (claim) => {
        const key = `${claim.facilityId}@${claim.dueAt}`;
        if (runs.has(key)) return null;
        const run = { id: `run-${key}`, ...claim, status: "running" };
        runs.set(key, run);
        return run;
      });
    sinon
      .stub(AdmissionResetRunManager, "finishRun")
      .callsFake(async (id, result) => {
        for (const run of runs.values()) {
          if (run.id === id) Object.assign(run, result);
        }
      });
    sinon.stub(AdmissionManager, "resetPresentAdmissions").resolves(0);
    sinon.stub(AdmissionManager, "expireAdmissions").resolves(0);
  });

  afterEach(function () {
    sinon.restore();
  });

  /**
   * The pool as it is stored: its reset time, its schedule changed at
   * `changedAt`. Its `timeUpdated` is the time the entity was built - every
   * read builds it anew, so it lies after every due time: no sign of a
   * change.
   */
  function pool(resetTime, changedAt = at("2027-01-01T00:00")) {
    BookableManager.getAdmissionFacilities.resolves([
      {
        ...facility("freibad", { resetTime, scheduleChangedAt: changedAt }),
        timeUpdated: at("2030-01-01T00:00"),
      },
    ]);
  }

  const look = (iso) =>
    AdmissionResetService.runDue({
      now: iso.endsWith("Z") ? Date.parse(iso) : at(iso),
      owner: "test",
    });
  const dues = (made) => made.map((run) => run.dueAt);

  it("runs once on the night the clock is set back", async function () {
    pool("02:30");

    const first = await look("2027-10-31T00:31:00Z"); // 02:31 CEST
    const again = await look("2027-10-31T01:31:00Z"); // 02:31 CET

    expect(dues(first)).to.deep.equal([Date.parse("2027-10-31T00:30:00Z")]);
    expect(again).to.deep.equal([]);
    expect(AdmissionManager.resetPresentAdmissions.callCount).to.equal(1);
  });

  it("does not make up a reset time changed to an hour already past", async function () {
    pool("03:00");
    expect(dues(await look("2027-07-01T03:00:30"))).to.deep.equal([
      at("2027-07-01T03:00"),
    ]);

    // At 14:00 the reset time becomes 10:00: today's reset had run.
    pool("10:00", at("2027-07-01T14:00"));
    expect(await look("2027-07-01T14:01")).to.deep.equal([]);
    expect(await look("2027-07-02T09:59")).to.deep.equal([]);
    expect(dues(await look("2027-07-02T10:00:30"))).to.deep.equal([
      at("2027-07-02T10:00"),
    ]);
  });

  it("does not make up a reset time changed to an earlier hour either", async function () {
    pool("10:00");
    await look("2027-07-01T10:00:30");

    pool("03:00", at("2027-07-01T14:00"));
    expect(await look("2027-07-01T14:01")).to.deep.equal([]);
    expect(dues(await look("2027-07-02T03:00:30"))).to.deep.equal([
      at("2027-07-02T03:00"),
    ]);
  });

  it("runs a reset time changed to a later hour of the day at that hour", async function () {
    pool("03:00");
    await look("2027-07-01T03:00:30");

    pool("10:00", at("2027-07-01T09:00"));
    expect(await look("2027-07-01T09:01")).to.deep.equal([]);
    expect(dues(await look("2027-07-01T10:00:30"))).to.deep.equal([
      at("2027-07-01T10:00"),
    ]);
  });

  it("makes up a changed reset time where skipping it would leave more than 36 hours", async function () {
    pool("03:00");
    await look("2027-07-01T03:00:30");

    // 20:00 tomorrow would be 41 hours after today's 03:00.
    pool("20:00", at("2027-07-01T22:00"));
    expect(dues(await look("2027-07-01T22:01"))).to.deep.equal([
      at("2027-07-01T20:00"),
    ]);
  });

  it("makes up a missed day as before, the facility changed or not", async function () {
    pool("03:00");
    await look("2027-07-01T03:00:30");

    // Down from 02.07. 01:00 to 11:00, the pool edited at 10:00.
    pool("03:00", at("2027-07-02T10:00"));
    expect(dues(await look("2027-07-02T11:00"))).to.deep.equal([
      at("2027-07-02T03:00"),
    ]);
  });
});

describe("admission reset: the lock in MongoDB", function () {
  afterEach(function () {
    sinon.restore();
  });

  const claim = {
    tenantId: "tenant-1",
    facilityId: "freibad",
    dueAt: 1000,
    trigger: "schedule",
    owner: "host:1",
    now: 2_000_000,
    staleMs: 900_000,
  };

  it("claims a run by inserting it", async function () {
    sinon.stub(AdmissionResetRunModel, "create").resolves();
    const run = await AdmissionResetRunManager.claimRun(claim);
    expect(run).to.include({
      facilityId: "freibad",
      dueAt: 1000,
      status: "running",
    });
  });

  it("takes over only a failed or abandoned run when the insert meets one", async function () {
    const duplicate = Object.assign(new Error("E11000"), { code: 11000 });
    sinon.stub(AdmissionResetRunModel, "create").rejects(duplicate);
    const lean = sinon.stub().resolves(null);
    sinon.stub(AdmissionResetRunModel, "findOneAndUpdate").returns({ lean });

    const run = await AdmissionResetRunManager.claimRun(claim);

    expect(run).to.equal(null);
    const [condition] = AdmissionResetRunModel.findOneAndUpdate.firstCall.args;
    expect(condition).to.deep.equal({
      tenantId: "tenant-1",
      facilityId: "freibad",
      dueAt: 1000,
      $or: [
        { status: "failed" },
        { status: "running", startedAt: { $lt: 2_000_000 - 900_000 } },
      ],
    });
  });
});

describe("admission reset: the job", function () {
  afterEach(function () {
    AdmissionResetJob.stop();
    sinon.restore();
  });

  it("looks at once when it starts, so a missed reset is made up right away", async function () {
    sinon.stub(AdmissionResetService, "runDue").resolves([]);

    await AdmissionResetJob.start();
    await AdmissionResetJob.start();

    expect(AdmissionResetService.runDue.callCount).to.equal(1);
  });

  it("runs no second look while one is still running", async function () {
    let release;
    sinon
      .stub(AdmissionResetService, "runDue")
      .returns(new Promise((resolve) => (release = resolve)));

    const first = AdmissionResetJob.tick();
    await AdmissionResetJob.tick();
    release([]);
    await first;

    expect(AdmissionResetService.runDue.callCount).to.equal(1);
  });
});
