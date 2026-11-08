const { expect } = require("chai");

const { Bookable } = require("../src/commons/entities/bookable/bookable");
const {
  normalizeDefinition,
  normalizeFacility,
  admissionPositionsOf,
  hasAdmissionPositions,
} = require("../src/commons/entities/admission/admission-definition");

function ticket(admission, overrides = {}) {
  return new Bookable({
    id: "tariff",
    tenantId: "tenant-1",
    title: "Saisonkarte",
    type: "ticket",
    admission,
    ...overrides,
  });
}

function errorsOf(bookable) {
  try {
    bookable.validate();
    return [];
  } catch (err) {
    expect(err.name).to.equal("ValidationError");
    return err.errors.map((e) => `${e.field} ${e.code}`);
  }
}

describe("admission definition of a tariff", function () {
  it("leaves every bookable without one as it was", function () {
    const bookable = new Bookable({
      id: "room",
      tenantId: "tenant-1",
      title: "Raum",
      type: "room",
    });
    expect(bookable).not.to.have.property("admission");
    expect(bookable).not.to.have.property("admissionFacility");
    expect(bookable.validate()).to.equal(true);
  });

  it("fills the defaults: single use for the booking period, no block time, one per unit", function () {
    expect(normalizeDefinition({})).to.deep.equal({
      validity: { mode: "booking", from: null, to: null, days: null },
      usage: { mode: "single", quota: null },
      blockMinutes: 0,
      personalized: false,
      admissionsPerUnit: 1,
      capacityCheck: "booking",
    });
    expect(normalizeDefinition(null)).to.equal(null);
    expect(normalizeDefinition({ enabled: false })).to.equal(null);
  });

  it("accepts the tariffs of a pool: season, ten-visit, family, day", function () {
    const tariffs = [
      {
        validity: { mode: "window", from: "2027-05-01", to: "2027-09-15" },
        usage: { mode: "unlimited" },
        blockMinutes: 180,
      },
      {
        validity: { mode: "duration", days: 365 },
        usage: { mode: "quota", quota: 10 },
      },
      {
        validity: { mode: "window", from: "2027-05-01", to: "2027-09-15" },
        usage: { mode: "unlimited" },
        admissionsPerUnit: 4,
        capacityCheck: "entry",
      },
      { validity: { mode: "booking" }, usage: { mode: "single" } },
    ];
    for (const admission of tariffs) {
      expect(errorsOf(ticket(admission))).to.deep.equal([]);
    }
  });

  it("refuses a definition on anything but a ticket", function () {
    expect(errorsOf(ticket({}, { type: "room" }))).to.deep.equal([
      "admission admission_ticket_only",
    ]);
  });

  it("refuses a window without dates or ending before it starts", function () {
    expect(errorsOf(ticket({ validity: { mode: "window" } }))).to.deep.equal([
      "admission.validity.from invalid_format",
      "admission.validity.to invalid_format",
    ]);
    expect(
      errorsOf(
        ticket({
          validity: { mode: "window", from: "2027-09-15", to: "2027-05-01" },
        }),
      ),
    ).to.deep.equal(["admission.validity.to greater_equal_than"]);
  });

  it("refuses a window on a day the calendar does not have", function () {
    // Well formed, but no day: issued, it would be a validity of NaN.
    expect(
      errorsOf(
        ticket({
          validity: { mode: "window", from: "2026-02-31", to: "2026-13-01" },
        }),
      ),
    ).to.deep.equal([
      "admission.validity.from invalid_format",
      "admission.validity.to invalid_format",
    ]);
    expect(
      errorsOf(
        ticket({
          validity: { mode: "window", from: "2028-02-29", to: "2028-03-01" },
        }),
      ),
    ).to.deep.equal([]);
  });

  it("refuses a quota or a duration below one, a block time beyond a day, a bundle beyond 50", function () {
    expect(
      errorsOf(
        ticket({
          validity: { mode: "duration", days: 0 },
          usage: { mode: "quota", quota: 0 },
          blockMinutes: 1441,
          admissionsPerUnit: 51,
          capacityCheck: "always",
        }),
      ),
    ).to.deep.equal([
      "admission.validity.days min_value",
      "admission.usage.quota min_value",
      "admission.blockMinutes invalid_custom",
      "admission.admissionsPerUnit invalid_custom",
      "admission.capacityCheck invalid_enum",
    ]);
  });
});

describe("admission settings of a facility", function () {
  const facility = (admissionFacility, type = "event-location") =>
    new Bookable({
      id: "freibad",
      tenantId: "tenant-1",
      title: "Freibad",
      type,
      admissionFacility,
    });

  it("fills the defaults: reset at 03:00 Berlin time, exit scan on, no stay limit", function () {
    expect(normalizeFacility({})).to.deep.equal({
      resetTime: "03:00",
      exitScan: true,
      maxStayMinutes: null,
      timezone: "Europe/Berlin",
    });
  });

  it("accepts settings on a facility, refuses them on a ticket", function () {
    expect(errorsOf(facility({ resetTime: "02:30" }))).to.deep.equal([]);
    expect(errorsOf(facility({}, "ticket"))).to.deep.equal([
      "admissionFacility admission_facility_not_ticket",
    ]);
  });

  it("refuses a reset time, a stay limit or a time zone that is none", function () {
    expect(
      errorsOf(
        facility({
          resetTime: "25:00",
          maxStayMinutes: 0,
          timezone: "Mars/Olympus",
        }),
      ),
    ).to.deep.equal([
      "admissionFacility.resetTime invalid_format",
      "admissionFacility.maxStayMinutes min_value",
      "admissionFacility.timezone invalid_format",
    ]);
  });
});

describe("the admission positions of a booking", function () {
  it("are the ticket positions whose booked snapshot carries a definition", function () {
    const booking = {
      bookableItems: [
        { bookableId: "room", _bookableUsed: { id: "room", type: "room" } },
        {
          bookableId: "day",
          amount: 2,
          _bookableUsed: { id: "day", type: "ticket", admission: {} },
        },
        { bookableId: "event", _bookableUsed: { id: "event", type: "ticket" } },
      ],
    };
    const positions = admissionPositionsOf(booking);
    expect(positions.map((p) => [p.itemIndex, p.tariff.id])).to.deep.equal([
      [1, "day"],
    ]);
    expect(hasAdmissionPositions(booking)).to.equal(true);
    expect(
      hasAdmissionPositions({ bookableItems: [booking.bookableItems[0]] }),
    ).to.equal(false);
  });
});
