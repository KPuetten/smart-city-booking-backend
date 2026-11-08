# Admissions: entrance check and validity

How a booking of a ticket becomes an admission (German "Zugangsberechtigung"), how an admission is checked at the entrance of a facility, and how the daily reset keeps the presences right. For developers and operators of a facility such as an outdoor pool. The API is documented in OpenAPI (`src/docs/routes/admission.yaml`, `/api-docs`).

Everything lives in:

| Piece      | File                                                                                                                                  | What it is                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Definition | `src/commons/entities/admission/admission-definition.js`                                                                              | The tariff fields `admission` and the facility fields `admissionFacility`, their defaults and validation |
| Admission  | `src/commons/schemas/admissionSchema.js`, `entities/admission/admission.js`, `data-managers/admission-manager.js`                     | The collection `admissions`                                                                              |
| Code       | `src/commons/services/admission/admission-code.js`                                                                                    | Identifier and HMAC signature                                                                            |
| Decision   | `src/commons/services/admission/admission-decision.js`, `admission-reasons.js`                                                        | The pure decision of an entry and an exit, the reasons and their German texts                            |
| Issuance   | `src/commons/services/admission/admission-service.js`, `booking-lifecycle/adapters/admission.js`                                      | Issuance and invalidation over the booking lifecycle, corrections                                        |
| Check      | `src/commons/services/admission/admission-check-service.js`, `data-managers/admission-check-manager.js`                               | One check: decide, write, log, answer                                                                    |
| Devices    | `src/commons/services/admission/admission-device-service.js`, `data-managers/admission-device-manager.js`                             | Device tokens                                                                                            |
| Reset      | `src/commons/services/admission/admission-reset-service.js`, `admission-reset-job.js`, `data-managers/admission-reset-run-manager.js` | The daily reset and its lock                                                                             |
| HTTP       | `src/platform/api/routes/admission.routes.js`, `controllers/admission-controller.js`                                                  | The routes under `/api/:tenant/admission`                                                                |

## 1. Configuration

### A facility

A facility (German "Einrichtung") is a bookable that is not bookable itself (`isBookable: false`), with `amount` as its capacity and the admission settings:

```json
{
  "title": "Freibad am See",
  "type": "event-location",
  "isBookable": false,
  "amount": 1000,
  "admissionFacility": {
    "resetTime": "03:00",
    "exitScan": true,
    "maxStayMinutes": null,
    "timezone": "Europe/Berlin"
  }
}
```

| Field               | Default          | Meaning                                                                                                                     |
| ------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `resetTime`         | `03:00`          | Local time of the daily reset                                                                                               |
| `exitScan`          | `true`           | Whether exits are scanned. Without, step 4 of the check does not apply; only the reset and the stay limit check anybody out |
| `maxStayMinutes`    | `null`           | Stay limit: an admission checked in longer counts as left (automatic exit)                                                  |
| `timezone`          | `Europe/Berlin`  | The time zone of the reset and of the days of use                                                                           |
| `enabled`           | `true`           | `false` switches the facility off without removing its settings                                                             |
| `scheduleChangedAt` | set on the write | When reset time, time zone or `enabled` last changed (epoch ms); stamped by the backend, a value sent is ignored            |

### A tariff

A tariff is a ticket bookable (`type: "ticket"`) whose parent is the facility, with an admission definition. As everywhere in the hierarchy, a parent lists its children in its `relatedBookableIds` (in the administration: the facility's "Hierarchie", its "Kinderobjekte"), so the facility lists its tariffs; the issuance finds a tariff's facility the way the capacity checks of the checkout find its parents (`getAncestorBookables`). A tariff that names the facility in its own `relatedBookableIds` makes the facility its child: no admission of it is bound to the facility, and the checkout does not count it against the facility's `amount`.

| Field               | Default   | Meaning                                                                                                                                   |
| ------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `validity.mode`     | `booking` | `window` (`from`, `to` as `YYYY-MM-DD`, whole days of the facility), `duration` (`days` from the issuance), `booking` (the booked period) |
| `usage.mode`        | `single`  | `single` (one day of use), `unlimited` (every day of the validity), `quota` (`quota` days of use)                                         |
| `blockMinutes`      | `0`       | Block time since the last entry, up to 1440                                                                                               |
| `personalized`      | `false`   | Personal binding: the check points the staff to the photo                                                                                 |
| `admissionsPerUnit` | `1`       | More than 1 makes a bundle: a parent ticket and one admission per person                                                                  |
| `capacityCheck`     | `booking` | `booking` (the existing checks of the checkout), `entry` (at the entrance, against the facility's `amount`), `none`; see below            |

Only a ticket may carry a definition, only a bookable that is no ticket facility settings (`400 validation_failed`, codes `admission_ticket_only`, `admission_facility_not_ticket`). A bookable without either is unchanged.

### When the capacity is checked

`capacityCheck` decides where the facility's `amount` counts for a tariff: season tickets are sold over the structural capacity, so a check at the booking does not hold for every tariff.

| `capacityCheck` | At the checkout                                                                             | At the entrance (step 6)        |
| --------------- | ------------------------------------------------------------------------------------------- | ------------------------------- |
| `booking`       | Every existing check, the facility's `amount` counted over the tickets of `booking` tariffs | None                            |
| `entry`         | Every existing check except the one against the facility's `amount`                         | Against the facility's `amount` |
| `none`          | Every existing check except the one against the facility's `amount`                         | None                            |

The facility is every parent with admission settings (`admissionFacility`, not switched off); a parent without them is checked as before. The same holds for the calendar's availability (`computeWindowAvailability`) and the window check (`checkWindowAvailability`), so a tariff is shown as it is sold. What stays for `entry` and `none`:

- The tariff's own `amount`: a tariff can be sold as a contingent of its own (200 early-bird season tickets, say); left empty it is unlimited.
- The checks that are no capacity: permission, maximum amount per booking, dates, event seats.

For a tariff with `booking` the facility's `amount` counts the tickets of the tariffs that check at the booking - its own and those of its siblings with `booking` - and the facility's own bookings; the tickets of tariffs with `entry` or `none` do not count, the entrance checks the capacity for those (step 6). A ticket without a definition and every bookable under a parent without `admissionFacility` count every sibling as before.

Example: a pool of `amount` 1000 has sold 1500 season tickets (`entry`). Day tickets (`booking`) stay bookable as long as the tickets of the `booking` tariffs alone stay within 1000; the season tickets are checked at the entrance against the 1000. The day ticket of the demo (`scripts/seed-admission-demo.js`) is in addition limited to 600 a day online by its own `amount`: it is booked by a time period of one day (`isTimePeriodRelated`, every weekday 00:00-23:59), and for a bookable with a period `amount` counts only the bookings that overlap the booked period. Without a period `amount` counts every booking of the tariff, so it is a contingent over the whole sale, not per day.

Known limit at the entrance: step 6 counts the admissions checked in and then writes its own entry; the count and the write are not one step across admissions. Scans of different admissions at the same moment each see the count before the others' entries, so the capacity can be passed by at most the number of devices (and members of staff) checking at that moment, minus one. The optimistic lock of an admission does not cover it; it holds per admission only.

Not implemented on purpose: a stop of the sale after the occupancy, from the counter of the admissions checked in. The counter is no occupancy display, and the capacity is not steered by the load; it can be added as an extension.

### Environment

| Variable                                                | Default          | Meaning                                                                                                                                                                            |
| ------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMISSION_CODE_SECRET`                                 | none             | The HMAC secret of the codes, 32 characters at least. Without it nothing is issued or checked (`503 admission_code_secret_missing`). Changing it invalidates every code handed out |
| `ADMISSION_RESET_CHECK_CRON`                            | `* * * * *`      | How often the job looks whether a reset is due                                                                                                                                     |
| `ADMISSION_CHECK_LOG_RETENTION_DAYS`                    | `90`             | How long a check is kept in the check log                                                                                                                                          |
| `RATE_LIMIT_ADMISSION_CHECK_PER_DEVICE`, `..._PER_USER` | `120` per `60` s | Checks per device and per member of staff                                                                                                                                          |

## 2. Data model

`admissions`, one document per admission:

| Field                                                                  | Meaning                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `tenantId`                                                       | Identity; unique together                                                                                                                                                                                                                            |
| `key`                                                                  | The random identifier the code carries; unique per tenant, the index of every scan                                                                                                                                                                   |
| `bookingId`, `itemIndex`, `unitIndex`, `memberIndex`                   | Where in the booking it comes from; unique together, so an issuance that runs twice inserts nothing twice                                                                                                                                            |
| `bookableId`, `bookableTitle`, `facilityId`                            | The tariff and the facility it is checked at                                                                                                                                                                                                         |
| `kind`, `bundleId`                                                     | `single`, `bundle` (the parent ticket of a bundle, admits nobody) or `member` (one person of a bundle, `bundleId` names the parent)                                                                                                                  |
| `entitlement`                                                          | The definition copied at the issuance: `validFrom`, `validTo` (epoch ms), `usage`, `quota`, `blockMinutes`, `personalized`, `capacityCheck`, `timezone`                                                                                              |
| `state`, `stateBefore`                                                 | See section 3; `stateBefore` is the state a block or an invalidation came from                                                                                                                                                                       |
| `remainingDays`, `usedDays`, `entryCount`, `lastEntryAt`, `lastExitAt` | Counters, derived from the usage log and kept for the check                                                                                                                                                                                          |
| `usage`                                                                | The usage log: `issue`, `entry`, `exit`, `autoExit`, `reset`, `expire`, `block`, `unblock`, `invalidate`, `restore`, `correction`, each with time, day, whether it consumed a day, the states before and after, device or account, reason, reset run |
| `revision`                                                             | Bumped by every write; a check and a correction write on the revision they decided on                                                                                                                                                                |

`admissionchecks` holds every check at an entrance, granted or denied, with the answer (TTL by `expiresAt`). `admissiondevices` the devices (only the SHA-256 of a token). `admissionresetruns` one row per facility and due reset (the lock and the record).

The entitlement is a copy, never a live reference: it is taken from the tariff as the booking holds it (`bookableItems[]._bookableUsed`), so a tariff changed in mid-season changes no admission sold before.

## 3. States

| State      | Meaning                                                            | Entered by                                                                        |
| ---------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `issued`   | Issued, never used                                                 | Issuance; a correction that takes the only entry back                             |
| `present`  | Checked in, no exit since                                          | Granted entry                                                                     |
| `absent`   | Used, checked out                                                  | Exit, reset, stay limit, correction                                               |
| `consumed` | No day of use left; a re-entry on the day last used stays possible | Exit or reset with `remainingDays` 0                                              |
| `expired`  | Past the end of its validity                                       | Daily reset (and refused at the check from `validTo` on, whatever the state says) |
| `blocked`  | Blocked by the administration                                      | Correction `block`; `unblock` restores `stateBefore`                              |
| `invalid`  | The booking was cancelled, withdrawn or deleted                    | Booking lifecycle; a reinstatement restores `stateBefore`                         |

The daily reset passes over a blocked or invalid admission. So `unblock` and a reinstatement restore `stateBefore` as the resets due since would have left it: a presence from before the latest due reset of the facility comes back checked out (`absent`, or `consumed` without a day left, `lastExitAt` the reset's due time), and an admission whose validity ended before that reset comes back `expired`.

The admissions are issued on every way a booking becomes binding: admitted confirmed (automatic release, manual booking, free booking), confirmed by the administration, paid, reinstated. They are set invalid by a cancellation, an accepted withdrawal and the deletion of a booking. Nothing is removed: the admissions and their usage log stay the record of what was issued and used, the deletion of a booking included. The lifecycle declares these steps only for a booking whose positions book a tariff with a definition; every other booking runs the pipeline it ran before.

## 4. The check

### Order

One scan, one decision, in this order; the first step that refuses answers:

| Step | Question                                                                                 | Refusals                                                                              |
| ---- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1    | Is the code an admission's, and unaltered? Of this facility? No bundle's parent ticket?  | `code_malformed`, `code_forged`, `admission_unknown`, `wrong_facility`, `bundle_code` |
| 2    | Is the admission valid?                                                                  | `admission_invalid`, `admission_blocked`, `not_yet_valid`, `expired`                  |
| 3    | Does its usage allow an entry? A re-entry on a day already used consumes nothing         | `already_used` (single), `quota_exhausted`                                            |
| 4    | Is it checked out (where exits are scanned)? An entry past the stay limit counts as left | `already_present`                                                                     |
| 5    | Has the block time since the last entry passed? Also after an exit                       | `block_time`                                                                          |
| 6    | Has the facility room, where the tariff checks at the entry?                             | `capacity_reached`                                                                    |

The result is `granted`, `granted_with_notice` or `denied`, with the step, the reason and the German text for the staff, e.g. `Sperrzeit läuft, erneuter Eintritt ab 11:00 Uhr.` The texts are in `admission-reasons.js`. Notices of a granted entry: `reentry`, `last_day`, `stay_limit_passed`, `recent_denials` (refused checks of the same admission within the hour: a hint, never a decision), `check_photo`. Only a granted check writes the admission; every check is logged.

The exit refuses with `not_present` and, where the facility scans none, `exit_disabled`.

Days of use are calendar days in the facility's time zone.

### The code

The code is 32 characters of the alphabet `0-9 A-H J-N P-X` (no I, O, Y, Z): a random identifier of 100 bits from `crypto.randomBytes`, followed by 60 bits of an HMAC-SHA256 over tenant and identifier with `ADMISSION_CODE_SECRET`. A check verifies the signature before it looks anything up; a code altered in one character, made up, or signed for another tenant is `code_forged`. It is printed in groups of four; spaces, hyphens and lower case are accepted, so a damaged code can be typed in. It has nothing to do with the booking number or the public status page of a booking.

### Sent twice, sent at once

A device may send a `requestId` with each scan. A scan sent again with the same id is answered as the first time, `replayed: true`, without a second effect; the same id for another admission or direction is `409 admission_request_id_reused`. The id is claimed before the decision: the check's row goes into `admissionchecks` as `pending` first, and the index over tenant, device, person and request id is unique. A scan sent again while the first is still decided waits for its answer (up to two seconds, else `503 admission_request_in_progress` with `Retry-After`) instead of deciding anew; a claim abandoned for 30 seconds is taken over, one that came to no decision is given up. Two devices scanning the same admission at the same moment: the second write meets a changed revision, and the check is decided anew on what the first one wrote (`already_present`). It is decided anew up to 25 times, each time after a short random wait (5 ms, doubling up to 50 ms), so scans that met do not meet again at once. A check that meets another write all 25 times is answered `503 admission_check_contended` with `Retry-After: 1` and logged with `result: "error"`; sent again with the same `requestId` it is decided anew.

## 5. Access

### Devices

A device (German "Einlassgerät") is registered by the tenant owner at a facility (`POST /api/:tenant/admission/devices`). The answer carries its token once: `adm.<device id>.<secret>`, 256 random bits; only the SHA-256 of the token is stored. The device sends it as `Authorization: Bearer <token>` to `POST /check`, `POST /exit` and `GET /device`; it checks at its own facility only. A blocked device, a renewed token, the token of another tenant and a made-up one are refused (`401 admission_device_unauthorized`, `403 admission_device_blocked`). Each device is limited to 120 checks a minute (`429` with `Retry-After`).

### Staff and administration

The role catalogue has the group `manageAdmissions`:

| Level                        | Rights table                             | What it allows                                                                                                                                           |
| ---------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manageAdmissions.create`    | `admission.check`                        | Check in and out in the check view, the facility's count and last checks. The whole right of the entrance staff: no bookings, users, tariffs or payments |
| `manageAdmissions.readAny`   | `admission.read`, `admissionDevice.read` | The admissions with their usage log and code, the reset runs, the devices                                                                                |
| `manageAdmissions.updateAny` | `admission.correct`                      | Block, unblock, reset a presence, take an entry back, with a reason                                                                                      |
| tenant owner                 | `admissionDevice.manage`                 | Register devices, renew, block and unblock their tokens                                                                                                  |

The answer of a check names the admission's tariff, state and validity, never the booking or its booker.

## 6. The daily reset

At the reset time of each facility every presence still open is checked out (`present` to `absent`, or `consumed` without a day left) and every admission past its validity expires. It cannot be switched off and runs whatever `RULE_ENGINE_ENABLED` says.

- **Schedule:** a `node-schedule` job looks once a minute and once at the start of the backend (`ADMISSION_RESET_CHECK_CRON`).
- **Catch-up:** at each look the latest due reset of every facility is run unless it ran. After a downtime that is the latest one missed, recorded with `trigger: "catchUp"`; an older one has nothing to add. A reset made up late checks out only who entered before its due time.
- **One a day:** where the clock is set back and the reset time comes twice (02:00-02:59 on the last Sunday of October in Berlin), the first one counts. A reset time changed to an hour already past on a day whose reset ran is not made up: it counts from its next due time (03:00 ran, changed at 14:00 to 10:00: the next reset is tomorrow at 10:00). It is made up where that would leave more than 36 hours between two resets, and a time changed to a later hour of the same day runs at that hour. The time of the change is `scheduleChangedAt` of the facility settings, stamped when the backend stores a changed schedule (not the bookable's `timeUpdated`, which the entity sets whenever it is built).
- **Lock:** a run is claimed by inserting its row into `admissionresetruns` (unique per facility and due time); of several processes one runs it. A failed run, or one whose owner has been silent for 15 minutes, is taken over at the next look.
- **Monitoring:** `GET /api/:tenant/admission/facilities/:facilityId/reset-runs` lists the runs with trigger, owner, status, counts and error; a failure is logged at `error`. A reset that does not run leaves presences open, and step 4 then refuses guests who left without an exit scan: the run list is the thing to watch.

## 7. Counting

`GET /api/:tenant/admission/facilities/:facilityId/checked-in` (and `GET /device`) answers the number of admissions checked in at the facility, derived from their state (`counts: "checked_in_admissions"`). It counts checked-in admissions, not people: nobody without an admission, no staff, and everybody who left without an exit scan until the reset or the stay limit. A steering value for the decision at the entrance, no occupancy display, and no basis for a safety or evacuation concept.

## 8. Demo data

`scripts/seed-admission-demo.js` seeds a facility, four tariffs (season ticket, ten-visit card, family card of four, day ticket), the device "Eingang Nord" and one booking per tariff over the API of a running backend, and prints the codes of their admissions and the device token (once). See the head of the script for its environment.

`scripts/seed-admission-showcase.js` seeds the same facility (capacity 1000) and tariffs into a fresh tenant, with fourteen guests and their history: the visits of the ten-visit cards over the weeks before, the day before the showcase day (entry 10:05, exit 13:40, re-entry 15:10 of a season ticket, a family of four, a card blocked with its reason, the day tickets) and the morning of the showcase day, with the daily resets at 03:00 in between and a few refusals (a mistyped code, a bundle's parent ticket, a card used up, a blocked one). The bookings and one cancellation go over the API; the checks, the correction and the resets run in the script's process through the services (`AdmissionCheckService.check`, `AdmissionService.correct`, `AdmissionResetService.runFacility`), each at its time (`now`), against the database of `.env`. So every entry of the usage and the check log is decided by the rules of section 4, at its hour, and the states follow from them: issued, present, absent, consumed, expired, blocked, invalid. The API takes no time from outside. The showcase ends at `SHOWCASE_UNTIL` (default 10:15) on `SHOWCASE_DAY` (default 15 July of the next season); see the head of the script.

## 9. Not yet

- The ticket as a PDF and its mail, the personal data and the photo of a personal ticket
- The search by name and mail; the admissions are found by facility, tariff, state, booking and code (`?code=`). The admin views (tariff, admissions, devices) live in the admin UI, the check view of a paired device in the storefront
- The amendment of a booking (`amend`) leaves its admissions as they are
- The retention of the usage log itself and the migration of existing tickets and bookings
