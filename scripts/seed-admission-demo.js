#!/usr/bin/env node
/**
 * Seeds a demo of the admissions (docs/admission.md) into a tenant, over
 * the API of a running backend - nothing is written to the database
 * directly, so the bookings run the real checkout and booking lifecycle:
 *
 *   - the facility "Freibad" (capacity 1000, reset 03:00, exit scan on)
 *   - four tariffs under it: "Saisonkarte Erwachsene" (unlimited, season
 *     window 01.05.-15.09., block time 180 min), "10er-Karte" (quota 10,
 *     365 days), "Familienkarte" (bundle of 4, unlimited, season), and
 *     "Tageskarte" (single, the booked day, at most 600 a day)
 *   - the device "Eingang Nord" at the facility; its token is printed once
 *   - one booking per tariff, released on different ways (manual and
 *     confirmed, requested then confirmed then paid), and the codes of
 *     their admissions
 *
 * Run again, it reuses what exists by title and creates the rest. It needs
 * a tenant owner (the device is the owner's) and `ADMISSION_CODE_SECRET`
 * on the backend.
 *
 *   BILETADO_API=http://127.0.0.1:8081 BILETADO_TENANT=<tenant id> \
 *   BILETADO_USER=<mail> BILETADO_PASSWORD=<password> \
 *   [SEASON_YEAR=2027] [FACILITY_TITLE="Freibad am See"] \
 *   node scripts/seed-admission-demo.js
 */

const API = process.env.BILETADO_API || "http://127.0.0.1:8081";
const TENANT = process.env.BILETADO_TENANT;
const USER = process.env.BILETADO_USER;
const PASSWORD = process.env.BILETADO_PASSWORD;
const FACILITY_TITLE = process.env.FACILITY_TITLE || "Freibad am See";
const DEVICE_LABEL = "Eingang Nord";

/** The next season whose end has not passed, unless one is named. */
function seasonYear() {
  if (process.env.SEASON_YEAR) {
    return Number(process.env.SEASON_YEAR);
  }
  const now = new Date();
  const end = new Date(now.getFullYear(), 8, 15, 23, 59);
  return now > end ? now.getFullYear() + 1 : now.getFullYear();
}

let accessToken = null;

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  if (!res.ok) {
    throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 500)}`);
  }
  return data;
}

const tenantPath = (path) => `/api/${TENANT}${path}`;

function price(priceEur) {
  return [
    {
      priceEur,
      interval: { start: null, end: null },
      fixedPrice: true,
      holidays: [],
      weekdays: [],
    },
  ];
}

async function upsertBookable(existing, fields) {
  const found = existing.find((b) => b.title === fields.title);
  if (found) {
    const merged = { ...found, ...fields, id: found.id };
    await call("PUT", tenantPath("/bookables"), merged);
    console.log(`  bookable updated: ${fields.title} (${found.id})`);
    return merged;
  }
  const created = await call("POST", tenantPath("/bookables"), fields);
  console.log(`  bookable created: ${fields.title} (${created.id})`);
  return created;
}

/** A day from its first to its last minute, the period a day ticket is booked for. */
function dayOf(date) {
  const begin = new Date(date);
  begin.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 0, 0);
  return { timeBegin: begin.getTime(), timeEnd: end.getTime() };
}

function today() {
  return dayOf(new Date());
}

/**
 * The day as a time period of the day ticket, every weekday: its own
 * `amount` counts the bookings of the booked day only, so it is a contingent
 * per day. The slot is generated in the backend's local time, and `dayOf`
 * books it in the local time of this script: both must run in one time zone.
 */
const WHOLE_DAY = {
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  startTime: "00:00",
  endTime: "23:59",
};

/**
 * The facility's `relatedBookableIds` with the tariffs added: the
 * hierarchy that makes them its children, for the issuance (which facility
 * checks a tariff) and the capacity checks of the checkout alike.
 *
 * @param {{ relatedBookableIds?: string[] }} facility
 * @param {{ id: string }[]} tariffs
 * @returns {string[]}
 */
function childrenOf(facility, tariffs) {
  return [
    ...new Set([
      ...(facility.relatedBookableIds || []),
      ...tariffs.map((tariff) => tariff.id),
    ]),
  ];
}

/** The day tickets sold online per day (a contingent of the tariff). */
const DAY_TICKETS_PER_DAY = 600;

/** The structural capacity of the pool, its `amount`. */
const FACILITY_CAPACITY = 1000;

async function book(tariff, { status, mail, name }) {
  return call("POST", tenantPath("/bookings"), {
    ...today(),
    bookableItems: [{ bookableId: tariff.id, amount: 1 }],
    name,
    mail,
    street: "Wiesenburger Straße 6",
    zipCode: "14806",
    location: "Seestadt",
    paymentProvider: "invoice",
    status,
    // A booking born confirmed is paid: the form names how and when.
    ...(status === "confirmed"
      ? { paymentMethod: "cash", timePaid: Date.now() }
      : {}),
    comment: "Demo Einlass (seed-admission-demo.js)",
  });
}

/**
 * The four tariffs of the facility, by key. They become its children by
 * `childrenOf`: a parent lists its children in `relatedBookableIds`.
 *
 * @param {{ from: string, to: string }} season
 */
function tariffFields(season) {
  const ticket = (title, priceEur, admission, fields = {}) => ({
    title,
    type: "ticket",
    isBookable: true,
    isPublic: true,
    autoCommitBooking: false,
    priceType: "per-item",
    priceCategories: price(priceEur),
    requiredFields: [],
    admission: { enabled: true, ...admission },
    ...fields,
  });

  return {
    season: ticket("Saisonkarte Erwachsene", 60, {
      validity: { mode: "window", ...season },
      usage: { mode: "unlimited" },
      blockMinutes: 180,
      personalized: true,
      capacityCheck: "entry",
    }),
    tenVisits: ticket("10er-Karte", 35, {
      validity: { mode: "duration", days: 365 },
      usage: { mode: "quota", quota: 10 },
      blockMinutes: 0,
      capacityCheck: "entry",
    }),
    family: ticket("Familienkarte", 140, {
      validity: { mode: "window", ...season },
      usage: { mode: "unlimited" },
      blockMinutes: 180,
      admissionsPerUnit: 4,
      capacityCheck: "entry",
    }),
    day: ticket(
      "Tageskarte",
      4,
      {
        validity: { mode: "booking" },
        usage: { mode: "single" },
        blockMinutes: 0,
        capacityCheck: "booking",
      },
      {
        amount: DAY_TICKETS_PER_DAY,
        isTimePeriodRelated: true,
        timePeriods: [WHOLE_DAY],
      },
    ),
  };
}

async function main() {
  if (!TENANT || !USER || !PASSWORD) {
    console.error(
      "BILETADO_TENANT, BILETADO_USER and BILETADO_PASSWORD are required",
    );
    process.exit(2);
  }
  const year = seasonYear();
  const season = { from: `${year}-05-01`, to: `${year}-09-15` };

  const session = await call("POST", "/auth/signin", {
    id: USER,
    password: PASSWORD,
  });
  accessToken = session.accessToken;
  console.log(`signed in as ${USER}, season ${season.from} - ${season.to}`);

  const existing = await call("GET", tenantPath("/bookables"));

  const facility = await upsertBookable(existing, {
    title: FACILITY_TITLE,
    type: "event-location",
    description:
      "Einrichtung mit Einlassprüfung: selbst nicht buchbar, die Tarife sind ihre Eintrittskarten.",
    isBookable: false,
    isPublic: true,
    amount: FACILITY_CAPACITY,
    admissionFacility: {
      enabled: true,
      resetTime: "03:00",
      exitScan: true,
      maxStayMinutes: null,
      timezone: "Europe/Berlin",
    },
  });

  const tariffs = {};
  for (const [key, fields] of Object.entries(tariffFields(season))) {
    tariffs[key] = await upsertBookable(existing, fields);
  }
  await upsertBookable([facility], {
    title: facility.title,
    relatedBookableIds: childrenOf(facility, Object.values(tariffs)),
  });

  const devices = await call("GET", tenantPath("/admission/devices"));
  const device = devices.find(
    (d) => d.label === DEVICE_LABEL && d.facilityId === facility.id,
  );
  if (device) {
    console.log(
      `device exists: ${DEVICE_LABEL} (${device.id}), token not shown again - renew with POST /admission/devices/${device.id}/token`,
    );
  } else {
    const created = await call("POST", tenantPath("/admission/devices"), {
      facilityId: facility.id,
      label: DEVICE_LABEL,
    });
    console.log(`device created: ${DEVICE_LABEL} (${created.device.id})`);
    console.log(`DEVICE_TOKEN=${created.token}`);
  }

  const bookings = [];
  // The manual booking of the administration, binding at once.
  for (const [key, who] of [
    ["season", { name: "Erika Muster", mail: "erika@example.org" }],
    ["family", { name: "Familie Muster", mail: "familie@example.org" }],
    ["day", { name: "Max Muster", mail: "max@example.org" }],
  ]) {
    const created = await book(tariffs[key], { status: "confirmed", ...who });
    bookings.push({ key, id: created.id, way: "manual, confirmed" });
  }
  // A request, confirmed by the administration, then paid.
  const request = await book(tariffs.tenVisits, {
    status: "requested",
    name: "Anna Beispiel",
    mail: "anna@example.org",
  });
  await call("GET", tenantPath(`/bookings/${request.id}/commit`));
  await call("POST", tenantPath(`/bookings/${request.id}/pay`), {
    paymentMethod: "cash",
  });
  bookings.push({
    key: "tenVisits",
    id: request.id,
    way: "requested, confirmed, paid",
  });

  console.log("bookings and their admissions:");
  for (const booking of bookings) {
    const admissions = await call(
      "GET",
      tenantPath(`/admission/admissions?bookingId=${booking.id}`),
    );
    console.log(
      `  ${tariffs[booking.key].title} - ${booking.id} (${booking.way})`,
    );
    for (const admission of admissions) {
      const one = await call(
        "GET",
        tenantPath(`/admission/admissions/${admission.id}`),
      );
      console.log(
        `    ${one.kind}${one.memberIndex ? ` ${one.memberIndex}` : ""}: ${one.code}  [${one.state}]`,
      );
    }
  }
  console.log(`facility: ${facility.id}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = {
  DAY_TICKETS_PER_DAY,
  childrenOf,
  FACILITY_CAPACITY,
  dayOf,
  tariffFields,
};
