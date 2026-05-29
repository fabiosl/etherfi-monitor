const config = require("./config");
const { initDb } = require("./db");
const { createScheduledJob } = require("./scheduler");
const { runHealthPollingJob } = require("./workerJobs");

async function startHealthWorker() {
  const db = await initDb();
  const job = createScheduledJob("Optimism active-safe health polling", config.worker.healthPollIntervalMs, async () => {
    return runHealthPollingJob(db);
  });

  console.log("[health:active] Optimism active-safe health worker starting.");
  console.log(`[health:active] Interval: ${config.worker.healthPollIntervalMs}ms.`);
  console.log(`[health:active] Active safe lookback: ${config.worker.activeSafeLookbackHours}h.`);
  console.log(`[health:active] Batch size: ${config.worker.healthPollBatchSize}.`);
  job.start();

  async function shutdown(signal) {
    console.log(`[health:active] Received ${signal}; stopping active-safe health worker.`);
    job.stop();
    await db.close();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  return { db, job };
}

if (require.main === module) {
  startHealthWorker().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { startHealthWorker };
