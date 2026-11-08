/**
 * The device API of the entrance over the real router and
 * controller, the managers in memory: the token of a device authenticates
 * it at its tenant and binds it to its facility; a blocked, renewed,
 * foreign or made-up token is refused; the rate limit answers 429; a check
 * is logged whatever its answer, and only a granted one writes the
 * admission; a scan sent twice with the same request id has one effect.
 */

const { expect } = require("chai");
const sinon = require("sinon");
const express = require("express");
const request = require("supertest");
const { DateTime } = require("luxon");

const AdmissionManager = require("../src/commons/data-managers/admission-manager");
const AdmissionCheckManager = require("../src/commons/data-managers/admission-check-manager");
const AdmissionDeviceManager = require("../src/commons/data-managers/admission-device-manager");
const {
  BookableManager,
} = require("../src/commons/data-managers/bookable-manager");
const RateLimiter = require("../src/commons/services/rate-limit/rate-limiter");
const {
  AdmissionDeviceService,
} = require("../src/commons/services/admission/admission-device-service");
const {
  codeOf,
  formatCode,
} = require("../src/commons/services/admission/admission-code");
const { Admission } = require("../src/commons/entities/admission/admission");
const { errorHandler } = require("../src/middleware/error-handler");

const TENANT = "tenant-1";
const OTHER_TENANT = "tenant-2";
const SECRET = "device-api-test-secret-0123456789abcdef";
const ZONE = "Europe/Berlin";

const FACILITIES = {
  freibad: {
    id: "freibad",
    tenantId: TENANT,
    amount: 1500,
    admissionFacility: { resetTime: "03:00", timezone: ZONE },
  },
  hallenbad: {
    id: "hallenbad",
    tenantId: TENANT,
    amount: 300,
    admissionFacility: { resetTime: "03:00", timezone: ZONE },
  },
  fremdbad: {
    id: "fremdbad",
    tenantId: OTHER_TENANT,
    amount: 100,
    admissionFacility: { resetTime: "03:00", timezone: ZONE },
  },
};

function app() {
  const server = express();
  server.use(express.json());
  server.use(
    "/api/:tenant/admission",
    require("../src/platform/api/routes/admission.routes"),
  );
  server.use(errorHandler);
  return server;
}

/** An in-memory world behind the managers. */
function installWorld() {
  const devices = new Map();
  const admissions = new Map();
  const checks = [];
  const writes = [];

  const strip = (device) => {
    if (!device) return null;
    // eslint-disable-next-line no-unused-vars
    const { tokenHash, ...rest } = device;
    return { ...rest };
  };

  sinon.stub(AdmissionDeviceManager, "createDevice").callsFake(async (d) => {
    devices.set(`${d.tenantId}/${d.id}`, { ...d });
    return { ...d };
  });
  sinon
    .stub(AdmissionDeviceManager, "getDeviceForAuthentication")
    .callsFake(async (tenantId, id) => {
      const device = devices.get(`${tenantId}/${id}`);
      return device ? { ...device } : null;
    });
  sinon
    .stub(AdmissionDeviceManager, "getDevice")
    .callsFake(async (tenantId, id) => strip(devices.get(`${tenantId}/${id}`)));
  sinon
    .stub(AdmissionDeviceManager, "updateDevice")
    .callsFake(async (tenantId, id, set) => {
      const device = devices.get(`${tenantId}/${id}`);
      if (!device) return null;
      Object.assign(device, set);
      return strip(device);
    });
  sinon.stub(AdmissionDeviceManager, "touchDevice").resolves();

  sinon
    .stub(BookableManager, "getBookable")
    .callsFake(async (id, tenantId) =>
      FACILITIES[id]?.tenantId === tenantId ? FACILITIES[id] : null,
    );

  sinon
    .stub(AdmissionManager, "getAdmissionByKey")
    .callsFake(async (tenantId, key) => {
      const found = [...admissions.values()].find(
        (a) => a.tenantId === tenantId && a.key === key,
      );
      return found ? new Admission(JSON.parse(JSON.stringify(found))) : null;
    });
  sinon
    .stub(AdmissionManager, "updateAdmissionIfRevision")
    .callsFake(async (tenantId, id, revision, set, entries) => {
      const stored = admissions.get(id);
      if (!stored || stored.revision !== revision) return null;
      Object.assign(stored, set, {
        usage: [...stored.usage, ...entries],
        revision: revision + 1,
      });
      writes.push({ id, set });
      return new Admission(JSON.parse(JSON.stringify(stored)));
    });
  sinon
    .stub(AdmissionManager, "countPresentAdmissions")
    .callsFake(
      async (tenantId, facilityId) =>
        [...admissions.values()].filter(
          (a) => a.facilityId === facilityId && a.state === "present",
        ).length,
    );

  sinon.stub(AdmissionCheckManager, "insertCheck").callsFake(async (check) => {
    checks.push(check);
    return check;
  });
  sinon
    .stub(AdmissionCheckManager, "getCheckByRequest")
    .callsFake(
      async (tenantId, actor, requestId) =>
        checks.find(
          (c) =>
            c.tenantId === tenantId &&
            c.requestId === requestId &&
            c.deviceId === (actor.deviceId ?? null),
        ) ?? null,
    );
  // The claim of a request id, unique as the index makes it.
  sinon.stub(AdmissionCheckManager, "claimCheck").callsFake(async (check) => {
    const existing = checks.find(
      (c) =>
        c.tenantId === check.tenantId &&
        c.requestId === check.requestId &&
        c.deviceId === check.deviceId &&
        c.userId === check.userId,
    );
    if (existing) return { existing };
    const row = { ...check, id: `check-${checks.length}`, result: "pending" };
    checks.push(row);
    return { claimed: row };
  });
  sinon
    .stub(AdmissionCheckManager, "finishCheck")
    .callsFake(async (id, result) => {
      Object.assign(
        checks.find((c) => c.id === id),
        result,
      );
    });
  sinon.stub(AdmissionCheckManager, "releaseCheck").resolves();
  sinon.stub(AdmissionCheckManager, "countDeniedChecks").resolves(0);
  sinon.stub(AdmissionCheckManager, "getRecentChecks").resolves([]);

  sinon.stub(RateLimiter, "consume").resolves({
    allowed: true,
    retryAfterSeconds: 0,
    release: async () => {},
  });

  return { devices, admissions, checks, writes };
}

function seasonAdmission(overrides = {}) {
  return {
    id: "a-1",
    tenantId: TENANT,
    key: "ABCDEFGHJKLMNPQRSTUV",
    bookingId: "B-1",
    itemIndex: 0,
    unitIndex: 0,
    memberIndex: 0,
    bookableId: "season",
    bookableTitle: "Saisonkarte Erwachsene",
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
    ...overrides,
  };
}

describe("admission device API", function () {
  let world;
  let saved;
  let token;
  let device;

  beforeEach(async function () {
    saved = process.env.ADMISSION_CODE_SECRET;
    process.env.ADMISSION_CODE_SECRET = SECRET;
    world = installWorld();
    ({ device, token } = await AdmissionDeviceService.createDevice({
      tenantId: TENANT,
      facilityId: "freibad",
      label: "Eingang Nord",
      userId: "owner-1",
    }));
    world.admissions.set("a-1", seasonAdmission());
  });

  afterEach(function () {
    sinon.restore();
    if (saved === undefined) delete process.env.ADMISSION_CODE_SECRET;
    else process.env.ADMISSION_CODE_SECRET = saved;
  });

  const code = (key = "ABCDEFGHJKLMNPQRSTUV", tenantId = TENANT) =>
    codeOf(tenantId, key);
  const scan = (body, auth = `Bearer ${token}`, path = "check") => {
    let req = request(app()).post(`/api/${TENANT}/admission/${path}`);
    if (auth) req = req.set("Authorization", auth);
    return req.send(body);
  };

  describe("the token", function () {
    it("is answered once at the registration and stored only as a hash", function () {
      expect(token).to.match(new RegExp(`^adm\\.${device.id}\\.[\\w-]{43}$`));
      const stored = world.devices.get(`${TENANT}/${device.id}`);
      expect(stored.tokenHash).to.match(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(stored)).not.to.include(token.split(".")[2]);
      expect(device).not.to.have.property("tokenHash");
      expect(device).to.include({
        facilityId: "freibad",
        label: "Eingang Nord",
        status: "active",
        tokenHint: token.slice(-4),
      });
    });

    it("refuses a request without a token, with a made-up one, with a wrong secret", async function () {
      for (const auth of [
        null,
        "Bearer nonsense",
        `Bearer adm.${device.id}.wrong-secret`,
        `Basic ${token}`,
      ]) {
        const res = await scan({ code: code() }, auth);
        expect(res.status, String(auth)).to.equal(401);
        expect(res.body.code).to.equal("admission_device_unauthorized");
      }
      expect(world.checks).to.deep.equal([]);
    });

    it("refuses the token of a device of another tenant", async function () {
      const wrongFacility = await AdmissionDeviceService.createDevice({
        tenantId: OTHER_TENANT,
        facilityId: "freibad",
        label: "Fremd",
        userId: "owner-2",
      }).catch((err) => err);
      // A device is registered only at a facility of its own tenant.
      expect(wrongFacility.code).to.equal("admission_facility_not_found");

      const foreign = await AdmissionDeviceService.createDevice({
        tenantId: OTHER_TENANT,
        facilityId: "fremdbad",
        label: "Fremd",
        userId: "owner-2",
      });
      const res = await scan({ code: code() }, `Bearer ${foreign.token}`);
      expect(res.status).to.equal(401);
      expect(res.body.code).to.equal("admission_device_unauthorized");
    });

    it("refuses a blocked device, and lets it in again once unblocked", async function () {
      await AdmissionDeviceService.blockDevice(TENANT, device.id, {
        reason: "Gerät verloren",
        userId: "owner-1",
      });
      const blocked = await scan({ code: code() });
      expect(blocked.status).to.equal(403);
      expect(blocked.body.code).to.equal("admission_device_blocked");

      await AdmissionDeviceService.unblockDevice(TENANT, device.id, {
        userId: "owner-1",
      });
      expect((await scan({ code: code() })).status).to.equal(200);
    });

    it("refuses the old token once it is renewed", async function () {
      const renewed = await AdmissionDeviceService.renewToken(
        TENANT,
        device.id,
        "owner-1",
      );
      expect(renewed.token).not.to.equal(token);
      expect((await scan({ code: code() })).status).to.equal(401);
      expect(
        (await scan({ code: code() }, `Bearer ${renewed.token}`)).status,
      ).to.equal(200);
    });

    it("answers 429 with Retry-After past the device's rate limit", async function () {
      RateLimiter.consume.resolves({
        allowed: false,
        retryAfterSeconds: 7,
        release: async () => {},
      });
      const res = await scan({ code: code() });
      expect(res.status).to.equal(429);
      expect(res.headers["retry-after"]).to.equal("7");
      expect(world.checks).to.deep.equal([]);
    });
  });

  describe("the check", function () {
    it("grants an entry, refuses the second without an exit, records the exit", async function () {
      const first = await scan({ code: formatCode(code()) });
      expect(first.status).to.equal(200);
      expect(first.body).to.include({
        result: "granted",
        direction: "entry",
        reason: null,
        message: "Eintritt gewährt.",
        checkedIn: 1,
      });
      expect(first.body.admission).to.include({
        id: "a-1",
        bookableTitle: "Saisonkarte Erwachsene",
        state: "present",
      });
      expect(first.body.admission).not.to.have.any.keys(
        "bookingId",
        "mail",
        "name",
        "key",
      );

      const second = await scan({ code: code() });
      expect(second.body).to.include({
        result: "denied",
        reason: "already_present",
        step: 4,
      });

      const out = await scan({ code: code() }, undefined, "exit");
      expect(out.body).to.include({ result: "granted", direction: "exit" });
      expect(world.admissions.get("a-1").state).to.equal("absent");

      expect(world.writes.map((w) => w.set.state)).to.deep.equal([
        "present",
        "absent",
      ]);
      expect(
        world.checks.map((c) => [c.direction, c.result, c.reason, c.deviceId]),
      ).to.deep.equal([
        ["entry", "granted", null, device.id],
        ["entry", "denied", "already_present", device.id],
        ["exit", "granted", null, device.id],
      ]);
    });

    it("refuses a forged code, logs it, writes nothing and names no admission", async function () {
      const forged = `${code().slice(0, -1)}${code().endsWith("A") ? "B" : "A"}`;
      const res = await scan({ code: forged });
      expect(res.body).to.include({
        result: "denied",
        reason: "code_forged",
        step: 1,
        admission: null,
      });
      expect(world.writes).to.deep.equal([]);
      expect(world.checks).to.have.length(1);
    });

    it("refuses a code signed for another tenant as forged", async function () {
      const res = await scan({ code: code(undefined, OTHER_TENANT) });
      expect(res.body.reason).to.equal("code_forged");
    });

    it("checks only at the device's facility", async function () {
      world.admissions.set("a-1", seasonAdmission({ facilityId: "hallenbad" }));
      const res = await scan({ code: code() });
      expect(res.body).to.include({
        result: "denied",
        reason: "wrong_facility",
      });
    });

    it("answers a scan sent twice with the same request id once, with one effect", async function () {
      const first = await scan({ code: code(), requestId: "scan-0001" });
      const again = await scan({ code: code(), requestId: "scan-0001" });
      expect(first.body.result).to.equal("granted");
      expect(again.body).to.include({ result: "granted", replayed: true });
      expect(world.writes).to.have.length(1);
      expect(world.checks).to.have.length(1);
    });

    it("refuses a request id reused for another ticket instead of answering its scan", async function () {
      world.admissions.set(
        "a-2",
        seasonAdmission({ id: "a-2", key: "BCDEFGHJKLMNPQRSTUVW" }),
      );
      await scan({ code: code(), requestId: "scan-0002" });
      const reused = await scan({
        code: code("BCDEFGHJKLMNPQRSTUVW"),
        requestId: "scan-0002",
      });
      expect(reused.status).to.equal(409);
      expect(reused.body.code).to.equal("admission_request_id_reused");
      expect(world.admissions.get("a-2").state).to.equal("issued");
    });

    it("decides anew when another device wrote the admission in between", async function () {
      const real = AdmissionManager.updateAdmissionIfRevision.wrappedMethod;
      let interfered = false;
      AdmissionManager.updateAdmissionIfRevision.callsFake(async (...args) => {
        if (!interfered) {
          interfered = true;
          // Another entrance checked the same card in a moment before.
          const stored = world.admissions.get("a-1");
          Object.assign(stored, {
            state: "present",
            lastEntryAt: Date.now(),
            usedDays: [DateTime.now().setZone(ZONE).toISODate()],
            revision: stored.revision + 1,
          });
          return null;
        }
        return real.apply(AdmissionManager, args);
      });

      const res = await scan({ code: code() });
      expect(res.body).to.include({
        result: "denied",
        reason: "already_present",
      });
    });

    it("answers 503 with Retry-After where every attempt met another write, and logs the check", async function () {
      sinon.stub(Math, "random").returns(0);
      AdmissionManager.updateAdmissionIfRevision.resolves(null);

      const res = await scan({ code: code() });

      expect(res.status).to.equal(503);
      expect(res.headers["retry-after"]).to.equal("1");
      expect(res.body).to.include({
        code: "admission_check_contended",
        statusCode: 503,
      });
      expect(world.checks).to.have.length(1);
      expect(world.checks[0]).to.include({
        result: "error",
        reason: "admission_check_contended",
      });
      expect(world.admissions.get("a-1").state).to.equal("issued");
    });

    it("tells the device its count and last checks", async function () {
      const res = await request(app())
        .get(`/api/${TENANT}/admission/device`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).to.equal(200);
      expect(res.body).to.deep.include({
        device: { id: device.id, label: "Eingang Nord", facilityId: "freibad" },
        facilityId: "freibad",
        checkedIn: 0,
        capacity: 1500,
        counts: "checked_in_admissions",
        recentChecks: [],
      });
    });

    it("refuses a request id that is no short text", async function () {
      const res = await scan({ code: code(), requestId: "x".repeat(200) });
      expect(res.status).to.equal(400);
      expect(res.body.code).to.equal("admission_request_id_invalid");
    });
  });
});
