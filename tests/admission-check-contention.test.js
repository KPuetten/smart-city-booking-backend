/**
 * Two findings of a load test of the check at the entrance:
 *
 * - The look-up of a scan sent again (`getCheckByRequest`) must name the
 *   condition of the partial index on the request id, or the planner does
 *   not use that index and scans the tenant's whole check log.
 * - Many entrances scanning the same admission at once: every scan is
 *   answered (no `admission_check_contended`), and the admission is never
 *   entered twice without an exit in between.
 *
 * The managers in memory, each call taking a moment of its own, so the
 * scans interleave as they do against a database.
 */

const { expect } = require("chai");
const sinon = require("sinon");
const { DateTime } = require("luxon");

const AdmissionManager = require("../src/commons/data-managers/admission-manager");
const AdmissionCheckManager = require("../src/commons/data-managers/admission-check-manager");
const AdmissionCheckModel = require("../src/commons/data-managers/models/admissionCheckModel");
const {
  BookableManager,
} = require("../src/commons/data-managers/bookable-manager");
const {
  AdmissionCheckService,
  MAX_ATTEMPTS,
  retryDelay,
} = require("../src/commons/services/admission/admission-check-service");
const { codeOf } = require("../src/commons/services/admission/admission-code");
const { Admission } = require("../src/commons/entities/admission/admission");
const { ServiceUnavailableError } = require("../src/errors/BaseError");

const TENANT = "tenant-1";
const ZONE = "Europe/Berlin";
const SECRET = "contention-test-secret-0123456789abcdef";
const KEY = "ABCDEFGHJKLMNPQRSTUV";

const FACILITY = {
  id: "freibad",
  tenantId: TENANT,
  amount: 1500,
  admissionFacility: { resetTime: "03:00", timezone: ZONE },
};

/**
 * A database round trip: up to 5 ms, so concurrent scans interleave. With
 * this and three attempts without a wait (the former policy) the
 * test below failed with `admission_check_contended`.
 */
const roundTrip = () =>
  new Promise((resolve) => setTimeout(resolve, Math.random() * 5));

function familyMember() {
  return {
    id: "a-1",
    tenantId: TENANT,
    key: KEY,
    bookingId: "B-1",
    itemIndex: 0,
    unitIndex: 0,
    memberIndex: 0,
    bookableId: "family",
    bookableTitle: "Familienkarte",
    facilityId: "freibad",
    kind: "single",
    state: "issued",
    remainingDays: null,
    usedDays: [],
    entryCount: 0,
    lastEntryAt: null,
    lastExitAt: null,
    usage: [],
    revision: 0,
    entitlement: {
      validFrom: DateTime.now().minus({ days: 10 }).toMillis(),
      validTo: DateTime.now().plus({ days: 100 }).toMillis(),
      usage: "unlimited",
      quota: null,
      blockMinutes: 0,
      personalized: false,
      capacityCheck: "booking",
      timezone: ZONE,
    },
  };
}

function installWorld() {
  const stored = familyMember();
  const writes = [];
  let conflicts = 0;

  sinon
    .stub(BookableManager, "getBookable")
    .callsFake(async (id, tenantId) =>
      id === FACILITY.id && tenantId === TENANT ? FACILITY : null,
    );
  sinon
    .stub(AdmissionManager, "getAdmissionByKey")
    .callsFake(async (tenantId, key) => {
      await roundTrip();
      return tenantId === TENANT && key === KEY
        ? new Admission(JSON.parse(JSON.stringify(stored)))
        : null;
    });
  sinon
    .stub(AdmissionManager, "updateAdmissionIfRevision")
    .callsFake(async (tenantId, id, revision, set, entries) => {
      await roundTrip();
      // Compare and write in one step, as the database does.
      if (stored.revision !== revision) {
        conflicts++;
        return null;
      }
      Object.assign(stored, set, {
        usage: [...stored.usage, ...entries],
        revision: revision + 1,
      });
      writes.push(entries.map((entry) => entry.type));
      return new Admission(JSON.parse(JSON.stringify(stored)));
    });
  sinon.stub(AdmissionManager, "countPresentAdmissions").callsFake(async () => {
    await roundTrip();
    return stored.state === "present" ? 1 : 0;
  });
  sinon.stub(AdmissionCheckManager, "insertCheck").callsFake(async (c) => c);
  sinon.stub(AdmissionCheckManager, "getCheckByRequest").resolves(null);
  sinon.stub(AdmissionCheckManager, "countDeniedChecks").callsFake(async () => {
    await roundTrip();
    return 0;
  });

  // The check log by request id, unique as its index is: the insert of a
  // claim and the refusal of a second one in one step, as the database does.
  const claims = new Map();
  const claimKey = (c) =>
    `${c.tenantId}|${c.deviceId}|${c.userId}|${c.requestId}`;
  sinon.stub(AdmissionCheckManager, "claimCheck").callsFake(async (check) => {
    await roundTrip();
    const existing = claims.get(claimKey(check));
    if (
      existing?.result === "error" &&
      existing.admissionId === check.admissionId &&
      existing.direction === check.direction
    ) {
      // A check that came to no decision is taken over.
      Object.assign(existing, check, { result: "pending", answer: {} });
      return { claimed: { ...existing } };
    }
    if (existing) {
      await roundTrip();
      return { existing: JSON.parse(JSON.stringify(existing)) };
    }
    const row = { ...check, id: `check-${claims.size}`, result: "pending" };
    claims.set(claimKey(check), row);
    return { claimed: { ...row } };
  });
  sinon
    .stub(AdmissionCheckManager, "finishCheck")
    .callsFake(async (id, result) => {
      await roundTrip();
      for (const row of claims.values()) {
        if (row.id === id) Object.assign(row, result);
      }
    });
  sinon.stub(AdmissionCheckManager, "releaseCheck").resolves();

  return { stored, writes, claims, conflicts: () => conflicts };
}

describe("admission check log: look-up by request id", function () {
  it("names the condition of the partial index, so the planner can use it", function () {
    const index = AdmissionCheckModel.schema
      .indexes()
      .find(([fields]) => fields.requestId === 1);
    expect(index, "index on the request id").to.exist;
    const [fields, options] = index;
    expect(options.partialFilterExpression).to.deep.equal({
      requestId: { $type: "string" },
    });
    // Unique per device or person: a request id is claimed only once.
    expect(fields).to.deep.equal({
      tenantId: 1,
      deviceId: 1,
      userId: 1,
      requestId: 1,
    });
    expect(options.unique).to.equal(true);

    const filter = AdmissionCheckManager.requestFilter(
      TENANT,
      { deviceId: "device-1" },
      "scan-0001",
    );
    expect(filter).to.deep.equal({
      tenantId: TENANT,
      requestId: { $eq: "scan-0001", $type: "string" },
      deviceId: "device-1",
      userId: null,
    });
    // Every field of the index is named by an equality of the filter.
    for (const field of Object.keys(fields)) {
      expect(filter).to.have.property(field);
    }
  });

  it("queries with that filter", async function () {
    const lean = sinon.stub().resolves(null);
    const findOne = sinon
      .stub(AdmissionCheckModel, "findOne")
      .returns({ lean });
    try {
      await AdmissionCheckManager.getCheckByRequest(
        TENANT,
        { userId: "staff-1" },
        "scan-0002",
      );
      expect(findOne.firstCall.args[0]).to.deep.equal({
        tenantId: TENANT,
        requestId: { $eq: "scan-0002", $type: "string" },
        deviceId: null,
        userId: "staff-1",
      });
    } finally {
      findOne.restore();
    }
  });
});

describe("admission check log: the claim of a request id", function () {
  afterEach(function () {
    sinon.restore();
  });

  const check = {
    tenantId: TENANT,
    facilityId: "freibad",
    direction: "entry",
    deviceId: "device-1",
    userId: null,
    requestId: "scan-0003",
    admissionId: "a-1",
    at: 2_000_000,
  };

  it("claims by inserting the check as pending", async function () {
    sinon.stub(AdmissionCheckModel, "create").resolves();

    const { claimed } = await AdmissionCheckManager.claimCheck(check, {
      staleMs: 30_000,
    });

    expect(claimed).to.include({
      requestId: "scan-0003",
      admissionId: "a-1",
      result: "pending",
    });
    expect(claimed.id).to.be.a("string");
  });

  it("takes over only an abandoned or failed claim of the same scan, else hands the row back", async function () {
    const duplicate = Object.assign(new Error("E11000"), { code: 11000 });
    sinon.stub(AdmissionCheckModel, "create").rejects(duplicate);
    sinon
      .stub(AdmissionCheckModel, "findOneAndUpdate")
      .returns({ lean: sinon.stub().resolves(null) });
    const twin = { ...check, id: "check-1", result: "pending", at: 1_999_990 };
    sinon
      .stub(AdmissionCheckModel, "findOne")
      .returns({ lean: sinon.stub().resolves(twin) });

    const outcome = await AdmissionCheckManager.claimCheck(check, {
      staleMs: 30_000,
    });

    expect(outcome).to.deep.equal({ existing: twin });
    const [condition] = AdmissionCheckModel.findOneAndUpdate.firstCall.args;
    expect(condition).to.deep.equal({
      tenantId: TENANT,
      requestId: { $eq: "scan-0003", $type: "string" },
      deviceId: "device-1",
      userId: null,
      admissionId: "a-1",
      direction: "entry",
      $or: [
        { result: "pending", at: { $lt: 2_000_000 - 30_000 } },
        { result: "error" },
      ],
    });
  });

  it("keeps a claim out of the device's last checks", async function () {
    const lean = sinon.stub().resolves([]);
    const limit = sinon.stub().returns({ lean });
    const sort = sinon.stub().returns({ limit });
    sinon.stub(AdmissionCheckModel, "find").returns({ sort });

    await AdmissionCheckManager.getRecentChecks(TENANT, "freibad");

    expect(AdmissionCheckModel.find.firstCall.args[0]).to.deep.equal({
      tenantId: TENANT,
      facilityId: "freibad",
      result: { $ne: "pending" },
    });
  });
});

describe("admission check: a scan sent twice at the same moment", function () {
  let saved;

  beforeEach(function () {
    saved = process.env.ADMISSION_CODE_SECRET;
    process.env.ADMISSION_CODE_SECRET = SECRET;
  });

  afterEach(function () {
    sinon.restore();
    if (saved === undefined) delete process.env.ADMISSION_CODE_SECRET;
    else process.env.ADMISSION_CODE_SECRET = saved;
  });

  const scan = (requestId, deviceId = "device-1") =>
    AdmissionCheckService.check({
      tenantId: TENANT,
      facilityId: FACILITY.id,
      code: codeOf(TENANT, KEY),
      direction: "entry",
      actor: { deviceId },
      requestId,
    });

  it("is decided once: the twins wait for the first one's answer", async function () {
    const world = installWorld();

    const answers = await Promise.all(
      Array.from({ length: 10 }, () => scan("scan-0004")),
    );

    expect(world.writes).to.deep.equal([["entry"]]);
    // Every twin gets the first one's answer, none an already_present.
    expect(answers.map((a) => a.result)).to.deep.equal(
      Array(10).fill("granted"),
    );
    expect(answers.filter((a) => a.replayed)).to.have.length(9);
    const [first] = answers.filter((a) => !a.replayed);
    for (const twin of answers.filter((a) => a.replayed)) {
      expect({ ...twin, replayed: undefined }).to.deep.equal({
        ...first,
        replayed: undefined,
      });
    }
    expect(world.claims.size).to.equal(1);
    expect([...world.claims.values()][0]).to.include({
      result: "granted",
      admissionId: "a-1",
    });
  });

  it("keeps the request ids of different devices apart", async function () {
    const world = installWorld();

    const [one, other] = await Promise.all([
      scan("scan-0005", "device-1"),
      scan("scan-0005", "device-2"),
    ]);

    expect([one.result, other.result].sort()).to.deep.equal([
      "denied",
      "granted",
    ]);
    expect(world.claims.size).to.equal(2);
  });

  it("answers 503 with Retry-After where the twin takes too long", async function () {
    installWorld();
    AdmissionCheckManager.claimCheck.callsFake(async (check) => ({
      existing: { ...check, id: "check-0", result: "pending", answer: {} },
    }));
    const clock = sinon.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const pending = scan("scan-0006").catch((err) => err);
      await clock.tickAsync(5000);
      const error = await pending;
      expect(error).to.include({
        code: "admission_request_in_progress",
        statusCode: 503,
      });
      expect(error.params.retryAfterSeconds).to.equal(1);
    } finally {
      clock.restore();
    }
  });

  it("gives the claim up where the check fails, so the scan sent again is decided", async function () {
    const world = installWorld();
    AdmissionManager.countPresentAdmissions.rejects(new Error("database gone"));

    let error;
    try {
      await scan("scan-0007");
    } catch (err) {
      error = err;
    }

    expect(error.message).to.equal("database gone");
    const [claim] = world.claims.values();
    expect(AdmissionCheckManager.releaseCheck.firstCall.args).to.deep.equal([
      claim.id,
    ]);
  });
});

describe("admission check: a check that keeps meeting other writes", function () {
  let saved;

  beforeEach(function () {
    saved = process.env.ADMISSION_CODE_SECRET;
    process.env.ADMISSION_CODE_SECRET = SECRET;
    // No wait between the attempts.
    sinon.stub(Math, "random").returns(0);
  });

  afterEach(function () {
    sinon.restore();
    if (saved === undefined) delete process.env.ADMISSION_CODE_SECRET;
    else process.env.ADMISSION_CODE_SECRET = saved;
  });

  const scan = (requestId = null) =>
    AdmissionCheckService.check({
      tenantId: TENANT,
      facilityId: FACILITY.id,
      code: codeOf(TENANT, KEY),
      direction: "entry",
      actor: { deviceId: "device-1" },
      requestId,
    });

  async function refusal(promise) {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    throw new Error("expected a refusal");
  }

  it("answers 503 with Retry-After after the last attempt, and logs it", async function () {
    installWorld();
    AdmissionManager.updateAdmissionIfRevision.resolves(null);

    const error = await refusal(scan());

    expect(error).to.be.instanceOf(ServiceUnavailableError);
    expect(error).to.include({
      code: "admission_check_contended",
      statusCode: 503,
    });
    expect(error.params).to.deep.equal({ retryAfterSeconds: 1 });
    expect(AdmissionManager.updateAdmissionIfRevision.callCount).to.equal(
      MAX_ATTEMPTS,
    );
    const [logged] = AdmissionCheckManager.insertCheck.firstCall.args;
    expect(logged).to.include({
      tenantId: TENANT,
      facilityId: FACILITY.id,
      deviceId: "device-1",
      admissionId: "a-1",
      result: "error",
      reason: "admission_check_contended",
    });
    expect(logged.answer).to.include({
      result: "error",
      reason: "admission_check_contended",
      message: "Prüfung gerade nicht möglich. Bitte erneut scannen.",
    });
  });

  it("decides the scan sent again with the same request id anew", async function () {
    const world = installWorld();
    AdmissionManager.updateAdmissionIfRevision.resolves(null);

    const error = await refusal(scan("scan-0008"));
    expect(error.code).to.equal("admission_check_contended");
    const [row] = world.claims.values();
    expect(row).to.include({
      result: "error",
      reason: "admission_check_contended",
    });

    // The other devices are gone: the same scan again is decided, not
    // answered with the refusal.
    AdmissionManager.updateAdmissionIfRevision.restore();
    sinon
      .stub(AdmissionManager, "updateAdmissionIfRevision")
      .callsFake(async (tenantId, id, revision, set, entries) => {
        world.stored.revision += 1;
        Object.assign(world.stored, set);
        world.writes.push(entries.map((entry) => entry.type));
        return new Admission(JSON.parse(JSON.stringify(world.stored)));
      });

    const again = await scan("scan-0008");

    expect(again.result).to.equal("granted");
    expect(again.replayed).to.equal(undefined);
    expect(world.writes).to.deep.equal([["entry"]]);
    expect(world.claims.size).to.equal(1);
    expect([...world.claims.values()][0].result).to.equal("granted");
  });
});

describe("admission check: many entrances at the same admission", function () {
  let saved;

  beforeEach(function () {
    saved = process.env.ADMISSION_CODE_SECRET;
    process.env.ADMISSION_CODE_SECRET = SECRET;
  });

  afterEach(function () {
    sinon.restore();
    if (saved === undefined) delete process.env.ADMISSION_CODE_SECRET;
    else process.env.ADMISSION_CODE_SECRET = saved;
  });

  const scan = (direction, client) =>
    AdmissionCheckService.check({
      tenantId: TENANT,
      facilityId: FACILITY.id,
      code: codeOf(TENANT, KEY),
      direction,
      actor: { deviceId: `device-${client}` },
    });

  it("waits a random time below a doubling bound before each new attempt", function () {
    const random = sinon.stub(Math, "random").returns(0.999999);
    try {
      const bounds = [];
      for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
        bounds.push(retryDelay(attempt));
      }
      expect(bounds.slice(0, 5)).to.deep.equal([5, 10, 20, 40, 50]);
      expect(Math.max(...bounds)).to.equal(50);
      expect(bounds.reduce((a, b) => a + b, 0)).to.be.below(1100);
      random.returns(0);
      expect(retryDelay(4)).to.equal(0);
    } finally {
      random.restore();
    }
  });

  it("answers 50 entrances scanning at once, one entry granted", async function () {
    const world = installWorld();
    const answers = await Promise.allSettled(
      Array.from({ length: 50 }, (_, client) => scan("entry", client)),
    );

    const failed = answers.filter((a) => a.status === "rejected");
    expect(failed.map((a) => a.reason.message)).to.deep.equal([]);
    const results = answers.map((a) => a.value);
    expect(results.filter((r) => r.result === "granted")).to.have.length(1);
    expect(
      results.filter((r) => r.reason === "already_present"),
    ).to.have.length(49);
    expect(world.writes).to.deep.equal([["entry"]]);
  });

  it("answers 50 entrances scanning entries and exits at once, without a double entry", async function () {
    this.timeout(20000);
    const world = installWorld();
    // Each client scans in and out five times; all 50 at the same time.
    const client = async (n) => {
      const answers = [];
      for (let i = 0; i < 10; i++) {
        answers.push(await scan(i % 2 === 0 ? "entry" : "exit", n));
      }
      return answers;
    };
    const settled = await Promise.allSettled(
      Array.from({ length: 50 }, (_, n) => client(n)),
    );

    const failed = settled.filter((s) => s.status === "rejected");
    expect(failed.map((s) => s.reason.message)).to.deep.equal([]);
    expect(world.conflicts()).to.be.above(0);

    // The usage log alternates: never two entries without an exit between.
    const sequence = world.writes.flat();
    expect(sequence).to.not.be.empty;
    sequence.forEach((type, i) =>
      expect(type, `write ${i}`).to.equal(i % 2 === 0 ? "entry" : "exit"),
    );
    const granted = settled
      .flatMap((s) => s.value)
      .filter((answer) => answer.result !== "denied");
    expect(granted).to.have.length(sequence.length);
    expect(world.stored.revision).to.equal(sequence.length);
  });
});
