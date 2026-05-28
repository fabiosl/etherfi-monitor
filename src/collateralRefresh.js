const config = require("./config");
const { getSafes, insertCollateralRun, insertCollateralSnapshot } = require("./db");
const { createContracts, readSafeCollateral } = require("./rpcHealth");

async function refreshAllCollateral(db) {
  const startedAt = new Date().toISOString();
  let refreshedCount = 0;
  let failedCount = 0;

  try {
    const byChain = new Map();
    const allSafes = await getSafes(db);
    for (const safe of allSafes) {
      const chainId = Number(safe.chain_id || config.rpc.chainId);
      if (!byChain.has(chainId)) byChain.set(chainId, []);
      byChain.get(chainId).push(safe);
    }

    for (const [chainId, safes] of byChain.entries()) {
      const chain = config.chains.find((item) => Number(item.chainId) === Number(chainId));
      if (!chain || !chain.debtManagerAddress) {
        failedCount += safes.length;
        continue;
      }

      const contracts = createContracts(chain);
      for (let index = 0; index < safes.length; index += config.rpc.batchSize) {
        const batch = safes.slice(index, index + config.rpc.batchSize);
        const snapshots = await Promise.all(batch.map((safe) => readSafeCollateral(contracts, safe.safe_address)));
        for (const snapshot of snapshots) {
          await insertCollateralSnapshot(db, snapshot);
          if (snapshot.error) failedCount += 1;
          else refreshedCount += 1;
        }
        await db.save();
      }
    }

    await insertCollateralRun(db, {
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: failedCount ? "partial" : "success",
      evaluated_count: allSafes.length,
      refreshed_count: refreshedCount,
      failed_count: failedCount,
      error: null
    });
    await db.save();
    return { status: failedCount ? "partial" : "success", refreshedCount, failedCount };
  } catch (error) {
    const allSafes = await getSafes(db);
    await insertCollateralRun(db, {
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: "failed",
      evaluated_count: allSafes.length,
      refreshed_count: refreshedCount,
      failed_count: failedCount,
      error: error.message
    });
    await db.save();
    return { status: "failed", refreshedCount, failedCount, error: error.message };
  }
}

module.exports = { refreshAllCollateral };
