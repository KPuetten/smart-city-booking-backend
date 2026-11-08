#!/usr/bin/env node
/**
 * Seeds a showcase of the admissions (docs/admission.md) into a fresh
 * tenant: an outdoor pool on a day of its season, for screenshots and
 * demonstrations. Where `seed-admission-demo.js` leaves every admission
 * issued and unused, this one gives them a history - the day before and the
 * morning of the showcase day, with the states that follow from it.
 *
 * Two parts:
 *
 *   1. Over the API of a running backend, as the demo seed: the facility
 *      "Freibad am See" (capacity 1000), its four tariffs as its children
 *      (`tariffFields` of the demo seed: season ticket unlimited 01.05.-15.09.
 *      with block time 180 min and personal binding, ten-visit card, family
 *      card of four, day ticket at most 600 a day), the devices "Eingang Nord"
 *      and "Kasse Süd", and the bookings of the guests below, so the
 *      admissions are issued by the real checkout and booking lifecycle
 *      (at the time the script runs: bought in advance). One booking is
 *      cancelled over the API, its admission is invalid.
 *   2. In this process, against the database of `.env` (`DB_URL`,
 *      `ADMISSION_CODE_SECRET`): the checks, corrections and daily resets of
 *      the showcase, through the same services the API calls
 *      (`AdmissionCheckService.check`, `AdmissionService.correct`,
 *      `AdmissionResetService.runFacility`), each at its own time. The API
 *      takes no time from outside, the services do (`now`), so every entry
 *      of the usage log and of the check log is decided by the real rules,
 *      at 10:05 instead of whenever the script runs. Nothing is written
 *      around them.
 *
 * The showcase ends at `SHOWCASE_UNTIL` on `SHOWCASE_DAY` (default 10:15 on
 * 15 July of the next season, a Thursday in 2027). Checked at a later time
 * the history stays as it is; checked before it, it lies in the future -
 * the backend's own reset only checks out who entered before its due time.
 * For screenshots the backend's clock is meant to stand just after it.
 *
 * Refuses a tenant whose facility has admissions already: run it on a
 * fresh tenant (the owner signs in, the devices are the owner's).
 *
 *   BILETADO_API=http://127.0.0.1:8081 BILETADO_TENANT=<tenant id> \
 *   BILETADO_USER=<mail> BILETADO_PASSWORD=<password> \
 *   [SEASON_YEAR=2027] [SHOWCASE_DAY=2027-07-15] [SHOWCASE_UNTIL=10:15] \
 *   [SHOWCASE_OUT=<file for the codes as JSON>] \
 *   node scripts/seed-admission-showcase.js
 *
 * It prints the token of "Eingang Nord" once and the codes of the admissions
 * the screenshots scan; both are credentials at the entrance.
 */

const fs = require("fs");
const { DateTime } = require("luxon");
const {
  FACILITY_CAPACITY,
  childrenOf,
  dayOf,
  tariffFields,
} = require("./seed-admission-demo");

const API = process.env.BILETADO_API || "http://127.0.0.1:8081";
const TENANT = process.env.BILETADO_TENANT;
const USER = process.env.BILETADO_USER;
const PASSWORD = process.env.BILETADO_PASSWORD;
const ZONE = "Europe/Berlin";

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
  if (!res.ok) {
    throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 500)}`);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

const tenantPath = (path) => `/api/${TENANT}${path}`;

/** A local day and time of the pool as epoch ms. */
function at(day, time) {
  return DateTime.fromISO(`${day}T${time}`, { zone: ZONE }).toMillis();
}

function shiftDay(day, days) {
  return DateTime.fromISO(day, { zone: ZONE })
    .plus({ days })
    .toFormat("yyyy-MM-dd");
}

/**
 * The guests: who bought what. `day` books a day ticket for that day,
 * relative to the showcase day (0) - every other tariff ignores it.
 */
const GUESTS = [
  { ref: "season1", tariff: "season", name: "Jana Krüger" },
  { ref: "season2", tariff: "season", name: "Thomas Wendt" },
  { ref: "season3", tariff: "season", name: "Merve Aydın" },
  { ref: "season4", tariff: "season", name: "Paul Schreiber" },
  { ref: "season5", tariff: "season", name: "Lea Hoffmann" },
  { ref: "season6", tariff: "season", name: "Uwe Brandt" },
  { ref: "family", tariff: "family", name: "Familie Neumann" },
  { ref: "ten1", tariff: "tenVisits", name: "Sabine Lorenz" },
  { ref: "ten2", tariff: "tenVisits", name: "Karl Becker" },
  { ref: "day1", tariff: "day", day: -1, name: "Max Richter" },
  { ref: "day2", tariff: "day", day: 0, name: "Nina Vogel" },
  { ref: "day3", tariff: "day", day: -2, name: "Ole Peters" },
  { ref: "day4", tariff: "day", day: 0, name: "Emil Schulz" },
  { ref: "day5", tariff: "day", day: 1, name: "Ida Winter" },
];

/** Cancelled after the purchase: its admission is invalid. */
const CANCELLED = { ref: "season5", reason: "Versehentlich doppelt gekauft" };

/**
 * The history, by local time, relative to the showcase day: `d` is the
 * offset in days, `who` an admission (`ref`, or `ref:<member>` for a person
 * of the family card, `ref:bundle` for its parent ticket). Sorted and run in
 * order, so every check sees what the earlier ones wrote.
 */
function history() {
  const events = [];
  const scan = (d, time, direction, who, device = "north") =>
    events.push({ d, time, kind: "scan", direction, who, device });
  const visit = (d, from, to, who, device = "north") => {
    scan(d, from, "entry", who, device);
    if (to) scan(d, to, "exit", who, device);
  };

  // Earlier visits of the ten-visit cards: one is used up on the day before.
  [-30, -27, -23, -20, -16, -13, -9, -7, -3].forEach((d, i) =>
    visit(
      d,
      `1${i % 2 ? 4 : 0}:${10 + i}`,
      `1${i % 2 ? 6 : 2}:${20 + i}`,
      "ten2",
    ),
  );
  [-10, -8, -6, -3].forEach((d, i) =>
    visit(d, `15:0${i}`, `17:4${i}`, "ten1", "south"),
  );

  // The day before (d = -1).
  events.push({ d: -1, time: "03:00", kind: "reset" });
  visit(-1, "09:02", "11:15", "season6");
  visit(-1, "10:05", "13:40", "season1");
  visit(-1, "10:30", "12:05", "ten2");
  visit(-1, "11:00", "16:40", "day1", "south");
  visit(-1, "11:30", "12:50", "season4");
  scan(-1, "13:14", "entry", "family:bundle");
  for (const member of [1, 2, 3, 4]) {
    scan(-1, `13:1${4 + Math.min(member, 2)}`, "entry", `family:${member}`);
  }
  scan(-1, "15:10", "entry", "season1");
  visit(-1, "16:05", "18:10", "ten1", "south");
  events.push({
    d: -1,
    time: "16:20",
    kind: "correct",
    who: "season4",
    action: "block",
    reason: "Karte als verloren gemeldet, Ersatzkarte an der Kasse ausgestellt",
  });
  visit(-1, "17:20", "18:45", "season6");
  for (const member of [1, 2, 3]) {
    scan(-1, `17:3${member}`, "exit", `family:${member}`);
  }

  // The showcase day (d = 0), the reset at 03:00 checks out who is left.
  events.push({ d: 0, time: "03:00", kind: "reset" });
  scan(0, "09:05", "entry", "forged");
  visit(0, "09:12", null, "season1");
  visit(0, "09:20", null, "day4");
  visit(0, "09:30", "10:05", "day2");
  visit(0, "09:40", "10:02", "season2");
  scan(0, "09:50", "entry", "ten2");
  scan(0, "09:58", "entry", "season4");
  for (const member of [1, 2]) {
    scan(0, `10:1${member}`, "entry", `family:${member}`);
  }
  return events;
}

/** A code with one character changed: refused as forged at step 1. */
function typo(code) {
  const chars = code.split("");
  const i = chars.findIndex((c, index) => index > 5 && /[0-9A-Z]/.test(c));
  chars[i] = chars[i] === "7" ? "8" : "7";
  return chars.join("");
}

async function partApi(year, showcaseDay) {
  const season = { from: `${year}-05-01`, to: `${year}-09-15` };
  const session = await call("POST", "/auth/signin", {
    id: USER,
    password: PASSWORD,
  });
  accessToken = session.accessToken;
  console.log(
    `signed in as ${USER}, season ${season.from} - ${season.to}, showcase ${showcaseDay}`,
  );

  const existing = await call("GET", tenantPath("/bookables"));
  const find = (title) => existing.find((b) => b.title === title);
  const upsert = async (fields) => {
    const found = find(fields.title);
    if (found) {
      await call("PUT", tenantPath("/bookables"), {
        ...found,
        ...fields,
        id: found.id,
      });
      return { ...found, ...fields };
    }
    return call("POST", tenantPath("/bookables"), fields);
  };

  const facility = await upsert({
    title: "Freibad am See",
    type: "event-location",
    description:
      "Freibad mit Einlassprüfung: selbst nicht buchbar, die Tarife sind seine Eintrittskarten.",
    isBookable: false,
    isPublic: true,
    amount: FACILITY_CAPACITY,
    admissionFacility: {
      enabled: true,
      resetTime: "03:00",
      exitScan: true,
      maxStayMinutes: null,
      timezone: ZONE,
    },
  });
  const before = await call(
    "GET",
    tenantPath(`/admission/admissions?facilityId=${facility.id}&limit=1`),
  );
  if (before.length > 0) {
    throw new Error(
      `the facility ${facility.id} has admissions already - run the showcase on a fresh tenant`,
    );
  }

  const tariffs = {};
  for (const [key, fields] of Object.entries(tariffFields(season))) {
    tariffs[key] = await upsert(fields);
  }
  // The tariffs become the facility's children (its `relatedBookableIds`).
  await call("PUT", tenantPath("/bookables"), {
    ...facility,
    relatedBookableIds: childrenOf(facility, Object.values(tariffs)),
  });

  const devices = {};
  let deviceToken = null;
  for (const [key, label] of [
    ["north", "Eingang Nord"],
    ["south", "Kasse Süd"],
  ]) {
    const created = await call("POST", tenantPath("/admission/devices"), {
      facilityId: facility.id,
      label,
    });
    devices[key] = created.device;
    if (key === "north") deviceToken = created.token;
  }

  const admissions = {};
  for (const guest of GUESTS) {
    const day =
      guest.tariff === "day"
        ? dayOf(
            DateTime.fromISO(shiftDay(showcaseDay, guest.day), {
              zone: ZONE,
            }).toJSDate(),
          )
        : dayOf(new Date());
    const booking = await call("POST", tenantPath("/bookings"), {
      ...day,
      bookableItems: [{ bookableId: tariffs[guest.tariff].id, amount: 1 }],
      name: guest.name,
      mail: `${guest.ref}@example.org`,
      street: "Wiesenburger Straße 6",
      zipCode: "14806",
      location: "Seestadt",
      paymentProvider: "invoice",
      status: "confirmed",
      paymentMethod: "cash",
      timePaid: Date.now(),
      comment: "Showcase Einlass (seed-admission-showcase.js)",
    });
    const list = await call(
      "GET",
      tenantPath(`/admission/admissions?bookingId=${booking.id}`),
    );
    for (const item of list) {
      const one = await call(
        "GET",
        tenantPath(`/admission/admissions/${item.id}`),
      );
      const ref =
        one.kind === "bundle"
          ? `${guest.ref}:bundle`
          : one.kind === "member"
            ? `${guest.ref}:${one.memberIndex}`
            : guest.ref;
      admissions[ref] = {
        id: one.id,
        code: one.code,
        bookingId: booking.id,
        name: guest.name,
        tariff: guest.tariff,
      };
    }
  }

  const cancelled = admissions[CANCELLED.ref];
  // The cancellation by the administration ("Stornieren"); `/cancel` is the
  // booker's own.
  await call("POST", tenantPath(`/bookings/${cancelled.bookingId}/reject`), {
    reason: CANCELLED.reason,
  });

  return { facility, tariffs, devices, deviceToken, admissions };
}

async function partHistory(
  { facility, devices, admissions },
  showcaseDay,
  until,
) {
  // The services log every check at `info`; the script says what it did.
  process.env.LOG_LEVEL = process.env.SHOWCASE_LOG_LEVEL || "warn";
  const DatabaseManager = require("../src/commons/utilities/database-manager");
  const {
    AdmissionCheckService,
  } = require("../src/commons/services/admission/admission-check-service");
  const {
    AdmissionService,
  } = require("../src/commons/services/admission/admission-service");
  const {
    AdmissionResetService,
  } = require("../src/commons/services/admission/admission-reset-service");
  const {
    BookableManager,
  } = require("../src/commons/data-managers/bookable-manager");
  const { DOMAIN } = require("../src/commons/services/authorization/reach");
  const {
    normalizeFacility,
  } = require("../src/commons/entities/admission/admission-definition");

  await DatabaseManager.getInstance().connect();
  const stored = await BookableManager.getBookable(facility.id, TENANT, DOMAIN);
  const settings = normalizeFacility(stored.admissionFacility);

  const events = history()
    .map((event) => ({
      ...event,
      at: at(shiftDay(showcaseDay, event.d), event.time),
    }))
    .sort((a, b) => a.at - b.at);
  const end = at(showcaseDay, until);
  const counts = {};
  for (const event of events) {
    if (event.at > end) break;
    if (event.kind === "reset") {
      const run = await AdmissionResetService.runFacility(stored, settings, {
        now: event.at,
        owner: "seed-admission-showcase",
      });
      counts.reset = (counts.reset || 0) + 1;
      console.log(
        `  ${DateTime.fromMillis(event.at, { zone: ZONE }).toFormat("dd.MM. HH:mm")} reset: ${run?.resetCount ?? 0} checked out, ${run?.expiredCount ?? 0} expired`,
      );
      continue;
    }
    if (event.kind === "correct") {
      await AdmissionService.correct(TENANT, admissions[event.who].id, {
        action: event.action,
        reason: event.reason,
        userId: USER,
        now: event.at,
      });
      counts.correct = (counts.correct || 0) + 1;
      continue;
    }
    const code =
      event.who === "forged"
        ? typo(admissions.ten1.code)
        : admissions[event.who].code;
    const answer = await AdmissionCheckService.check({
      tenantId: TENANT,
      facilityId: facility.id,
      code,
      direction: event.direction,
      actor: { deviceId: devices[event.device].id },
      now: event.at,
    });
    const key = `${event.direction} ${answer.result}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  console.log(`history up to ${showcaseDay} ${until}:`, JSON.stringify(counts));
  await DatabaseManager.getInstance().close();
}

async function main() {
  if (!TENANT || !USER || !PASSWORD) {
    console.error(
      "BILETADO_TENANT, BILETADO_USER and BILETADO_PASSWORD are required",
    );
    process.exit(2);
  }
  if (!process.env.DB_URL || !process.env.ADMISSION_CODE_SECRET) {
    console.error(
      "DB_URL and ADMISSION_CODE_SECRET are required (the backend's .env)",
    );
    process.exit(2);
  }
  const year = seasonYear();
  const showcaseDay = process.env.SHOWCASE_DAY || `${year}-07-15`;
  const until = process.env.SHOWCASE_UNTIL || "10:15";

  const seeded = await partApi(year, showcaseDay);
  await partHistory(seeded, showcaseDay, until);

  const states = await call(
    "GET",
    tenantPath(`/admission/admissions?facilityId=${seeded.facility.id}`),
  );
  const byState = {};
  for (const admission of states) {
    byState[admission.state] = (byState[admission.state] || 0) + 1;
  }
  console.log("admissions by state:", JSON.stringify(byState));

  const summary = {
    tenant: TENANT,
    facilityId: seeded.facility.id,
    tariffs: Object.fromEntries(
      Object.entries(seeded.tariffs).map(([key, t]) => [key, t.id]),
    ),
    devices: Object.fromEntries(
      Object.entries(seeded.devices).map(([key, d]) => [key, d.id]),
    ),
    admissions: seeded.admissions,
  };
  if (process.env.SHOWCASE_OUT) {
    fs.writeFileSync(
      process.env.SHOWCASE_OUT,
      JSON.stringify(summary, null, 2),
    );
    console.log(`codes written to ${process.env.SHOWCASE_OUT}`);
  } else {
    for (const [ref, a] of Object.entries(seeded.admissions)) {
      console.log(`  ${ref}: ${a.code}  (${a.name}, ${a.bookingId})`);
    }
  }
  console.log(`DEVICE_TOKEN=${seeded.deviceToken}`);
  console.log(`facility: ${seeded.facility.id}`);
  process.exit(0);
}

if (require.main === module) {
  // The backend's .env, read only when run: part 2 needs its database and
  // its secret.
  require("dotenv").config();
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { GUESTS, history, typo };
