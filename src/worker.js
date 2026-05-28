const config = require("./config");
const { initDb } = require("./db");
const { createPagerDutyClient } = require("./pagerDuty");
const { createScheduledJob } = require("./scheduler");
const {
  runAlertEvaluationJob,
  runAssetRiskHealthPollingJob,
  runBorrowDiscoveryJob,
  runCriticalHealthPollingJob,
  runHealthPollingJob
} = require("./workerJobs");

async function startWorker() {
  const db = await initDb();
  const pagerDuty = createPagerDutyClient();

  const jobs = [
    createScheduledJob("Optimism borrow discovery", config.worker.borrowDiscoveryIntervalMs, async () => {
      return runBorrowDiscoveryJob(db);
    }),
    createScheduledJob("Optimism active-safe health polling", config.worker.healthPollIntervalMs, async () => {
      return runHealthPollingJob(db);
    }),
    createScheduledJob("Optimism critical health polling", config.worker.criticalHealthIntervalMs, async () => {
      return runCriticalHealthPollingJob(db);
    }),
    createScheduledJob("alert evaluation", config.worker.alertIntervalMs, async () => {
      return runAlertEvaluationJob(db, { pagerDuty });
    })
  ];
  if (config.worker.assetRiskTokenAddress) {
    jobs.push(createScheduledJob("Optimism asset-risk health polling", config.worker.assetRiskHealthIntervalMs, async () => {
      return runAssetRiskHealthPollingJob(db);
    }));
  }

  console.log("[worker] EtherFi monitor worker starting.");
  console.log("[worker] Network scope: Optimism only.");
  console.log(`[worker] Borrow discovery interval: ${config.worker.borrowDiscoveryIntervalMs}ms.`);
  console.log(`[worker] Health polling interval: ${config.worker.healthPollIntervalMs}ms.`);
  console.log(`[worker] Critical health interval: ${config.worker.criticalHealthIntervalMs}ms.`);
  console.log(`[worker] Asset-risk health: ${config.worker.assetRiskTokenAddress ? `${config.worker.assetRiskHealthIntervalMs}ms for ${config.worker.assetRiskTokenAddress}` : "disabled; set ASSET_RISK_TOKEN_ADDRESS to enable"}.`);
  console.log(`[worker] Alert evaluation interval: ${config.worker.alertIntervalMs}ms.`);
  console.log(`[worker] Active safe lookback: ${config.worker.activeSafeLookbackHours}h.`);
  console.log(`[worker] PagerDuty dispatch: ${pagerDuty ? "enabled" : "disabled"}.`);
  for (const job of jobs) job.start();

  async function shutdown(signal) {
    console.log(`[worker] Received ${signal}; stopping schedules.`);
    for (const job of jobs) job.stop();
    await db.close();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  return { db, jobs };
}

if (require.main === module) {
  startWorker().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { startWorker };
