const {
  getBookedAmountForBookableSet,
  sumBookedAmountForBookableSet,
} = require("./booking-amount");
const { expandBlockedInterval } = require("../booking-buffer");
const { evaluateOriginCapacity } = require("./capacity-rules");
const { CAPACITY_MODES } = require("./types");
const {
  combineAdjacentIntervals,
} = require("../../services/availability/availability-interval-utils");
const {
  CAPACITY_CHECKS,
  normalizeDefinition,
  normalizeFacility,
} = require("../../entities/admission/admission-definition");

/**
 * The `capacityCheck` of a ticket's admission definition, or
 * `null` where the bookable is no ticket or issues no admissions.
 *
 * @param {import("../../entities/bookable/bookable").Bookable} bookable
 * @returns {string|null}
 */
function capacityCheckOf(bookable) {
  if (bookable?.type !== "ticket") {
    return null;
  }
  return normalizeDefinition(bookable.admission)?.capacityCheck ?? null;
}

/**
 * Whether booking a child is checked against the capacity of a parent. A
 * tariff whose admission definition checks the capacity of its facility at
 * the entry or not at all (`capacityCheck` `entry`, `none`) is sold
 * past the facility's `amount` - season tickets are sold over the
 * structural capacity. Every other child, and every parent that is no
 * facility, is checked as before. The child's own `amount` is not touched:
 * a tariff can be sold as a contingent of its own.
 *
 * @param {import("../../entities/bookable/bookable").Bookable} childBookable
 * @param {import("../../entities/bookable/bookable").Bookable} parentBookable
 * @returns {boolean}
 */
function checksParentCapacityAtBooking(childBookable, parentBookable) {
  const capacityCheck = capacityCheckOf(childBookable);
  if (
    capacityCheck !== CAPACITY_CHECKS.ENTRY &&
    capacityCheck !== CAPACITY_CHECKS.NONE
  ) {
    return true;
  }
  return normalizeFacility(parentBookable?.admissionFacility) === null;
}

/**
 * Whether the bookings of a child count against the capacity of a parent
 * when the origin is booked. For a tariff that checks the capacity of its
 * facility at the booking (`capacityCheck` `booking`), the tariffs checked
 * at the entry or not at all do not count: the entrance checks the
 * capacity for those (step 6), so 1500 season tickets of a pool of 1000
 * leave the day tickets their 1000. Every other origin, and every parent
 * that is no facility, counts every child as before.
 *
 * @param {import("../../entities/bookable/bookable").Bookable} childBookable
 * @param {import("../../entities/bookable/bookable").Bookable} originBookable
 * @param {import("../../entities/bookable/bookable").Bookable} parentBookable
 * @returns {boolean}
 */
function countsTowardsParentCapacity(
  childBookable,
  originBookable,
  parentBookable,
) {
  if (capacityCheckOf(originBookable) !== CAPACITY_CHECKS.BOOKING) {
    return true;
  }
  return checksParentCapacityAtBooking(childBookable, parentBookable);
}

/**
 * Parent capacity: exclusive for non-ticket children, additive with child tickets for ticket children.
 *
 * @param {Object} params
 * @param {number} params.parentAmountBooked
 * @param {number} [params.childTicketAmountBooked]
 * @param {number|null|undefined} params.capacity
 * @param {number} params.requestedAmount
 * @param {boolean} params.isTicketChild
 * @returns {boolean}
 */
function evaluateParentCapacity({
  parentAmountBooked,
  childTicketAmountBooked = 0,
  capacity,
  requestedAmount,
  isTicketChild,
}) {
  if (!capacity) {
    return true;
  }

  if (isTicketChild) {
    return (
      parentAmountBooked + childTicketAmountBooked + requestedAmount <= capacity
    );
  }

  return parentAmountBooked < capacity;
}

/**
 * Child capacity: exclusive for non-ticket children — any booking on the child
 * blocks the parent; additive for ticket children — requested amount counts
 * against child capacity.
 *
 * @param {Object} params
 * @param {number} params.childAmountBooked
 * @param {number|null|undefined} params.capacity
 * @param {number} params.requestedAmount
 * @param {boolean} [params.isTicketChild]
 * @returns {boolean}
 */
function evaluateChildCapacity({
  childAmountBooked,
  capacity,
  requestedAmount,
  isTicketChild = false,
}) {
  if (!isTicketChild) {
    return childAmountBooked === 0;
  }

  if (!capacity) {
    return true;
  }

  return childAmountBooked + requestedAmount <= capacity;
}

/**
 * Ticket-parent capacity intervals combining parent + related child bookings.
 *
 * @param {Object} params
 * @param {number} params.windowStart
 * @param {number} params.windowEnd
 * @param {import("../../entities/booking/booking").Booking[]} params.bookings
 * @param {import("../../entities/bookable/bookable").Bookable} params.parentBookable
 * @param {import("../../entities/bookable/bookable").Bookable[]} params.relatedBookables
 * @param {number} params.requestedAmount
 * @param {boolean} params.useTimeOverlap
 * @param {number} [params.bufferBeforeMs]
 * @param {number} [params.bufferAfterMs]
 * @returns {import("./types").AvailabilityInterval[]}
 */
function evaluateTicketParentCapacityIntervals({
  windowStart,
  windowEnd,
  bookings,
  parentBookable,
  relatedBookables,
  requestedAmount,
  useTimeOverlap,
  bufferBeforeMs = 0,
  bufferAfterMs = 0,
}) {
  const capacity = parentBookable.amount;
  if (!capacity) {
    return [
      {
        timeBegin: windowStart,
        timeEnd: windowEnd,
        available: true,
      },
    ];
  }

  const relevantIds = new Set([
    parentBookable.id,
    ...relatedBookables.map((bookable) => bookable.id),
  ]);

  if (!useTimeOverlap) {
    const amountBooked = sumBookedAmountForBookableSet(bookings, relevantIds);

    return [
      {
        timeBegin: windowStart,
        timeEnd: windowEnd,
        available: amountBooked + requestedAmount <= capacity,
      },
    ];
  }

  const events = [];

  for (const booking of bookings) {
    const amount = getBookedAmountForBookableSet(booking, relevantIds);
    if (amount <= 0) {
      continue;
    }

    let start = booking.timeBegin;
    let end = booking.timeEnd;

    if (start == null || end == null) {
      start = windowStart;
      end = windowEnd;
    } else {
      const blocked = expandBlockedInterval(
        start,
        end,
        bufferBeforeMs,
        bufferAfterMs,
      );
      start = Math.max(blocked.timeBegin, windowStart);
      end = Math.min(blocked.timeEnd, windowEnd);
      if (start >= end) {
        continue;
      }
    }

    events.push({ x: start, delta: amount });
    events.push({ x: end, delta: -amount });
  }

  events.push({ x: windowStart, delta: 0 });
  events.push({ x: windowEnd, delta: 0 });
  events.sort((a, b) => a.x - b.x || a.delta - b.delta);

  let booked = 0;
  let prevX = windowStart;
  const intervals = [];

  for (const event of events) {
    if (event.x > prevX) {
      intervals.push({
        timeBegin: prevX,
        timeEnd: event.x,
        available: booked + requestedAmount <= capacity,
      });
    }

    booked += event.delta;
    prevX = event.x;
  }

  return combineAdjacentIntervals(intervals);
}

/**
 * Convenience wrapper for point-in-time parent checks using booking lists.
 *
 * @param {Object} params
 * @param {import("../../entities/booking/booking").Booking[]} params.parentBookings
 * @param {string} params.parentBookableId
 * @param {import("../../entities/booking/booking").Booking[]} [params.childBookings]
 * @param {Set<string>|string[]} [params.childBookableIds]
 * @param {number|null|undefined} params.capacity
 * @param {number} params.requestedAmount
 * @param {boolean} params.isTicketChild
 * @returns {boolean}
 */
function evaluateParentCapacityFromBookings({
  parentBookings,
  parentBookableId,
  childBookings = [],
  childBookableIds = [],
  capacity,
  requestedAmount,
  isTicketChild,
}) {
  const { amountBooked: parentAmountBooked } = evaluateOriginCapacity({
    bookings: parentBookings,
    bookableId: parentBookableId,
    capacity: capacity || 1,
    amount: 0,
    mode: CAPACITY_MODES.ADDITIVE,
  });

  const childTicketAmountBooked = isTicketChild
    ? sumBookedAmountForBookableSet(childBookings, childBookableIds)
    : 0;

  return evaluateParentCapacity({
    parentAmountBooked,
    childTicketAmountBooked,
    capacity,
    requestedAmount,
    isTicketChild,
  });
}

module.exports = {
  checksParentCapacityAtBooking,
  countsTowardsParentCapacity,
  evaluateParentCapacity,
  evaluateChildCapacity,
  evaluateTicketParentCapacityIntervals,
  evaluateParentCapacityFromBookings,
};
