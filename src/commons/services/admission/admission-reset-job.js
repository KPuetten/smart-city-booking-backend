const schedule = require("node-schedule");
const bunyan = require("bunyan");

const { AdmissionResetService } = require("./admission-reset-service");
const { isConfigured } = require("./admission-code");

const logger = bunyan.createLogger({
  name: "admission-reset-job.js",
  level: process.env.LOG_LEVEL,
});

/**
 * The recurring job of the daily reset: once a minute it asks
 * `AdmissionResetService.runDue`, and once right at the start, so a reset
 * missed during a downtime is made up as soon as the backend is back. It
 * uses `node-schedule` like the rule engine but runs whatever
 * `RULE_ENGINE_ENABLED` says: the reset is not optional. The cadence is
 * `ADMISSION_RESET_CHECK_CRON` (default every minute); the reset time
 * itself is the facility's.
 */
const DEFAULT_CRON = "* * * * *";

let job = null;
let ticking = false;

async function tick() {
  if (ticking) {
    return;
  }
  ticking = true;
  try {
    await AdmissionResetService.runDue();
  } catch (err) {
    logger.error({ err }, "admission reset tick failed");
  } finally {
    ticking = false;
  }
}

/**
 * Starts the job; a second call does nothing.
 *
 * @returns {Promise<void>} Resolves after the first look at the start
 */
async function start() {
  if (job) {
    return;
  }
  if (!isConfigured()) {
    logger.warn(
      "ADMISSION_CODE_SECRET is not set (32 characters at least): admissions can be neither issued nor checked",
    );
  }
  let cron = process.env.ADMISSION_RESET_CHECK_CRON || DEFAULT_CRON;
  job = schedule.scheduleJob(cron, tick);
  if (!job) {
    logger.error(
      { cron },
      "invalid ADMISSION_RESET_CHECK_CRON, checking every minute instead",
    );
    cron = DEFAULT_CRON;
    job = schedule.scheduleJob(cron, tick);
  }
  logger.info({ cron }, "admission reset job started");
  await tick();
}

/** Stops the job, for the shutdown. */
function stop() {
  if (job) {
    job.cancel();
    job = null;
  }
}

module.exports = { start, stop, tick };
