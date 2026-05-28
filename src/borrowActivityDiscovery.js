const { ethers } = require("ethers");
const config = require("./config");
const {
  acquireLease,
  hasActivity,
  insertActivity,
  insertBorrowDiscoveryRun,
  normalizeAddress,
  releaseLease,
  upsertSafe
} = require("./db");

const BORROWED_EVENT = "event Borrowed(address indexed user, address indexed token, uint256 amount)";
const BORROWED_TOPIC = ethers.id("Borrowed(address,address,uint256)");
const BORROWED_INTERFACE = new ethers.Interface([BORROWED_EVENT]);
const ACTIVITY_SOURCE = "debt_manager_borrowed_event";

function optimismChain() {
  const chain = config.chains.find((item) => Number(item.chainId) === 10) || config.optimism;
  return {
    ...chain,
    name: "Optimism",
    chainId: 10
  };
}

async function importLatestBorrowActivitySafesForAllChains(db, limit) {
  const result = await discoverOptimismBorrowActivity(db, { limit });
  return {
    requested: Number(limit || 100),
    imported: result.newEvents,
    chains: [result],
    safes: result.safes || []
  };
}

async function discoverOptimismBorrowActivity(db, options = {}) {
  const chain = options.chain || optimismChain();
  const leaseKey = `borrow-discovery:${chain.chainId}`;
  const leaseAcquired = await acquireLease(db, leaseKey, config.worker.workerLeaseTtlMs);
  if (!leaseAcquired) {
    return {
      chainId: chain.chainId,
      chainName: chain.name,
      status: "skipped",
      stopReason: "lease_held",
      newEvents: 0,
      safes: []
    };
  }

  try {
    return await runBorrowDiscovery(db, chain, options);
  } finally {
    await releaseLease(db, leaseKey);
  }
}

async function runBorrowDiscovery(db, chain, options = {}) {
  const startedAt = new Date().toISOString();
  let latestScannedBlock = null;
  let oldestScannedBlock = null;
  let stopReason = null;
  let newEvents = 0;
  const safes = [];

  try {
    if (!chain.rpcUrl || !chain.debtManagerAddress) {
      throw new Error("Optimism RPC URL and DebtManager address are required for borrow discovery.");
    }

    const provider = options.provider || new ethers.JsonRpcProvider(
      chain.rpcUrl,
      { chainId: chain.chainId, name: chain.name },
      { staticNetwork: true }
    );
    const latest = await provider.getBlockNumber();
    latestScannedBlock = latest;
    const startBlock = borrowStartBlock(chain);
    const chunkSize = Math.max(1, Number(config.rpc.borrowActivityLogChunkSize || 5000));
    const cutoff = new Date(Date.now() - Number(config.worker.activeSafeLookbackHours || 72) * 60 * 60 * 1000);
    const timestampCache = new Map();
    const limit = options.limit ? Number(options.limit) : Infinity;

    for (let toBlock = latest; toBlock >= startBlock && !stopReason && newEvents < limit; toBlock -= chunkSize) {
      const fromBlock = Math.max(startBlock, toBlock - chunkSize + 1);
      oldestScannedBlock = fromBlock;
      const logs = await provider.getLogs({
        address: chain.debtManagerAddress,
        topics: [BORROWED_TOPIC],
        fromBlock,
        toBlock
      });

      for (const log of logs.sort(compareLogPosition).reverse()) {
        const decoded = await decodeBorrowLog(chain, provider, log, timestampCache);
        if (decoded.block_timestamp && new Date(decoded.block_timestamp).getTime() < cutoff.getTime()) {
          stopReason = "lookback_exhausted";
          break;
        }

        const alreadyMonitored = await hasActivity(db, {
          source: ACTIVITY_SOURCE,
          activity_type: "borrowed",
          tx_hash: decoded.tx_hash,
          log_index: decoded.log_index
        });
        if (alreadyMonitored) {
          stopReason = "already_monitored";
          break;
        }

        await upsertSafe(db, {
          safe_address: decoded.safe_address,
          chain_id: decoded.chain_id,
          chain_name: decoded.chain_name,
          source: "borrow_activity_rpc",
          first_seen_block: decoded.block_number,
          first_seen_at: decoded.block_timestamp,
          last_seen_block: decoded.block_number,
          last_seen_at: decoded.block_timestamp,
          last_borrowed_at: decoded.block_timestamp,
          status: "active"
        });
        const inserted = await insertActivity(db, {
          source: ACTIVITY_SOURCE,
          activity_type: "borrowed",
          chain_id: decoded.chain_id,
          chain_name: decoded.chain_name,
          safe_address: decoded.safe_address,
          token_address: decoded.token_address,
          amount: decoded.amount,
          block_number: decoded.block_number,
          block_timestamp: decoded.block_timestamp,
          tx_hash: decoded.tx_hash,
          log_index: decoded.log_index
        });
        if (inserted) {
          newEvents += 1;
          safes.push(decoded);
        }
        if (newEvents >= limit) {
          stopReason = "limit_reached";
          break;
        }
      }

      if (!stopReason && logs.length === 0) {
        const boundaryTimestamp = await blockTimestamp(provider, fromBlock, timestampCache);
        if (boundaryTimestamp && new Date(boundaryTimestamp).getTime() < cutoff.getTime()) {
          stopReason = "lookback_exhausted";
        }
      }
    }

    stopReason ||= "start_block_reached";
    await insertBorrowDiscoveryRun(db, {
      chain_id: chain.chainId,
      chain_name: chain.name,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      latest_scanned_block: latestScannedBlock,
      oldest_scanned_block: oldestScannedBlock,
      new_events: newEvents,
      stop_reason: stopReason,
      error: null
    });

    return {
      chainId: chain.chainId,
      chainName: chain.name,
      status: "success",
      latestScannedBlock,
      oldestScannedBlock,
      newEvents,
      stopReason,
      safes
    };
  } catch (error) {
    await insertBorrowDiscoveryRun(db, {
      chain_id: chain.chainId,
      chain_name: chain.name,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      latest_scanned_block: latestScannedBlock,
      oldest_scanned_block: oldestScannedBlock,
      new_events: newEvents,
      stop_reason: "rpc_failed",
      error: error.message
    });
    return {
      chainId: chain.chainId,
      chainName: chain.name,
      status: "failed",
      latestScannedBlock,
      oldestScannedBlock,
      newEvents,
      stopReason: "rpc_failed",
      error: error.message,
      safes
    };
  }
}

function borrowStartBlock(chain) {
  const specific = process.env[`BORROW_ACTIVITY_START_BLOCK_${Number(chain.chainId)}`];
  if (specific) return Number(specific);
  if (process.env.BORROW_ACTIVITY_START_BLOCK) return Number(process.env.BORROW_ACTIVITY_START_BLOCK);
  return Number(chain.borrowActivityStartBlock || chain.debtManagerStartBlock || 0);
}

async function decodeBorrowLog(chain, provider, log, timestampCache) {
  const parsed = BORROWED_INTERFACE.parseLog(log);
  return {
    chain_id: Number(chain.chainId),
    chain_name: chain.name,
    safe_address: normalizeAddress(parsed.args.user),
    token_address: normalizeAddress(parsed.args.token),
    amount: parsed.args.amount.toString(),
    block_number: log.blockNumber,
    block_timestamp: await blockTimestamp(provider, log.blockNumber, timestampCache),
    tx_hash: log.transactionHash,
    log_index: Number(log.index)
  };
}

async function blockTimestamp(provider, blockNumber, timestampCache) {
  if (timestampCache.has(blockNumber)) return timestampCache.get(blockNumber);
  const block = await provider.getBlock(blockNumber);
  const value = block ? new Date(Number(block.timestamp) * 1000).toISOString() : null;
  timestampCache.set(blockNumber, value);
  return value;
}

function compareLogPosition(a, b) {
  const blockDelta = a.blockNumber - b.blockNumber;
  if (blockDelta) return blockDelta;
  return Number(a.index || 0) - Number(b.index || 0);
}

module.exports = {
  ACTIVITY_SOURCE,
  BORROWED_TOPIC,
  discoverOptimismBorrowActivity,
  importLatestBorrowActivitySafesForAllChains,
  runBorrowDiscovery
};
