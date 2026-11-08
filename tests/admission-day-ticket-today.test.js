const { expect } = require("chai");

const {
  runTimeInPastCheck,
} = require("../src/commons/availability/checkout-availability-checks");
const {
  CHECK_TYPES,
} = require("../src/commons/availability/checkout-check-types");
const {
  CHECKOUT_REASONS,
} = require("../src/commons/services/checkout/checkout-reasons");
const {
  isValidForBookedPeriod,
} = require("../src/commons/entities/admission/admission-definition");

/**
 * The day ticket of today: booked for the day 00:00-23:59, bought on the
 * day. A tariff whose admissions are valid for the booked period is sold
 * while the period lasts; every other bookable still cannot start before
 * now (`checkout.time_in_past`).
 */

const HOUR = 60 * 60 * 1000;
const DAY_BEGIN = Date.UTC(2026, 10, 8, 23, 0, 0); // 09.11. 00:00 Berlin
const DAY_END = DAY_BEGIN + 24 * HOUR - 60 * 1000; // 09.11. 23:59 Berlin
const NOON = DAY_BEGIN + 12 * HOUR;

const WHOLE_DAY = [
  { weekdays: [0, 1, 2, 3, 4, 5, 6], startTime: "00:00", endTime: "23:59" },
];

function ticket(admission, fields = {}) {
  return {
    id: "day-ticket",
    title: "Tageskarte",
    type: "ticket",
    isTimePeriodRelated: true,
    timePeriods: WHOLE_DAY,
    admission,
    ...fields,
  };
}

const dayTicket = ticket({ usage: { mode: "single" } });

function check(originBookable, now, period = {}) {
  return runTimeInPastCheck({
    originBookable,
    timeBegin: DAY_BEGIN,
    timeEnd: DAY_END,
    now,
    ...period,
  });
}

function refusal(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

describe("admission: the day ticket of today", function () {
  it("reads a tariff valid for the booked period, and no other", function () {
    expect(isValidForBookedPeriod(dayTicket)).to.equal(true);
    expect(
      isValidForBookedPeriod(
        ticket({ validity: { mode: "booking" }, usage: { mode: "quota" } }),
      ),
    ).to.equal(true);
    expect(
      isValidForBookedPeriod(
        ticket({
          validity: { mode: "window", from: "2026-05-01", to: "2026-09-15" },
        }),
      ),
    ).to.equal(false);
    expect(isValidForBookedPeriod(ticket(undefined))).to.equal(false);
    expect(isValidForBookedPeriod(ticket({ enabled: false }))).to.equal(false);
    expect(isValidForBookedPeriod({ ...dayTicket, type: "room" })).to.equal(
      false,
    );
  });

  it("sells today's day ticket at noon", function () {
    expect(check(dayTicket, NOON).available).to.equal(true);
  });

  it("sells it in the last minute of the day", function () {
    expect(check(dayTicket, DAY_END - 30 * 1000).available).to.equal(true);
  });

  it("refuses it once the day is over", function () {
    const err = refusal(() => check(dayTicket, DAY_END + 1));
    expect(err).to.include({
      checkType: CHECK_TYPES.TIME_IN_PAST,
      reason: CHECKOUT_REASONS.TIME_IN_PAST,
    });
  });

  it("refuses it without the end of the period", function () {
    const err = refusal(() => check(dayTicket, NOON, { timeEnd: null }));
    expect(err?.reason).to.equal(CHECKOUT_REASONS.TIME_IN_PAST);
  });

  it("still refuses a room, a ticket without a definition and a season ticket begun", function () {
    const room = { id: "room", title: "Raum", isScheduleRelated: true };
    const plain = ticket(undefined);
    const season = ticket({
      validity: { mode: "window", from: "2026-11-01", to: "2026-12-31" },
    });
    for (const bookable of [room, plain, season]) {
      expect(refusal(() => check(bookable, NOON))?.reason).to.equal(
        CHECKOUT_REASONS.TIME_IN_PAST,
      );
    }
  });
});
