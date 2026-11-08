/**
 * The catalogue of the role: the one place that names the seven groups a
 * role grants and the seven levels of each (glossary "Rollengruppe",
 * "Rollenstufe"; ticket 05 of the authorization map, ADR 0004). The role
 * schema builds its boolean blocks from it, `UserManager` merges the roles
 * of a membership over it, and the rights table checks its levels against
 * it: a new group or level is added here and nowhere else.
 *
 * Its own file, because the role entity loads the schema and the schema
 * loads the catalogue.
 */

const ROLE_GROUPS = Object.freeze([
  "manageUsers",
  "manageBookables",
  "manageBookings",
  "manageCoupons",
  "manageMedia",
  "manageRoles",
  // The admissions at the entrance (German "Zugangsberechtigung"):
  // `create` checks them in and out - the narrow right of the entrance
  // staff, without bookings, users, tariffs or payments -,
  // `readAny` reads them with their usage logs, `updateAny` corrects them.
  "manageAdmissions",
]);

const ROLE_LEVELS = Object.freeze([
  "create",
  "readAny",
  "readOwn",
  "updateAny",
  "updateOwn",
  "deleteAny",
  "deleteOwn",
]);

module.exports = { ROLE_GROUPS, ROLE_LEVELS };
