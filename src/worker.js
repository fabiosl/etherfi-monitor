const config = require("./config");
const { evaluateAlerts } = require("./alerts");
const { discoverOptimismBorrowActivity } = require("./borrowActivityDiscovery");
const { claimSafesForHealth, initDb, releaseLease } = require("./db");
const { writeLocalAggregateSnapshot } = require("./localAggregates");
const { createPagerDutyClient } = require("./pagerDuty");
const { pollSafes } = require("./rpcHealth");
const { createScheduledJob } = require("./scheduler");

async function startWorker() {
  const db = await initDb();
  const pagerDuty = createPagerDutyClient();

  const jobs = [
    createScheduledJob("Optimism borrow discovery", config.worker.borrowDiscoveryIntervalMs, async () => {
      return discoverOptimismBorrowActivity(db);
    }),
    createScheduledJob("Optimism active-safe health polling", config.worker.healthPollIntervalMs, async () => {
      const safes = await claimSafesForHealth(db, config.worker.healthPollBatchSize, {
        chainId: config.optimism.chainId,
        lookbackHours: config.worker.activeSafeLookbackHours,
        activeOnly: true
      });
      if (!safes.length) return { status: "success", polled: 0 };
      try {
        const results = await pollSafes(db, safes);
        await writeLocalAggregateSnapshot(db);
        return {
          status: "success",
          polled: results.length,
          failed: results.filter((row) => row.data_quality_state === "rpc_failed").length
        };
      } finally {
        for (const safe of safes) {
          await releaseLease(db, `safe-health:${safe.chain_id}:${safe.safe_address}`);
        }
      }
    }),
    createScheduledJob("alert evaluation", config.worker.alertIntervalMs, async () => {
      await db.reload();
      const result = await evaluateAlerts(db, { pagerDuty });
      await db.save();
      return result;
    })
  ];

  console.log("[worker] EtherFi monitor worker starting.");
  console.log("[worker] Network scope: Optimism only.");
  console.log(`[worker] Borrow discovery interval: ${config.worker.borrowDiscoveryIntervalMs}ms.`);
  console.log(`[worker] Health polling interval: ${config.worker.healthPollIntervalMs}ms.`);
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
