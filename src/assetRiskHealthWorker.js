const config = require("./config");
const { initDb } = require("./db");
const { createScheduledJob } = require("./scheduler");
const { runAssetRiskHealthPollingJob } = require("./workerJobs");

async function startAssetRiskHealthWorker() {
  const db = await initDb();
  const tokenAddress = process.argv[2] || config.worker.assetRiskTokenAddress;
  const job = createScheduledJob("Optimism asset-risk health polling", config.worker.assetRiskHealthIntervalMs, async () => {
    return runAssetRiskHealthPollingJob(db, { tokenAddress });
  });

  console.log("[health:asset-risk] Optimism asset-risk health worker starting.");
  console.log(`[health:asset-risk] Interval: ${config.worker.assetRiskHealthIntervalMs}ms.`);
  console.log(`[health:asset-risk] Token: ${tokenAddress || "unset"}.`);
  console.log(`[health:asset-risk] Target slice: top ${config.worker.assetRiskPercent}% riskiest safes holding the token.`);
  job.start();

  async function shutdown(signal) {
    console.log(`[health:asset-risk] Received ${signal}; stopping asset-risk health worker.`);
    job.stop();
    await db.close();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  return { db, job };
}

if (require.main === module) {
  startAssetRiskHealthWorker().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { startAssetRiskHealthWorker };
