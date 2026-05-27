const config = require("./config");
const { evaluateAlerts } = require("./alerts");
const { refreshAllCollateral } = require("./collateralRefresh");
const { initDb } = require("./db");
const { createPagerDutyClient } = require("./pagerDuty");
const { createScheduledJob } = require("./scheduler");

function startWorker() {
  const db = initDb();
  const pagerDuty = createPagerDutyClient();

  const jobs = [
    createScheduledJob("alert evaluation", config.worker.alertIntervalMs, async () => {
      db.reload();
      const result = await evaluateAlerts(db, { pagerDuty });
      db.save();
      return result;
    }),
    createScheduledJob("collateral refresh", config.worker.collateralIntervalMs, async () => {
      db.reload();
      return refreshAllCollateral(db);
    })
  ];

  console.log("[worker] EtherFi monitor worker starting.");
  console.log(`[worker] Alert evaluation interval: ${config.worker.alertIntervalMs}ms.`);
  console.log(`[worker] Collateral refresh interval: ${config.worker.collateralIntervalMs}ms.`);
  console.log(`[worker] PagerDuty dispatch: ${pagerDuty ? "enabled" : "disabled"}.`);
  for (const job of jobs) job.start();

  function shutdown(signal) {
    console.log(`[worker] Received ${signal}; stopping schedules.`);
    for (const job of jobs) job.stop();
    db.close();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  return { db, jobs };
}

if (require.main === module) {
  startWorker();
}

module.exports = { startWorker };
