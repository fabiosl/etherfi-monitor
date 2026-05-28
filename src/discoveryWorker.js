const config = require("./config");
const { initDb } = require("./db");
const { createScheduledJob } = require("./scheduler");
const { runBorrowDiscoveryJob } = require("./workerJobs");

async function startDiscoveryWorker() {
  const db = await initDb();
  const job = createScheduledJob("Optimism borrow discovery", config.worker.borrowDiscoveryIntervalMs, async () => {
    return runBorrowDiscoveryJob(db);
  });

  console.log("[discovery] Optimism discovery worker starting.");
  console.log(`[discovery] Interval: ${config.worker.borrowDiscoveryIntervalMs}ms.`);
  console.log(`[discovery] Active safe lookback: ${config.worker.activeSafeLookbackHours}h.`);
  job.start();

  async function shutdown(signal) {
    console.log(`[discovery] Received ${signal}; stopping discovery worker.`);
    job.stop();
    await db.close();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  return { db, job };
}

if (require.main === module) {
  startDiscoveryWorker().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { startDiscoveryWorker };
