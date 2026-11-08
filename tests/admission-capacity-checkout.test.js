const { expect } = require("chai");
const sinon = require("sinon");

const BookingManager = require("../src/commons/data-managers/booking-manager");
const {
  BookableManager,
} = require("../src/commons/data-managers/bookable-manager");
const TenantManager = require("../src/commons/data-managers/tenant-manager");
const TenantModel = require("../src/commons/data-managers/models/tenantModel");
const EventManager = require("../src/commons/data-managers/event-manager");
const MembershipManager = require("../src/commons/data-managers/membership-manager");
const OpeningHoursManager = require("../src/commons/utilities/opening-hours-manager");
const { Bookable } = require("../src/commons/entities/bookable/bookable");
const {
  ItemCheckoutService,
} = require("../src/commons/services/checkout/item-checkout-service");
const {
  runAvailabilityCheck,
  runParentAvailabilityCheck,
} = require("../src/commons/availability/checkout-availability-checks");
const {
  checkWindowAvailability,
} = require("../src/commons/availability/check-window-availability");
const {
  computeWindowAvailability,
} = require("../src/commons/services/availability/capacity-interval-calculator");
const {
  InMemoryAvailabilityDataProvider,
} = require("../src/commons/availability/providers");
const {
  CHECK_TYPES,
} = require("../src/commons/availability/checkout-check-types");
const {
  checksParentCapacityAtBooking,
  countsTowardsParentCapacity,
  isTimePeriodBookingValid,
} = require("../src/commons/availability/availability-rules");
const {
  DAY_TICKETS_PER_DAY,
  dayOf,
  tariffFields,
} = require("../scripts/seed-admission-demo");

/**
 * Per tariff, the capacity of the facility is checked at the
 * booking, at the entry or not at all. A tariff checked at the entry or not
 * at all is sold past the facility's `amount` (season tickets are sold over
 * the structural capacity); its own `amount` still limits it. For a tariff
 * checked at the booking, only the tickets of tariffs checked at the
 * booking count against the facility.
 */

const TENANT_ID = "tenant-1";

function facility(overrides = {}) {
  return new Bookable({
    id: "pool",
    tenantId: TENANT_ID,
    title: "Freibad",
    type: "event-location",
    isBookable: false,
    amount: 2,
    relatedBookableIds: ["day-ticket", "season-ticket"],
    admissionFacility: { resetTime: "03:00" },
    ...overrides,
  });
}

function tariff(id, capacityCheck, overrides = {}) {
  return new Bookable({
    id,
    tenantId: TENANT_ID,
    title: id,
    type: "ticket",
    isBookable: true,
    amount: null,
    permittedUsers: [],
    permittedRoles: [],
    admission:
      capacityCheck === undefined
        ? undefined
        : { usage: { mode: "unlimited" }, capacityCheck },
    ...overrides,
  });
}

function booking(id, bookableId, amount, period = {}) {
  return {
    id,
    isRejected: false,
    timeBegin: null,
    timeEnd: null,
    ...period,
    bookableItems: [{ bookableId, amount }],
  };
}

/**
 * A pool of two places, sold out by two day tickets (`booking`); the
 * season ticket is the tariff of each case.
 */
function world({
  origin,
  parent = facility(),
  siblings = [tariff("day-ticket", "booking")],
  bookings = { "day-ticket": [booking("b1", "day-ticket", 2)] },
}) {
  return {
    origin,
    parent,
    siblings: [...siblings, origin],
    bookingsByBookableId: {
      [parent.id]: [],
      [origin.id]: [],
      ...bookings,
    },
  };
}

/**
 * The pool of the example: a capacity of 1000, 1500 season
 * tickets sold with `entry`, and the tickets of the two tariffs with
 * `booking` - the day ticket and an evening ticket beside it.
 */
function pool({
  origin = tariff("day-ticket", "booking"),
  parent = facility({ amount: 1000 }),
  seasonTicket = tariff("season-ticket", "entry"),
  dayTickets = 0,
  eveningTickets = 0,
} = {}) {
  return world({
    origin,
    parent,
    siblings: [seasonTicket, tariff("evening-ticket", "booking")],
    bookings: {
      "season-ticket": [booking("s1", "season-ticket", 1500)],
      "day-ticket": dayTickets ? [booking("d1", "day-ticket", dayTickets)] : [],
      "evening-ticket": eveningTickets
        ? [booking("e1", "evening-ticket", eveningTickets)]
        : [],
    },
  });
}

function provider({ origin, parent, siblings, bookingsByBookableId }) {
  return new InMemoryAvailabilityDataProvider({
    tenantId: TENANT_ID,
    bookable: origin,
    parentBookables: [parent],
    relatedBookables: [],
    relatedBookablesByParentId: { [parent.id]: siblings },
    bookingsByBookableId,
  });
}

async function refusal(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
}

describe("capacity of the facility at the checkout per tariff", function () {
  afterEach(function () {
    sinon.restore();
  });

  describe("checksParentCapacityAtBooking", function () {
    it("checks for a tariff that checks at the booking", function () {
      expect(
        checksParentCapacityAtBooking(tariff("t", "booking"), facility()),
      ).to.equal(true);
    });

    it("does not check the facility for a tariff that checks at the entry or not at all", function () {
      expect(
        checksParentCapacityAtBooking(tariff("t", "entry"), facility()),
      ).to.equal(false);
      expect(
        checksParentCapacityAtBooking(tariff("t", "none"), facility()),
      ).to.equal(false);
    });

    it("checks a ticket without a definition, or with one switched off", function () {
      expect(
        checksParentCapacityAtBooking(tariff("t", undefined), facility()),
      ).to.equal(true);
      expect(
        checksParentCapacityAtBooking(
          tariff("t", undefined, {
            admission: { enabled: false, capacityCheck: "none" },
          }),
          facility(),
        ),
      ).to.equal(true);
    });

    it("checks a parent that is no facility, or one switched off", function () {
      expect(
        checksParentCapacityAtBooking(
          tariff("t", "none"),
          facility({ admissionFacility: undefined }),
        ),
      ).to.equal(true);
      expect(
        checksParentCapacityAtBooking(
          tariff("t", "none"),
          facility({ admissionFacility: { enabled: false } }),
        ),
      ).to.equal(true);
    });

    it("countsTowardsParentCapacity leaves out the tariffs with entry or none for a tariff with booking", function () {
      const origin = tariff("day-ticket", "booking");
      expect(
        countsTowardsParentCapacity(tariff("t", "entry"), origin, facility()),
      ).to.equal(false);
      expect(
        countsTowardsParentCapacity(tariff("t", "none"), origin, facility()),
      ).to.equal(false);
      expect(
        countsTowardsParentCapacity(tariff("t", "booking"), origin, facility()),
      ).to.equal(true);
      expect(
        countsTowardsParentCapacity(tariff("t", undefined), origin, facility()),
      ).to.equal(true);
    });

    it("countsTowardsParentCapacity counts every child for any other origin or parent", function () {
      const seasonTicket = tariff("t", "entry");
      expect(
        countsTowardsParentCapacity(
          seasonTicket,
          tariff("o", undefined),
          facility(),
        ),
      ).to.equal(true);
      expect(
        countsTowardsParentCapacity(
          seasonTicket,
          tariff("day-ticket", "booking"),
          facility({ admissionFacility: undefined }),
        ),
      ).to.equal(true);
      const room = new Bookable({
        id: "room",
        tenantId: TENANT_ID,
        title: "Raum",
        type: "room",
      });
      expect(
        countsTowardsParentCapacity(seasonTicket, room, facility()),
      ).to.equal(true);
    });

    it("checks every bookable that is no ticket", function () {
      const room = new Bookable({
        id: "room",
        tenantId: TENANT_ID,
        title: "Raum",
        type: "room",
      });
      room.admission = { capacityCheck: "none" };
      expect(checksParentCapacityAtBooking(room, facility())).to.equal(true);
    });
  });

  describe("runParentAvailabilityCheck", function () {
    for (const capacityCheck of ["entry", "none"]) {
      it(`sells a tariff with capacityCheck ${capacityCheck} past a full facility`, async function () {
        const result = await runParentAvailabilityCheck({
          provider: provider(
            world({ origin: tariff("season-ticket", capacityCheck) }),
          ),
          originBookable: tariff("season-ticket", capacityCheck),
          amount: 1,
          timeBegin: null,
          timeEnd: null,
        });

        expect(result.available).to.equal(true);
        // The facility it was not checked against names no remaining
        // places: the occupancy display reads them.
        expect(result.parentAvailabilities).to.deep.equal([]);
      });
    }

    it("refuses a tariff with capacityCheck booking at a full facility, as before", async function () {
      const origin = tariff("season-ticket", "booking");
      const err = await refusal(
        runParentAvailabilityCheck({
          provider: provider(world({ origin })),
          originBookable: origin,
          amount: 1,
          timeBegin: null,
          timeEnd: null,
        }),
      );

      expect(err?.checkType).to.equal(CHECK_TYPES.PARENT_AVAILABILITY);
      expect(err.parentAvailability[0]).to.include({
        bookableId: "pool",
        totalCapacity: 2,
        isAvailable: false,
      });
    });

    it("refuses a ticket without a definition at a full parent, as before", async function () {
      const origin = tariff("season-ticket", undefined);
      const err = await refusal(
        runParentAvailabilityCheck({
          provider: provider(world({ origin })),
          originBookable: origin,
          amount: 1,
          timeBegin: null,
          timeEnd: null,
        }),
      );

      expect(err?.checkType).to.equal(CHECK_TYPES.PARENT_AVAILABILITY);
    });

    it("refuses a tariff with capacityCheck none at a full parent that is no facility", async function () {
      const origin = tariff("season-ticket", "none");
      const err = await refusal(
        runParentAvailabilityCheck({
          provider: provider(
            world({
              origin,
              parent: facility({ admissionFacility: undefined }),
            }),
          ),
          originBookable: origin,
          amount: 1,
          timeBegin: null,
          timeEnd: null,
        }),
      );

      expect(err?.checkType).to.equal(CHECK_TYPES.PARENT_AVAILABILITY);
    });

    it("sells a day ticket with booking past 1500 season tickets with entry in a pool of 1000", async function () {
      const fixture = pool({ dayTickets: 600, eveningTickets: 399 });
      const result = await runParentAvailabilityCheck({
        provider: provider(fixture),
        originBookable: fixture.origin,
        amount: 1,
        timeBegin: null,
        timeEnd: null,
      });

      expect(result.available).to.equal(true);
      expect(result.parentAvailabilities).to.have.length(1);
      expect(result.parentAvailabilities[0]).to.include({
        bookableId: "pool",
        isAvailable: true,
      });
    });

    it("refuses the day ticket once the tariffs with booking alone fill the pool", async function () {
      const fixture = pool({ dayTickets: 600, eveningTickets: 400 });
      const err = await refusal(
        runParentAvailabilityCheck({
          provider: provider(fixture),
          originBookable: fixture.origin,
          amount: 1,
          timeBegin: null,
          timeEnd: null,
        }),
      );

      expect(err?.checkType).to.equal(CHECK_TYPES.PARENT_AVAILABILITY);
      // The season tickets are no booking of the refusal.
      expect(err.ticketBookings.map((b) => b.id)).to.have.members(["d1", "e1"]);
    });

    it("refuses more day tickets than the pool has left for them", async function () {
      const fixture = pool({ dayTickets: 600, eveningTickets: 399 });
      const err = await refusal(
        runParentAvailabilityCheck({
          provider: provider(fixture),
          originBookable: fixture.origin,
          amount: 2,
          timeBegin: null,
          timeEnd: null,
        }),
      );

      expect(err?.checkType).to.equal(CHECK_TYPES.PARENT_AVAILABILITY);
    });

    it("still counts the season tickets at a parent without admissionFacility", async function () {
      const fixture = pool({
        parent: facility({ amount: 1000, admissionFacility: undefined }),
      });
      const err = await refusal(
        runParentAvailabilityCheck({
          provider: provider(fixture),
          originBookable: fixture.origin,
          amount: 1,
          timeBegin: null,
          timeEnd: null,
        }),
      );

      expect(err?.checkType).to.equal(CHECK_TYPES.PARENT_AVAILABILITY);
    });

    it("still counts the season tickets for a ticket without a definition", async function () {
      const fixture = pool({ origin: tariff("day-ticket", undefined) });
      const err = await refusal(
        runParentAvailabilityCheck({
          provider: provider(fixture),
          originBookable: fixture.origin,
          amount: 1,
          timeBegin: null,
          timeEnd: null,
        }),
      );

      expect(err?.checkType).to.equal(CHECK_TYPES.PARENT_AVAILABILITY);
    });

    it("still counts the tickets of a tariff without a definition for a tariff with booking", async function () {
      const fixture = pool({
        seasonTicket: tariff("season-ticket", undefined),
      });
      const err = await refusal(
        runParentAvailabilityCheck({
          provider: provider(fixture),
          originBookable: fixture.origin,
          amount: 1,
          timeBegin: null,
          timeEnd: null,
        }),
      );

      expect(err?.checkType).to.equal(CHECK_TYPES.PARENT_AVAILABILITY);
    });
  });

  describe("runAvailabilityCheck", function () {
    it("keeps the tariff's own amount: a contingent stays a contingent", async function () {
      const origin = tariff("season-ticket", "none", { amount: 1 });
      const err = await refusal(
        runAvailabilityCheck({
          provider: provider(
            world({
              origin,
              bookings: {
                "season-ticket": [booking("b1", "season-ticket", 1)],
              },
            }),
          ),
          originBookable: origin,
          amount: 1,
          timeBegin: null,
          timeEnd: null,
        }),
      );

      expect(err?.checkType).to.equal(CHECK_TYPES.AVAILABILITY);
      expect(err).to.include({ totalCapacity: 1, booked: 1 });
    });
  });

  describe("checkWindowAvailability", function () {
    beforeEach(function () {
      sinon
        .stub(MembershipManager, "getMembershipsByTenantAndRoles")
        .resolves([]);
    });

    it("answers the tariff with capacityCheck entry available at a full facility", async function () {
      const origin = tariff("season-ticket", "entry");
      const result = await checkWindowAvailability(
        provider(world({ origin })),
        { timeBegin: null, timeEnd: null, amount: 1, user: "user-1" },
      );

      expect(result).to.deep.equal({ available: true });
    });

    it("refuses the tariff with capacityCheck booking, as before", async function () {
      const origin = tariff("season-ticket", "booking");
      const result = await checkWindowAvailability(
        provider(world({ origin })),
        { timeBegin: null, timeEnd: null, amount: 1, user: "user-1" },
      );

      expect(result).to.deep.equal({
        available: false,
        reason: "parent-availability",
      });
    });

    it("answers the day ticket available past 1500 season tickets", async function () {
      const result = await checkWindowAvailability(
        provider(pool({ dayTickets: 600, eveningTickets: 399 })),
        { timeBegin: null, timeEnd: null, amount: 1, user: "user-1" },
      );

      expect(result).to.deep.equal({ available: true });
    });

    it("refuses the day ticket once the tariffs with booking fill the pool", async function () {
      const result = await checkWindowAvailability(
        provider(pool({ dayTickets: 600, eveningTickets: 400 })),
        { timeBegin: null, timeEnd: null, amount: 1, user: "user-1" },
      );

      expect(result).to.deep.equal({
        available: false,
        reason: "parent-availability",
      });
    });

    it("refuses the day ticket past the season tickets at a parent without admissionFacility", async function () {
      const result = await checkWindowAvailability(
        provider(
          pool({
            parent: facility({ amount: 1000, admissionFacility: undefined }),
          }),
        ),
        { timeBegin: null, timeEnd: null, amount: 1, user: "user-1" },
      );

      expect(result).to.deep.equal({
        available: false,
        reason: "parent-availability",
      });
    });
  });

  describe("computeWindowAvailability (calendar)", function () {
    function context(fixture) {
      return {
        parentBookables: [fixture.parent],
        relatedBookables: [],
        getRelatedBookablesFor: () => fixture.siblings,
        getRelatedBookings: (id) => fixture.bookingsByBookableId[id] ?? [],
        getConcurrentBookings: (id) => fixture.bookingsByBookableId[id] ?? [],
      };
    }

    it("shows the tariff with capacityCheck none free at a full facility", function () {
      const origin = tariff("season-ticket", "none");
      const intervals = computeWindowAvailability(
        context(world({ origin })),
        origin,
        0,
        5000,
        1,
      );

      expect(intervals).to.deep.equal([
        { timeBegin: 0, timeEnd: 5000, available: true },
      ]);
    });

    /**
     * The day ticket, booked by period: 1500 season tickets and 400
     * evening tickets over the whole window, 600 day tickets until 2000
     * and 598 after.
     */
    function periodPool(parent = facility({ amount: 1000 })) {
      const origin = tariff("day-ticket", "booking", {
        isTimePeriodRelated: true,
      });
      const whole = { timeBegin: 0, timeEnd: 5000 };
      return world({
        origin,
        parent,
        siblings: [
          tariff("season-ticket", "entry"),
          tariff("evening-ticket", "booking"),
        ],
        bookings: {
          "season-ticket": [booking("s1", "season-ticket", 1500, whole)],
          "day-ticket": [
            booking("d1", "day-ticket", 600, { timeBegin: 0, timeEnd: 2000 }),
            booking("d2", "day-ticket", 598, {
              timeBegin: 2000,
              timeEnd: 5000,
            }),
          ],
          "evening-ticket": [booking("e1", "evening-ticket", 400, whole)],
        },
      });
    }

    it("shows the places left from the tariffs with booking alone", function () {
      const fixture = periodPool();
      const asked = (amount) =>
        computeWindowAvailability(
          context(fixture),
          fixture.origin,
          0,
          5000,
          amount,
        );

      expect(asked(2)).to.deep.equal([
        { timeBegin: 0, timeEnd: 2000, available: false },
        { timeBegin: 2000, timeEnd: 5000, available: true },
      ]);
      expect(asked(3)).to.deep.equal([
        { timeBegin: 0, timeEnd: 5000, available: false },
      ]);
    });

    it("shows the day ticket taken past the season tickets at a parent without admissionFacility", function () {
      const fixture = periodPool(
        facility({ amount: 1000, admissionFacility: undefined }),
      );
      const intervals = computeWindowAvailability(
        context(fixture),
        fixture.origin,
        0,
        5000,
        1,
      );

      expect(intervals).to.deep.equal([
        { timeBegin: 0, timeEnd: 5000, available: false },
      ]);
    });

    it("shows the tariff with capacityCheck booking taken, as before", function () {
      const origin = tariff("season-ticket", "booking");
      const intervals = computeWindowAvailability(
        context(world({ origin })),
        origin,
        0,
        5000,
        1,
      );

      expect(intervals).to.deep.equal([
        { timeBegin: 0, timeEnd: 5000, available: false },
      ]);
    });
  });

  describe("the day contingent of the demo's Tageskarte", function () {
    // A Wednesday of the season, and the day before, as the demo books them.
    const day = dayOf(new Date(2027, 6, 14, 12, 0));
    const dayBefore = dayOf(new Date(2027, 6, 13, 12, 0));

    function dayTicket() {
      const { day: fields } = tariffFields({
        from: "2027-05-01",
        to: "2027-09-15",
      });
      return new Bookable({
        ...fields,
        id: "day-ticket",
        tenantId: TENANT_ID,
        permittedUsers: [],
        permittedRoles: [],
      });
    }

    function dayWorld(dayTicketBookings) {
      return world({
        origin: dayTicket(),
        parent: facility({ amount: 1000 }),
        siblings: [tariff("season-ticket", "entry")],
        bookings: {
          "season-ticket": [booking("s1", "season-ticket", 1500, day)],
          "day-ticket": dayTicketBookings,
        },
      });
    }

    it("is 600 a day and books the day as its time period", function () {
      const ticket = dayTicket();
      expect(DAY_TICKETS_PER_DAY).to.equal(600);
      expect(ticket.amount).to.equal(600);
      expect(
        isTimePeriodBookingValid(ticket, day.timeBegin, day.timeEnd),
      ).to.equal(true);
      expect(
        isTimePeriodBookingValid(
          ticket,
          day.timeBegin,
          day.timeEnd + 60 * 60 * 1000,
        ),
      ).to.equal(false);
    });

    it("sells the 600th day ticket of a day", async function () {
      const fixture = dayWorld([booking("d1", "day-ticket", 599, day)]);
      const result = await runAvailabilityCheck({
        provider: provider(fixture),
        originBookable: fixture.origin,
        amount: 1,
        ...day,
      });

      expect(result).to.include({
        available: true,
        totalCapacity: 600,
        booked: 599,
        remaining: 1,
      });
    });

    it("refuses the 601st day ticket of a day", async function () {
      const fixture = dayWorld([booking("d1", "day-ticket", 600, day)]);
      const err = await refusal(
        runAvailabilityCheck({
          provider: provider(fixture),
          originBookable: fixture.origin,
          amount: 1,
          ...day,
        }),
      );

      expect(err?.checkType).to.equal(CHECK_TYPES.AVAILABILITY);
      expect(err).to.include({ totalCapacity: 600, booked: 600 });
    });

    it("does not count the day tickets of the day before", async function () {
      const fixture = dayWorld([booking("d1", "day-ticket", 600, dayBefore)]);
      const result = await runAvailabilityCheck({
        provider: provider(fixture),
        originBookable: fixture.origin,
        amount: 1,
        ...day,
      });

      expect(result).to.include({ available: true, booked: 0 });
    });

    it("answers a day with 599 day tickets and 1500 season tickets available", async function () {
      sinon
        .stub(MembershipManager, "getMembershipsByTenantAndRoles")
        .resolves([]);
      const fixture = dayWorld([booking("d1", "day-ticket", 599, day)]);
      const result = await checkWindowAvailability(provider(fixture), {
        ...day,
        amount: 1,
        user: "user-1",
      });

      expect(result).to.deep.equal({ available: true });
    });
  });

  describe("the whole checkout", function () {
    function install(fixture) {
      sinon
        .stub(BookingManager, "getRelatedBookings")
        .callsFake(
          async (_tenantId, bookableId) =>
            fixture.bookingsByBookableId[bookableId] ?? [],
        );
      sinon.stub(BookingManager, "getConcurrentBookings").resolves([]);
      sinon.stub(BookingManager, "getEventBookings").resolves([]);
      sinon
        .stub(BookableManager, "getAncestorBookables")
        .resolves([fixture.parent]);
      sinon
        .stub(BookableManager, "getRelatedBookables")
        .callsFake(async (bookableId) =>
          bookableId === fixture.parent.id ? fixture.siblings : [],
        );
      sinon.stub(TenantManager, "getTenant").resolves({ id: TENANT_ID });
      sinon.stub(TenantModel, "findOne").resolves(null);
      sinon.stub(EventManager, "getEvent").resolves(null);
      sinon
        .stub(OpeningHoursManager, "hasOpeningHoursConflict")
        .resolves(false);
      sinon
        .stub(MembershipManager, "getMembershipsByTenantAndRoles")
        .resolves([]);
    }

    async function checkout(origin) {
      const fixture = world({ origin });
      install(fixture);
      const service = new ItemCheckoutService({
        user: "user-1",
        tenantId: TENANT_ID,
        timeBegin: null,
        timeEnd: null,
        bookableId: origin.id,
        amount: 1,
        couponCode: null,
      });
      await service.init(origin);
      return service.checkAll();
    }

    it("passes a season ticket with capacityCheck none at a full pool", async function () {
      const results = await checkout(tariff("season-ticket", "none"));

      const parent = results.find(
        (r) => r?.checkType === CHECK_TYPES.PARENT_AVAILABILITY,
      );
      expect(parent).to.include({ available: true });
    });

    it("refuses a day ticket with capacityCheck booking at a full pool", async function () {
      const err = await refusal(checkout(tariff("season-ticket", "booking")));

      expect(err?.checkType).to.equal(CHECK_TYPES.PARENT_AVAILABILITY);
    });

    it("passes a day ticket with capacityCheck booking past 1500 season tickets", async function () {
      const fixture = pool({ dayTickets: 999 });
      install(fixture);
      const service = new ItemCheckoutService({
        user: "user-1",
        tenantId: TENANT_ID,
        timeBegin: null,
        timeEnd: null,
        bookableId: fixture.origin.id,
        amount: 1,
        couponCode: null,
      });
      await service.init(fixture.origin);
      const results = await service.checkAll();

      const parent = results.find(
        (r) => r?.checkType === CHECK_TYPES.PARENT_AVAILABILITY,
      );
      expect(parent).to.include({ available: true });
    });
  });
});
