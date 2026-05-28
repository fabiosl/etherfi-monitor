const config = require("./config");
const { evaluateAlerts } = require("./alerts");
const { discoverOptimismBorrowActivity } = require("./borrowActivityDiscovery");
const { claimSafesForHealth, releaseLease } = require("./db");
const { writeLocalAggregateSnapshot } = require("./localAggregates");
const { createPagerDutyClient } = require("./pagerDuty");
const { pollSafes } = require("./rpcHealth");

async function runBorrowDiscoveryJob(db, options = {}) {
  const startedAt = new Date();
  if (options.log !== false) {
    console.log(`[discovery] Search started at ${startedAt.toISOString()}.`);
  }
  const result = await discoverOptimismBorrowActivity(db, options);
  if (options.log !== false) {
    const durationMs = Date.now() - startedAt.getTime();
    const uniqueSafes = new Set((result.safes || []).map((safe) => safe.safe_address)).size;
    const reason = result.stopReason || result.error || result.status || "unknown";
    const explanation = discoveryStopExplanation(reason);
    console.log(`[discovery] Search ended at ${new Date().toISOString()} after ${durationMs}ms; reason=${reason}; ${explanation}; status=${result.status}; new_events=${result.newEvents || 0}; new_user_safes=${uniqueSafes}.`);
    if (result.error) console.log(`[discovery] Error: ${result.error}`);
  }
  return result;
}

function discoveryStopExplanation(reason) {
  if (reason === "already_monitored") {
    return "stopped because it reached a borrow transaction for a safe/event that is already monitored";
  }
  if (reason === "lookback_exhausted") {
    return "stopped because it reached the active-safe lookback boundary";
  }
  if (reason === "limit_reached") {
    return "stopped because the requested import limit was reached";
  }
  if (reason === "lease_held") {
    return "skipped because another discovery worker currently holds the lease";
  }
  if (reason === "rpc_failed") {
    return "stopped because the Optimism RPC read failed";
  }
  return "stopped with no additional detail";
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
