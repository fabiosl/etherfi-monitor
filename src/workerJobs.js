const config = require("./config");
const { evaluateAlerts } = require("./alerts");
const { discoverOptimismBorrowActivity } = require("./borrowActivityDiscovery");
const { claimSafesForHealth, releaseLease } = require("./db");
const { writeLocalAggregateSnapshot } = require("./localAggregates");
const { createPagerDutyClient } = require("./pagerDuty");
const { pollSafes } = require("./rpcHealth");

async function runBorrowDiscoveryJob(db, options = {}) {
  return discoverOptimismBorrowActivity(db, options);
}

async function runHealthPollingJob(db, options = {}) {
  const limit = Number(options.limit || config.worker.healthPollBatchSize);
  const safes = await claimSafesForHealth(db, limit, {
    chainId: config.optimism.chainId,
    lookbackHours: config.worker.activeSafeLookbackHours,
    activeOnly: true
  });
  if (!safes.length) return { status: "success", polled: 0, failed: 0 };

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
}

async function runAlertEvaluationJob(db, options = {}) {
  await db.reload();
  const pagerDuty = Object.prototype.hasOwnProperty.call(options, "pagerDuty")
    ? options.pagerDuty
    : createPagerDutyClient();
  const result = await evaluateAlerts(db, { pagerDuty });
  await db.save();
  return result;
}

module.exports = {
  runAlertEvaluationJob,
  runBorrowDiscoveryJob,
  runHealthPollingJob
};
