/**
 * The admission adapter of the booking lifecycle seam: `AdmissionService`
 * behind the two operations the lifecycle knows. Both are recorded, never
 * aborting: a booking that became binding stays binding when its
 * admissions could not be issued, and the failure stands in the outcome
 * and the log. The lifecycle declares them only for a booking that books
 * a tariff with admissions (`hasAdmissionPositions`).
 */

const { AdmissionService } = require("../../admission/admission-service");

const admission = {
  /** Issues the admissions of a booking that became binding. */
  async issue(tenantId, booking) {
    return await AdmissionService.issueForBooking(tenantId, booking);
  },

  /** Sets the admissions of a booking invalid, their log kept. */
  async invalidate(tenantId, booking, reason) {
    return await AdmissionService.invalidateForBooking(
      tenantId,
      booking.id,
      reason,
    );
  },
};

module.exports = admission;
