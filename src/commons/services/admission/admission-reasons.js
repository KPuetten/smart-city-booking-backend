/**
 * Why a check at the entrance was refused, and what a granted one points
 * the staff to. One vocabulary for the device API, the check
 * view and the check log, each code with the German text the staff read
 * at the entrance, so the meaning of every refusal is in one place. The
 * texts are user-facing copy and stay German; a placeholder `{name}` is
 * filled from the params of the answer.
 */

/** The results of a check. */
const CHECK_RESULTS = Object.freeze({
  GRANTED: "granted",
  GRANTED_WITH_NOTICE: "granted_with_notice",
  DENIED: "denied",
});

/** The refusals, by the step of the check order that refuses. */
const DENIAL_REASONS = Object.freeze({
  // Step 1: is the code an admission's, and unaltered?
  CODE_MALFORMED: "code_malformed",
  CODE_FORGED: "code_forged",
  ADMISSION_UNKNOWN: "admission_unknown",
  WRONG_FACILITY: "wrong_facility",
  BUNDLE_CODE: "bundle_code",
  // Step 2: is the admission valid?
  ADMISSION_INVALID: "admission_invalid",
  ADMISSION_BLOCKED: "admission_blocked",
  NOT_YET_VALID: "not_yet_valid",
  EXPIRED: "expired",
  // Step 3: does the usage allow an entry?
  ALREADY_USED: "already_used",
  QUOTA_EXHAUSTED: "quota_exhausted",
  // Step 4: checked out, or an entry without an exit?
  ALREADY_PRESENT: "already_present",
  // Step 5: has the block time passed?
  BLOCK_TIME: "block_time",
  // Step 6: is the facility full?
  CAPACITY_REACHED: "capacity_reached",
  // The exit.
  NOT_PRESENT: "not_present",
  EXIT_DISABLED: "exit_disabled",
});

/** The step of the check order each refusal belongs to. */
const DENIAL_STEP = Object.freeze({
  [DENIAL_REASONS.CODE_MALFORMED]: 1,
  [DENIAL_REASONS.CODE_FORGED]: 1,
  [DENIAL_REASONS.ADMISSION_UNKNOWN]: 1,
  [DENIAL_REASONS.WRONG_FACILITY]: 1,
  [DENIAL_REASONS.BUNDLE_CODE]: 1,
  [DENIAL_REASONS.ADMISSION_INVALID]: 2,
  [DENIAL_REASONS.ADMISSION_BLOCKED]: 2,
  [DENIAL_REASONS.NOT_YET_VALID]: 2,
  [DENIAL_REASONS.EXPIRED]: 2,
  [DENIAL_REASONS.ALREADY_USED]: 3,
  [DENIAL_REASONS.QUOTA_EXHAUSTED]: 3,
  [DENIAL_REASONS.ALREADY_PRESENT]: 4,
  [DENIAL_REASONS.BLOCK_TIME]: 5,
  [DENIAL_REASONS.CAPACITY_REACHED]: 6,
  [DENIAL_REASONS.NOT_PRESENT]: 4,
  [DENIAL_REASONS.EXIT_DISABLED]: 4,
});

/** Why a check came to no decision. */
const CHECK_ERRORS = Object.freeze({
  // Its write kept meeting the writes of other devices.
  CONTENDED: "admission_check_contended",
});

/** What a granted check points the staff to. The decision stays theirs. */
const NOTICES = Object.freeze({
  REENTRY: "reentry",
  LAST_DAY: "last_day",
  CHECK_PHOTO: "check_photo",
  RECENT_DENIALS: "recent_denials",
  STAY_LIMIT_PASSED: "stay_limit_passed",
});

const MESSAGES = Object.freeze({
  [CHECK_RESULTS.GRANTED]: "Eintritt gewährt.",
  exitGranted: "Austritt erfasst.",
  [DENIAL_REASONS.CODE_MALFORMED]:
    "Kein Ticketcode erkannt. Bitte erneut scannen oder die Kennung eingeben.",
  [DENIAL_REASONS.CODE_FORGED]:
    "Code beschädigt oder verändert. Ticket bitte an der Kasse prüfen lassen.",
  [DENIAL_REASONS.ADMISSION_UNKNOWN]: "Unbekannte Zugangsberechtigung.",
  [DENIAL_REASONS.WRONG_FACILITY]:
    "Das Ticket gilt nicht für diese Einrichtung.",
  [DENIAL_REASONS.BUNDLE_CODE]:
    "Sammelticket. Bitte die Einzelcodes der Personen scannen.",
  [DENIAL_REASONS.ADMISSION_INVALID]:
    "Ungültig: Die Buchung wurde storniert oder gelöscht.",
  [DENIAL_REASONS.ADMISSION_BLOCKED]:
    "Gesperrt. Bitte an die Kasse oder die Verwaltung verweisen.",
  [DENIAL_REASONS.NOT_YET_VALID]: "Noch nicht gültig, gültig ab {validFrom}.",
  [DENIAL_REASONS.EXPIRED]: "Abgelaufen, gültig war es bis {validTo}.",
  [DENIAL_REASONS.ALREADY_USED]:
    "Bereits genutzt (Einzeleintritt am {lastDay}).",
  [DENIAL_REASONS.QUOTA_EXHAUSTED]: "Kontingent aufgebraucht.",
  [DENIAL_REASONS.ALREADY_PRESENT]:
    "Bereits eingecheckt, seitdem kein Austritt erfasst.",
  [DENIAL_REASONS.BLOCK_TIME]:
    "Sperrzeit läuft, erneuter Eintritt ab {blockedUntil} Uhr.",
  [DENIAL_REASONS.CAPACITY_REACHED]:
    "Einrichtung voll: {present} von {capacity} Berechtigungen eingecheckt.",
  [DENIAL_REASONS.NOT_PRESENT]:
    "Kein Eintritt erfasst, Austritt nicht möglich.",
  [DENIAL_REASONS.EXIT_DISABLED]:
    "An dieser Einrichtung wird kein Austritt gescannt.",
  [CHECK_ERRORS.CONTENDED]:
    "Prüfung gerade nicht möglich. Bitte erneut scannen.",
  [NOTICES.REENTRY]:
    "Wiedereintritt am selben Tag, kein Kontingent verbraucht.",
  [NOTICES.LAST_DAY]: "Letzter Tag des Kontingents.",
  [NOTICES.CHECK_PHOTO]: "Personengebundenes Ticket: Lichtbild prüfen.",
  [NOTICES.RECENT_DENIALS]:
    "{recentDenials} abgewiesene Versuche mit diesem Ticket in der letzten Stunde.",
  [NOTICES.STAY_LIMIT_PASSED]:
    "Letzter Eintritt ohne Austritt, nach der Aufenthaltsdauer als ausgetreten gewertet.",
});

/**
 * The text of a code with its placeholders filled.
 *
 * @param {string} code A reason, a notice or a result
 * @param {Object} [params]
 * @returns {string}
 */
function messageOf(code, params = {}) {
  const template = MESSAGES[code] ?? code;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    params[name] !== undefined && params[name] !== null
      ? String(params[name])
      : match,
  );
}

module.exports = {
  CHECK_RESULTS,
  CHECK_ERRORS,
  DENIAL_REASONS,
  DENIAL_STEP,
  NOTICES,
  MESSAGES,
  messageOf,
};
