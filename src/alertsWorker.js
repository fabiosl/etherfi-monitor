const config = require("./config");
const { initDb } = require("./db");
const { createPagerDutyClient } = require("./pagerDuty");
const { createScheduledJob } = require("./scheduler");
const { runAlertEvaluationJob } = require("./workerJobs");

async function startAlertsWorker() {
  const db = await initDb();
  const pagerDuty = createPagerDutyClient();
  const job = createScheduledJob("alert evaluation", config.worker.alertIntervalMs, async () => {
    return runAlertEvaluationJob(db, { pagerDuty });
  });

  console.log("[alerts] Alert evaluation worker starting.");
  console.log(`[alerts] Interval: ${config.worker.alertIntervalMs}ms.`);
  console.log(`[alerts] PagerDuty dispatch: ${pagerDuty ? "enabled" : "disabled"}.`);
  job.start();

  async function shutdown(signal) {
    console.log(`[alerts] Received ${signal}; stopping alert evaluation worker.`);
    job.stop();
    await db.close();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  return { db, job };
}

if (require.main === module) {
  startAlertsWorker().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { startAlertsWorker };
