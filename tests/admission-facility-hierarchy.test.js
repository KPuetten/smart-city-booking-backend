const { expect } = require("chai");
const mongoose = require("mongoose");

const BookableModel = require("../src/commons/data-managers/models/bookableModel");
const BookingModel = require("../src/commons/data-managers/models/bookingModel");
const BookingManager = require("../src/commons/data-managers/booking-manager");
const TenantModel = require("../src/commons/data-managers/models/tenantModel");
const AdmissionModel = require("../src/commons/data-managers/models/admissionModel");
const { Bookable } = require("../src/commons/entities/bookable/bookable");
const {
  BookableManager,
} = require("../src/commons/data-managers/bookable-manager");
const {
  ItemCheckoutService,
} = require("../src/commons/services/checkout/item-checkout-service");
const {
  AdmissionService,
} = require("../src/commons/services/admission/admission-service");
const {
  CHECK_TYPES,
} = require("../src/commons/availability/checkout-check-types");

/**
 * The facility and its tariffs as stored documents, without a stub: the
 * checkout reads the hierarchy through `getAncestorBookables` and
 * `getRelatedBookables`, the issuance looks the facility up - both must
 * read it the same way. A parent lists its children in
 * `relatedBookableIds` (the bookable manager, the hierarchy of the
 * administration), so the facility lists its tariffs.
 *
 * Runs against a MongoDB on 127.0.0.1 (`ADMISSION_IT_MONGO_URL`), in a
 * database of its own that is dropped afterwards; skipped where none is
 * reachable.
 */

const URL =
  process.env.ADMISSION_IT_MONGO_URL ||
  `mongodb://127.0.0.1:27017/admission-hierarchy-test-${process.pid}`;
const TENANT = "tenant-hierarchy";

/** A day well ahead, as a day ticket books it (00:00-23:59 local). */
function dayAhead(days) {
  const begin = new Date();
  begin.setDate(begin.getDate() + days);
  begin.setHours(0, 0, 0, 0);
  const end = new Date(begin);
  end.setHours(23, 59, 0, 0);
  return { timeBegin: begin.getTime(), timeEnd: end.getTime() };
}

/** What a stored booking needs besides its items, bound and free of charge. */
const PAID = {
  status: "confirmed",
  isCommitted: true,
  isPayed: true,
  mail: "gast@example.test",
  name: "Gast",
  priceEur: 0,
  paymentProvider: "invoice",
};

const WHOLE_DAY = {
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  startTime: "00:00",
  endTime: "23:59",
};

function ticket(id, capacityCheck, fields = {}) {
  return new Bookable({
    id,
    tenantId: TENANT,
    title: id,
    type: "ticket",
    isBookable: true,
    isPublic: true,
    amount: null,
    priceCategories: [],
    admission: {
      enabled: true,
      validity: { mode: "booking" },
      usage: { mode: "single" },
      capacityCheck,
    },
    ...fields,
  });
}

async function store(bookable) {
  return BookableManager.storeBookable(bookable);
}

async function bookDay(id, bookableId, amount, day) {
  await BookingManager.storeBooking({
    id,
    tenantId: TENANT,
    ...day,
    ...PAID,
    bookableItems: [{ bookableId, amount, tenantId: TENANT }],
  });
}

async function checkout(bookableId, amount, day) {
  const service = new ItemCheckoutService({
    user: null,
    tenantId: TENANT,
    ...day,
    bookableId,
    amount,
    couponCode: null,
  });
  await service.init();
  try {
    return { results: await service.checkAll(), error: null };
  } catch (error) {
    return { results: null, error };
  }
}

describe("admission: the facility in the hierarchy, stored", function () {
  this.timeout(20000);
  let connected = false;
  // Read when the tests run, not when the file loads: another file sets the
  // secret at its load, after this one.
  let secretBefore;

  before(async function () {
    try {
      await mongoose.connect(URL, { serverSelectionTimeoutMS: 1500 });
      connected = true;
    } catch {
      this.skip();
    }
    secretBefore = process.env.ADMISSION_CODE_SECRET;
    process.env.ADMISSION_CODE_SECRET = "x".repeat(40);
    await TenantModel.create({ id: TENANT, name: "Hierarchie" });
  });

  after(async function () {
    if (!connected) {
      return;
    }
    if (secretBefore === undefined) delete process.env.ADMISSION_CODE_SECRET;
    else process.env.ADMISSION_CODE_SECRET = secretBefore;
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async function () {
    await Promise.all([
      BookableModel.deleteMany({ tenantId: TENANT }),
      BookingModel.deleteMany({ tenantId: TENANT }),
      AdmissionModel.deleteMany({ tenantId: TENANT }),
    ]);
    // A pool of three places, its day ticket (checked at the booking) and
    // its season ticket (checked at the entry), both its children.
    await store(
      ticket("day-ticket", "booking", {
        isTimePeriodRelated: true,
        timePeriods: [WHOLE_DAY],
      }),
    );
    await store(ticket("season-ticket", "entry"));
    await store(
      new Bookable({
        id: "pool",
        tenantId: TENANT,
        title: "Freibad",
        type: "event-location",
        isBookable: false,
        amount: 3,
        relatedBookableIds: ["day-ticket", "season-ticket"],
        admissionFacility: { resetTime: "03:00", timezone: "Europe/Berlin" },
      }),
    );
  });

  it("sells the day tickets up to the pool's capacity", async function () {
    const day = dayAhead(3);
    await bookDay("D-1", "day-ticket", 2, day);

    const { error } = await checkout("day-ticket", 1, day);

    expect(error).to.equal(null);
  });

  it("refuses the day ticket past the pool's capacity", async function () {
    const day = dayAhead(3);
    await bookDay("D-1", "day-ticket", 3, day);

    const { error } = await checkout("day-ticket", 1, day);

    expect(error?.checkType).to.equal(CHECK_TYPES.PARENT_AVAILABILITY);
  });

  it("sells today's day ticket after the day began", async function () {
    const { error } = await checkout("day-ticket", 1, dayAhead(0));

    expect(error).to.equal(null);
  });

  it("does not count the day tickets of another day", async function () {
    await bookDay("D-1", "day-ticket", 3, dayAhead(4));

    const { error } = await checkout("day-ticket", 1, dayAhead(3));

    expect(error).to.equal(null);
  });

  it("sells season tickets past the pool's capacity", async function () {
    await BookingManager.storeBooking({
      id: "S-1",
      tenantId: TENANT,
      ...PAID,
      bookableItems: [
        { bookableId: "season-ticket", amount: 5, tenantId: TENANT },
      ],
    });

    const { error } = await checkout("season-ticket", 1, {
      timeBegin: null,
      timeEnd: null,
    });

    expect(error).to.equal(null);
  });

  it("issues the admissions of a day ticket at the pool", async function () {
    const day = dayAhead(3);
    const tariff = (
      await BookableModel.findOne({ id: "day-ticket" })
    ).toObject();
    const booking = {
      id: "D-2",
      tenantId: TENANT,
      ...day,
      bookableItems: [
        { bookableId: "day-ticket", amount: 2, _bookableUsed: tariff },
      ],
    };

    const result = await AdmissionService.issueForBooking(TENANT, booking);

    expect(result.issued).to.equal(2);
    const admissions = await AdmissionModel.find({ bookingId: "D-2" }).lean();
    expect(admissions.map((a) => a.facilityId)).to.deep.equal(["pool", "pool"]);
  });
});
