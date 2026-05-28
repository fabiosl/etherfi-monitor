const config = require("./config");
const { evaluateAlerts } = require("./alerts");
const { discoverOptimismBorrowActivity } = require("./borrowActivityDiscovery");
const {
  claimSafesForHealth,
  claimSafesForHealthRows,
  getCriticalSafesForHealth,
  getRiskiestSafesForAsset,
  getSafesForHealthReconcile,
  releaseLease
} = require("./db");
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
  console.log(`[health:active] Started at ${new Date().toISOString()}; limit=${limit}; lookback_hours=${config.worker.activeSafeLookbackHours}.`);
  const safes = await claimSafesForHealth(db, limit, {
    chainId: config.optimism.chainId,
    lookbackHours: config.worker.activeSafeLookbackHours,
    activeOnly: true
  });
  return pollClaimedSafes(db, "health:active", safes, {
    selected: safes.length,
    limit,
    details: `lookback_hours=${config.worker.activeSafeLookbackHours}`
  });
}

async function runHealthReconcileJob(db, options = {}) {
  const startedAt = new Date();
  const maxSafes = options.limit ? Number(options.limit) : Number.POSITIVE_INFINITY;
  const batchSize = Number(options.batchSize || config.worker.healthPollBatchSize);
  const staleHours = Number(options.staleHours || config.worker.healthReconcileStaleHours);
  console.log(`[health:reconcile] Started at ${startedAt.toISOString()}; max_safes=${Number.isFinite(maxSafes) ? maxSafes : "all"}; batch_size=${batchSize}; stale_hours=${staleHours}.`);
  let polled = 0;
  let failed = 0;
  let selected = 0;
  let batches = 0;
  while (polled < maxSafes) {
    const remaining = Number.isFinite(maxSafes) ? Math.max(0, maxSafes - polled) : batchSize;
    const batchLimit = Math.min(batchSize, remaining || batchSize);
    const candidates = await getSafesForHealthReconcile(db, batchLimit * 3, {
      chainId: config.optimism.chainId,
      staleHours
    });
    selected += candidates.length;
    const safes = await claimSafesForHealthRows(db, candidates, batchLimit);
    if (safes.length) {
      for (const safe of safes) {
        console.log(`[health:reconcile] Updating safe ${safe.safe_address} on chain ${safe.chain_id}; latest_health_at=${safe.latest_health_at || "never"}.`);
      }
    }
    const result = await pollClaimedSafes(db, "health:reconcile", safes, {
      selected: candidates.length,
      limit: batchLimit,
      details: `skipped safes updated in the last ${staleHours}h`
    });
    polled += result.polled || 0;
    failed += result.failed || 0;
    batches += 1;
    if (!candidates.length || !safes.length || (Number.isFinite(maxSafes) && polled >= maxSafes)) break;
  }
  console.log(`[health:reconcile] Completed at ${new Date().toISOString()}; batches=${batches}; selected=${selected}; polled=${polled}; failed=${failed}.`);
  return { status: "success", polled, failed, batches, selected };
}

async function runCriticalHealthPollingJob(db, options = {}) {
  const startedAt = new Date();
  const limit = Number(options.limit || config.worker.healthPollBatchSize);
  const thresholdBps = Number(options.thresholdBps || config.worker.criticalHealthThresholdBps);
  console.log(`[health:critical] Started at ${startedAt.toISOString()}; threshold_bps=${thresholdBps}; limit=${limit}.`);
  const candidates = await getCriticalSafesForHealth(db, limit * 3, {
    chainId: config.optimism.chainId,
    thresholdBps
  });
  const safes = await claimSafesForHealthRows(db, candidates, limit);
  return pollClaimedSafes(db, "health:critical", safes, {
    selected: candidates.length,
    limit,
    details: `liquidation_utilization_bps>${thresholdBps}`
  });
}

async function runAssetRiskHealthPollingJob(db, options = {}) {
  const tokenAddress = options.tokenAddress || config.worker.assetRiskTokenAddress;
  const percent = Number(options.percent || config.worker.assetRiskPercent);
  const limit = Number(options.limit || config.worker.healthPollBatchSize);
  const startedAt = new Date();
  console.log(`[health:asset-risk] Started at ${startedAt.toISOString()}; token=${tokenAddress || "unset"}; percent=${percent}; limit=${limit}.`);
  if (!tokenAddress) {
    console.log("[health:asset-risk] Ended without polling because no token address was configured. Set ASSET_RISK_TOKEN_ADDRESS or pass a token argument.");
    return { status: "skipped", reason: "missing_token", polled: 0, failed: 0 };
  }
  const candidates = await getRiskiestSafesForAsset(db, tokenAddress, {
    chainId: config.optimism.chainId,
    percent,
    limit: limit * 3
  });
  const safes = await claimSafesForHealthRows(db, candidates, limit);
  return pollClaimedSafes(db, "health:asset-risk", safes, {
    selected: candidates.length,
    limit,
    details: `top_${percent}_percent_riskiest_for_token=${tokenAddress}`
  });
}

async function pollClaimedSafes(db, label, safes, context = {}) {
  console.log(`[${label}] Selected ${context.selected ?? safes.length} candidate safes; claimed=${safes.length}; limit=${context.limit || safes.length}; ${context.details || "no extra details"}.`);
  if (!safes.length) {
    console.log(`[${label}] Finished without polling because no safes were claimable.`);
    return { status: "success", polled: 0, failed: 0 };
  }

  try {
    const results = await pollSafes(db, safes);
    await writeLocalAggregateSnapshot(db);
    const response = {
      status: "success",
      polled: results.length,
      failed: results.filter((row) => row.data_quality_state === "rpc_failed").length
    };
    console.log(`[${label}] Finished polling; polled=${response.polled}; failed=${response.failed}.`);
    return response;
  } finally {
    for (const safe of safes) {
      await releaseLease(db, `safe-health:${safe.chain_id}:${safe.safe_address}`);
    }
    console.log(`[${label}] Released ${safes.length} safe leases.`);
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
  runAssetRiskHealthPollingJob,
  runCriticalHealthPollingJob,
  runHealthReconcileJob,
  runHealthPollingJob
};
