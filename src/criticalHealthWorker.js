const config = require("./config");
const { initDb } = require("./db");
const { createScheduledJob } = require("./scheduler");
const { runCriticalHealthPollingJob } = require("./workerJobs");

async function startCriticalHealthWorker() {
  const db = await initDb();
  const job = createScheduledJob("Optimism critical health polling", config.worker.criticalHealthIntervalMs, async () => {
    return runCriticalHealthPollingJob(db);
  });

  console.log("[health:critical] Optimism critical health worker starting.");
  console.log(`[health:critical] Interval: ${config.worker.criticalHealthIntervalMs}ms.`);
  console.log(`[health:critical] Threshold: liquidation_utilization_bps>${config.worker.criticalHealthThresholdBps}.`);
  job.start();

  async function shutdown(signal) {
    console.log(`[health:critical] Received ${signal}; stopping critical health worker.`);
    job.stop();
    await db.close();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  return { db, job };
}

if (require.main === module) {
  startCriticalHealthWorker().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { startCriticalHealthWorker };
