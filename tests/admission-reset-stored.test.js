const { expect } = require("chai");
const mongoose = require("mongoose");
const { DateTime } = require("luxon");

const AdmissionModel = require("../src/commons/data-managers/models/admissionModel");
const AdmissionResetRunModel = require("../src/commons/data-managers/models/admissionResetRunModel");
const BookableModel = require("../src/commons/data-managers/models/bookableModel");
const {
  BookableManager,
} = require("../src/commons/data-managers/bookable-manager");
const { DOMAIN } = require("../src/commons/services/authorization/reach");
const {
  AdmissionResetService,
} = require("../src/commons/services/admission/admission-reset-service");

/**
 * A reset time moved on the day the reset ran, with the facility stored
 * and read back as the job reads it: the entity built on every read has a
 * `timeUpdated` of its own build, so the moment of the change has to come
 * from the stored settings (`scheduleChangedAt`, stamped on the write).
 *
 * Runs against a MongoDB on 127.0.0.1 (`ADMISSION_IT_MONGO_URL`), in a
 * database of its own that is dropped afterwards; skipped where none is
 * reachable. The facility's time zone is chosen so that it is about noon
 * there whenever the test runs: the reset times of the cases lie on the
 * same day, never across midnight.
 */

const URL =
  process.env.ADMISSION_IT_MONGO_URL ||
  `mongodb://127.0.0.1:27017/admission-reset-test-${process.pid}`;
const TENANT = "tenant-reset";
const MINUTE = 60 * 1000;

/** A fixed-offset zone in which it is between 12:00 and 13:00 now. */
function noonZone(now) {
  const offset = 12 - new Date(now).getUTCHours();
  const hours = offset > 12 ? offset - 24 : offset < -11 ? offset + 24 : offset;
  // Etc/GMT names its offset with the sign reversed.
  return hours === 0
    ? "Etc/GMT"
    : `Etc/GMT${hours > 0 ? "-" : "+"}${Math.abs(hours)}`;
}

describe("admission reset: a moved reset time, stored", function () {
  this.timeout(20000);
  let connected = false;
  let zone;
  const local = (now) => DateTime.fromMillis(now, { zone });
  const hhmm = (now) => local(now).toFormat("HH:mm");
  const todayAt = (now, time) => {
    const [hour, minute] = time.split(":").map(Number);
    return local(now)
      .set({ hour, minute, second: 0, millisecond: 0 })
      .toMillis();
  };

  before(async function () {
    try {
      await mongoose.connect(URL, { serverSelectionTimeoutMS: 1500 });
      connected = true;
    } catch {
      this.skip();
    }
  });

  after(async function () {
    if (connected) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  beforeEach(async function () {
    zone = noonZone(Date.now());
    await Promise.all([
      BookableModel.deleteMany({ tenantId: TENANT }),
      AdmissionModel.deleteMany({ tenantId: TENANT }),
      AdmissionResetRunModel.deleteMany({ tenantId: TENANT }),
    ]);
  });

  async function storePool(resetTime) {
    const stored = await BookableManager.getBookable("pool", TENANT, DOMAIN);
    await BookableManager.storeBookable({
      ...(stored || {
        id: "pool",
        tenantId: TENANT,
        title: "Freibad",
        type: "event-location",
        isBookable: false,
        amount: 100,
      }),
      admissionFacility: {
        ...(stored?.admissionFacility || {}),
        resetTime,
        timezone: zone,
      },
    });
  }

  /** The runs of this look, by due time. */
  const look = async (now) =>
    (await AdmissionResetService.runDue({ now, owner: "test" }))
      .filter((run) => run.tenantId === TENANT)
      .map((run) => run.dueAt);

  /** A guest checked in an hour ago. */
  async function guestInside(now) {
    await AdmissionModel.create({
      id: "a-1",
      tenantId: TENANT,
      key: "KEY1",
      bookingId: "B-1",
      itemIndex: 0,
      unitIndex: 0,
      bookableId: "day-ticket",
      facilityId: "pool",
      kind: "single",
      state: "present",
      lastEntryAt: now - 60 * MINUTE,
      entitlement: {
        validFrom: now - 120 * MINUTE,
        validTo: now + 24 * 60 * MINUTE,
        usage: "single",
        timezone: zone,
      },
    });
  }

  it("stamps the change of the schedule on the write, and only that", async function () {
    const before = Date.now();
    await storePool("03:00");
    const first = (await BookableModel.findOne({ id: "pool" }).lean())
      .admissionFacility.scheduleChangedAt;
    expect(first).to.be.at.least(before);

    // Another edit, the schedule unchanged: the stamp stays.
    const stored = await BookableManager.getBookable("pool", TENANT, DOMAIN);
    await BookableManager.storeBookable({
      ...stored,
      title: "Freibad am See",
      admissionFacility: { ...stored.admissionFacility, scheduleChangedAt: 1 },
    });
    expect(
      (await BookableModel.findOne({ id: "pool" }).lean()).admissionFacility
        .scheduleChangedAt,
    ).to.equal(first);
  });

  it("runs a reset time moved to a later hour of the same day at that hour", async function () {
    const now = Date.now();
    await storePool("03:00");
    expect(await look(now)).to.deep.equal([todayAt(now, "03:00")]);
    await guestInside(now);

    // Ten minutes ago the reset time was moved to five minutes ago: the job
    // looks after the new time has come, as it does once a minute.
    const later = hhmm(now - 5 * MINUTE);
    await storePool(later);
    await BookableModel.updateOne(
      { id: "pool", tenantId: TENANT },
      { "admissionFacility.scheduleChangedAt": now - 10 * MINUTE },
    );
    expect(await look(Date.now())).to.deep.equal([todayAt(now, later)]);

    const guest = await AdmissionModel.findOne({ id: "a-1" }).lean();
    expect(guest.state).to.equal("absent");
  });

  it("does not make up a reset time moved to an hour already past", async function () {
    const now = Date.now();
    await storePool("03:00");
    await look(now);
    await guestInside(now);

    await storePool("10:00");
    expect(await look(now + MINUTE)).to.deep.equal([]);
    const guest = await AdmissionModel.findOne({ id: "a-1" }).lean();
    expect(guest.state).to.equal("present");
  });
});
