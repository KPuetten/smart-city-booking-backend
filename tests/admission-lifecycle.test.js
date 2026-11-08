/**
 * The admissions in the booking lifecycle: issued on every
 * way a booking becomes binding - admitted confirmed (automatic release,
 * manual booking, booking without payment), confirmed by the
 * administration, paid, reinstated - and set invalid by a cancellation, a
 * withdrawal and a deletion. Run over the in-memory adapters with a
 * recording admission adapter. A booking without a tariff that issues
 * admissions declares no admission step at all: its pipeline is the one it
 * ran before, which the effect tables of the other lifecycle tests hold.
 */

const { expect } = require("chai");

const {
  createBookingLifecycle,
} = require("../src/commons/services/booking-lifecycle/booking-lifecycle");
const {
  createGroupBookingLifecycle,
} = require("../src/commons/services/booking-lifecycle/group-booking-lifecycle");
const {
  createBookingDeletion,
} = require("../src/commons/services/booking-lifecycle/booking-deletion");
const {
  TRIGGER,
} = require("../src/commons/services/booking-lifecycle/booking-state");
const {
  inMemoryAdapters,
  recordingAdapter,
  effectTable,
} = require("./helpers/in-memory-lifecycle-adapters");

const TENANT = "tenant-1";

/** A season ticket as the booking snapshots it. */
const SEASON = {
  id: "season",
  type: "ticket",
  title: "Saisonkarte",
  admission: {
    validity: { mode: "window", from: "2027-05-01", to: "2027-09-15" },
    usage: { mode: "unlimited" },
    blockMinutes: 180,
  },
};

function booking(overrides = {}) {
  return {
    id: "B-1",
    tenantId: TENANT,
    status: "requested",
    priceEur: 0,
    paymentProvider: "giroCockpit",
    mail: "erika@example.test",
    name: "Erika Muster",
    assignedUserId: "erika@example.test",
    attachments: [],
    hooks: [],
    accessInfo: [],
    bookableItems: [{ bookableId: "season", amount: 1, _bookableUsed: SEASON }],
    ...overrides,
  };
}

function lifecycleOver(options, { failOn = [] } = {}) {
  const adapters = inMemoryAdapters(options);
  adapters.admission = recordingAdapter("admission", ["issue", "invalidate"], {
    failOn,
  });
  return {
    adapters,
    lifecycle: createBookingLifecycle(adapters),
    deletion: createBookingDeletion(adapters),
  };
}

const provisionRows = (outcome) =>
  effectTable(outcome).filter((row) => row.startsWith("provision"));

const callsOf = (adapters) =>
  adapters.admission.calls.map(({ op, args }) => [
    op,
    args[0],
    args[1].id,
    ...args.slice(2),
  ]);

describe("admissions in the booking lifecycle", function () {
  it("declares no admission step for a booking without such a tariff", async function () {
    const { adapters, lifecycle } = lifecycleOver({
      bookings: [
        booking({
          status: "confirmed",
          bookableItems: [
            { bookableId: "room", amount: 1, _bookableUsed: { type: "room" } },
          ],
        }),
      ],
    });

    const outcome = await lifecycle.admit(TENANT, "B-1", {
      trigger: TRIGGER.ADMIN,
    });

    expect(provisionRows(outcome)).to.deep.equal([
      "provision access.hold ok",
      "provision access.provision ok",
    ]);
    expect(adapters.admission.calls).to.deep.equal([]);
  });

  it("issues at the admission of a booking confirmed at once (automatic release, manual, free)", async function () {
    const { adapters, lifecycle } = lifecycleOver({
      bookings: [booking({ status: "confirmed" })],
    });

    const outcome = await lifecycle.admit(TENANT, "B-1", {
      trigger: TRIGGER.CUSTOMER,
    });

    expect(provisionRows(outcome)).to.deep.equal([
      "provision access.hold ok",
      "provision access.provision ok",
      "provision admission.issue ok",
    ]);
    expect(callsOf(adapters)).to.deep.equal([["issue", TENANT, "B-1"]]);
  });

  it("issues nothing for a request, and issues at its confirmation", async function () {
    const { adapters, lifecycle } = lifecycleOver({
      bookings: [booking()],
    });

    const admitted = await lifecycle.admit(TENANT, "B-1", {
      trigger: TRIGGER.CUSTOMER,
    });
    expect(provisionRows(admitted)).to.include(
      "provision admission.issue skipped",
    );
    expect(adapters.admission.calls).to.deep.equal([]);

    const confirmed = await lifecycle.confirm(TENANT, "B-1", {
      trigger: TRIGGER.ADMIN,
    });
    expect(confirmed.status).to.equal("confirmed");
    expect(provisionRows(confirmed)).to.include("provision admission.issue ok");
    expect(callsOf(adapters)).to.deep.equal([["issue", TENANT, "B-1"]]);
  });

  it("issues at the payment of a priced booking, not when it is asked to pay", async function () {
    const { adapters, lifecycle } = lifecycleOver({
      bookings: [booking({ priceEur: 120 })],
    });

    const confirmed = await lifecycle.confirm(TENANT, "B-1", {
      trigger: TRIGGER.ADMIN,
    });
    expect(confirmed.status).to.equal("payment_due");
    expect(provisionRows(confirmed)).to.include(
      "provision admission.issue skipped",
    );

    const paid = await lifecycle.pay(TENANT, "B-1", {
      trigger: TRIGGER.PAYMENT,
    });
    expect(paid.status).to.equal("confirmed");
    expect(provisionRows(paid)).to.deep.equal([
      "provision access.provision ok",
      "provision admission.issue ok",
    ]);
    expect(callsOf(adapters)).to.deep.equal([["issue", TENANT, "B-1"]]);
  });

  it("records a failed issuance: the booking stays confirmed", async function () {
    const { adapters, lifecycle } = lifecycleOver(
      { bookings: [booking({ status: "payment_due", priceEur: 120 })] },
      { failOn: ["issue"] },
    );

    const paid = await lifecycle.pay(TENANT, "B-1", {
      trigger: TRIGGER.PAYMENT,
    });

    expect(paid.status).to.equal("confirmed");
    expect(provisionRows(paid)).to.include(
      "provision admission.issue recorded",
    );
    expect(adapters.store.rows.get("B-1").status).to.equal("confirmed");
  });

  it("invalidates at a cancellation, after the access is revoked", async function () {
    const { adapters, lifecycle } = lifecycleOver({
      bookings: [booking({ status: "confirmed" })],
    });

    const outcome = await lifecycle.cancel(TENANT, "B-1", {
      trigger: TRIGGER.ADMIN,
      reason: "Doppelt gebucht",
    });

    expect(outcome.status).to.equal("cancelled");
    expect(provisionRows(outcome)).to.deep.equal([
      "provision access.revoke ok",
      "provision admission.invalidate ok",
    ]);
    expect(callsOf(adapters)).to.deep.equal([
      ["invalidate", TENANT, "B-1", "booking_cancelled"],
    ]);
  });

  it("issues again at a reinstatement: the service restores the invalidated ones", async function () {
    const { adapters, lifecycle } = lifecycleOver({
      bookings: [booking({ status: "confirmed" })],
    });
    await lifecycle.cancel(TENANT, "B-1", { trigger: TRIGGER.ADMIN });

    const outcome = await lifecycle.reinstate(TENANT, "B-1", {
      trigger: TRIGGER.ADMIN,
    });

    expect(outcome.status).to.equal("confirmed");
    expect(callsOf(adapters)).to.deep.equal([
      ["invalidate", TENANT, "B-1", "booking_cancelled"],
      ["issue", TENANT, "B-1"],
    ]);
  });

  it("invalidates at an accepted withdrawal", async function () {
    const { adapters, lifecycle } = lifecycleOver({
      bookings: [booking({ status: "confirmed" })],
    });

    await lifecycle.acceptWithdrawal(TENANT, "B-1", {
      trigger: TRIGGER.ADMIN,
    });

    expect(callsOf(adapters)).to.deep.equal([
      ["invalidate", TENANT, "B-1", "booking_withdrawn"],
    ]);
  });

  it("invalidates before a deletion removes the booking; the admissions stay", async function () {
    const { adapters, deletion } = lifecycleOver({
      bookings: [booking({ status: "confirmed" })],
    });

    await deletion.remove(TENANT, "B-1");

    expect(callsOf(adapters)).to.deep.equal([
      ["invalidate", TENANT, "B-1", "booking_deleted"],
    ]);
    expect(adapters.store.rows.has("B-1")).to.equal(false);
  });

  it("stops a deletion whose invalidation fails: the booking stands", async function () {
    const { adapters, deletion } = lifecycleOver(
      { bookings: [booking({ status: "confirmed" })] },
      { failOn: ["invalidate"] },
    );

    let error = null;
    try {
      await deletion.remove(TENANT, "B-1");
    } catch (err) {
      error = err;
    }

    expect(error?.message).to.equal("admission.invalidate failed (simulated)");
    expect(adapters.store.rows.has("B-1")).to.equal(true);
  });

  it("issues per member of a group that books the tariff, and for no other member", async function () {
    const member = (id, items) =>
      booking({ id, groupBookingId: "G-1", bookableItems: items });
    const adapters = inMemoryAdapters({
      bookings: [
        member("B-1", [
          { bookableId: "season", amount: 1, _bookableUsed: SEASON },
        ]),
        member("B-2", [
          { bookableId: "room", amount: 1, _bookableUsed: { type: "room" } },
        ]),
      ],
      groups: [
        {
          id: "G-1",
          tenantId: TENANT,
          bookingIds: ["B-1", "B-2"],
          mail: "erika@example.test",
          assignedUserId: "user-1",
          hooks: [],
        },
      ],
    });
    adapters.admission = recordingAdapter("admission", ["issue", "invalidate"]);
    const lifecycle = createGroupBookingLifecycle(adapters);

    const outcome = await lifecycle.confirm(TENANT, "G-1", {
      trigger: TRIGGER.ADMIN,
    });

    expect(provisionRows(outcome)).to.deep.equal([
      "provision access.provision B-1 ok",
      "provision access.provision B-2 ok",
      "provision admission.issue B-1 ok",
    ]);
    expect(callsOf(adapters)).to.deep.equal([["issue", TENANT, "B-1"]]);

    await lifecycle.cancel(TENANT, "G-1", { trigger: TRIGGER.ADMIN });
    expect(callsOf(adapters)).to.deep.equal([
      ["issue", TENANT, "B-1"],
      ["invalidate", TENANT, "B-1", "booking_cancelled"],
    ]);
  });
});
