const express = require("express");
const router = express.Router({ mergeParams: true });
const {
  authorize,
  tokenAuthorized,
} = require("../../../commons/services/authorization");
const AdmissionController = require("../controllers/admission-controller");

// The device routes: an admission device authorizes itself with
// its own token (`Authorization: Bearer adm.<id>.<secret>`), bound to one
// facility; the handler authenticates it and counts the call against the
// device's rate limit, as every token-authorized route checks its secret.
router.post("/check", tokenAuthorized(), AdmissionController.deviceEntry);
router.post("/exit", tokenAuthorized(), AdmissionController.deviceExit);
router.get("/device", tokenAuthorized(), AdmissionController.deviceStatus);

// The check view of the entrance staff, signed in: `manageAdmissions.create`
// alone, no bookings, users, tariffs or payments.
router.post(
  "/facilities/:facilityId/check",
  authorize("admission", "check"),
  AdmissionController.staffCheck,
);
router.get(
  "/facilities/:facilityId/checked-in",
  authorize("admission", "check"),
  AdmissionController.checkedIn,
);
router.get(
  "/facilities/:facilityId/checks",
  authorize("admission", "check"),
  AdmissionController.recentChecks,
);
router.get(
  "/facilities/:facilityId/reset-runs",
  authorize("admission", "read"),
  AdmissionController.resetRuns,
);

// The administration of the admissions.
router.get(
  "/admissions",
  authorize("admission", "read"),
  AdmissionController.getAdmissions,
);
router.get(
  "/admissions/:id",
  authorize("admission", "read"),
  AdmissionController.getAdmission,
);
router.post(
  "/admissions/:id/corrections",
  authorize("admission", "correct"),
  AdmissionController.correctAdmission,
);

// The devices and their tokens: the tenant owner's.
router.get(
  "/devices",
  authorize("admissionDevice", "read"),
  AdmissionController.getDevices,
);
router.post(
  "/devices",
  authorize("admissionDevice", "manage"),
  AdmissionController.createDevice,
);
router.post(
  "/devices/:id/token",
  authorize("admissionDevice", "manage"),
  AdmissionController.renewDeviceToken,
);
router.post(
  "/devices/:id/block",
  authorize("admissionDevice", "manage"),
  AdmissionController.blockDevice,
);
router.post(
  "/devices/:id/unblock",
  authorize("admissionDevice", "manage"),
  AdmissionController.unblockDevice,
);

module.exports = router;
