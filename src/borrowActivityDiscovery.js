const { ethers } = require("ethers");
const config = require("./config");
const { insertActivity, normalizeAddress, upsertSafe } = require("./db");

const BORROWED_EVENT = "event Borrowed(address indexed user, address indexed token, uint256 amount)";
const BORROWED_TOPIC = ethers.id("Borrowed(address,address,uint256)");
const BORROWED_INTERFACE = new ethers.Interface([BORROWED_EVENT]);

async function importLatestBorrowActivitySafesForAllChains(db, limit) {
  const chainResults = [];
  const candidates = [];

  for (const chain of config.chains.filter((item) => item.rpcUrl && item.debtManagerAddress)) {
    try {
      const result = await findLatestBorrowActivitySafes(chain, limit);
      chainResults.push(summaryFor(result, limit));
      candidates.push(...result.events);
    } catch (error) {
      chainResults.push({
        chainId: chain.chainId,
        chainName: chain.name,
        requested: Number(limit || 100),
        imported: 0,
        scannedFromBlock: null,
        scannedToBlock: null,
        error: error.message
      });
    }
  }

  const latestUniqueEvents = uniqueLatestSafeEvents(candidates, limit);
  for (const event of latestUniqueEvents) {
    upsertSafe(db, {
      safe_address: event.safe_address,
      chain_id: event.chain_id,
      chain_name: event.chain_name,
      source: "borrow_activity_rpc",
      first_seen_block: event.block_number,
      first_seen_at: event.block_timestamp,
      last_seen_block: event.block_number,
      last_seen_at: event.block_timestamp
    });
    insertActivity(db, {
      source: "debt_manager_borrowed_event",
      activity_type: "borrowed",
      chain_id: event.chain_id,
      chain_name: event.chain_name,
      safe_address: event.safe_address,
      token_address: event.token_address,
      amount: event.amount,
      block_number: event.block_number,
      block_timestamp: event.block_timestamp,
      tx_hash: event.tx_hash,
      log_index: event.log_index
    });
  }

  db.save();
  return {
    requested: Number(limit || 100),
    imported: latestUniqueEvents.length,
    chains: chainResults,
    safes: latestUniqueEvents
  };
}

async function findLatestBorrowActivitySafes(chain, limit) {
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, { chainId: chain.chainId, name: chain.name }, { staticNetwork: true });
  const latest = await provider.getBlockNumber();
  const startBlock = borrowStartBlock(chain);
  const chunkSize = Math.max(1, Number(config.rpc.borrowActivityLogChunkSize || 5000));
  const uniqueSafes = new Set();
  const logs = [];
  let scannedFromBlock = latest;

  for (let toBlock = latest; toBlock >= startBlock && uniqueSafes.size < Number(limit || 100); toBlock -= chunkSize) {
    const fromBlock = Math.max(startBlock, toBlock - chunkSize + 1);
    scannedFromBlock = fromBlock;
    const chunk = await provider.getLogs({
      address: chain.debtManagerAddress,
      topics: [BORROWED_TOPIC],
      fromBlock,
      toBlock
    });
    logs.push(...chunk);
    for (const log of chunk.sort(compareLogPosition).reverse()) {
      uniqueSafes.add(safeFromBorrowLog(log));
      if (uniqueSafes.size >= Number(limit || 100)) break;
    }
  }

  const latestLogs = logs.sort(compareLogPosition).reverse();
  const selected = [];
  const selectedSafes = new Set();
  for (const log of latestLogs) {
    const safe = safeFromBorrowLog(log);
    if (selectedSafes.has(safe)) continue;
    selected.push(log);
    selectedSafes.add(safe);
    if (selected.length >= Number(limit || 100)) break;
  }

  const timestamps = await blockTimestamps(provider, selected.map((log) => log.blockNumber));
  return {
    chain,
    latestBlock: latest,
    scannedFromBlock,
    events: selected.map((log) => decodeBorrowLog(chain, log, timestamps[log.blockNumber] || null))
  };
}

function borrowStartBlock(chain) {
  const specific = process.env[`BORROW_ACTIVITY_START_BLOCK_${Number(chain.chainId)}`];
  if (specific) return Number(specific);
  if (process.env.BORROW_ACTIVITY_START_BLOCK) return Number(process.env.BORROW_ACTIVITY_START_BLOCK);
  return Number(chain.borrowActivityStartBlock || chain.debtManagerStartBlock || 0);
}

function uniqueLatestSafeEvents(events, limit) {
  const selected = [];
  const seen = new Set();
  for (const event of events.sort(compareDecodedEventPosition).reverse()) {
    const key = `${event.chain_id}:${event.safe_address}`;
    if (seen.has(key)) continue;
    selected.push(event);
    seen.add(key);
    if (selected.length >= Number(limit || 100)) break;
  }
  return selected;
}

async function blockTimestamps(provider, blockNumbers) {
  const timestamps = {};
  for (const blockNumber of new Set(blockNumbers)) {
    const block = await provider.getBlock(blockNumber);
    timestamps[blockNumber] = block ? new Date(Number(block.timestamp) * 1000).toISOString() : null;
  }
  return timestamps;
}

function decodeBorrowLog(chain, log, blockTimestamp) {
  const parsed = BORROWED_INTERFACE.parseLog(log);
  return {
    chain_id: Number(chain.chainId),
    chain_name: chain.name,
    safe_address: normalizeAddress(parsed.args.user),
    token_address: normalizeAddress(parsed.args.token),
    amount: parsed.args.amount.toString(),
    block_number: log.blockNumber,
    block_timestamp: blockTimestamp,
    tx_hash: log.transactionHash,
    log_index: log.index
  };
}

function safeFromBorrowLog(log) {
  return ethers.getAddress(`0x${log.topics[1].slice(-40)}`).toLowerCase();
}

function compareLogPosition(a, b) {
  const blockDelta = a.blockNumber - b.blockNumber;
  if (blockDelta) return blockDelta;
  return Number(a.index || 0) - Number(b.index || 0);
}

function compareDecodedEventPosition(a, b) {
  const timeDelta = new Date(a.block_timestamp || 0).getTime() - new Date(b.block_timestamp || 0).getTime();
  if (timeDelta) return timeDelta;
  const blockDelta = a.block_number - b.block_number;
  if (blockDelta) return blockDelta;
  return Number(a.log_index || 0) - Number(b.log_index || 0);
}

function summaryFor(result, requested) {
  const first = result.events[0] || null;
  const last = result.events[result.events.length - 1] || null;
  return {
    chainId: result.chain.chainId,
    chainName: result.chain.name,
    requested: Number(requested || 100),
    imported: result.events.length,
    latestBlock: result.latestBlock,
    scannedFromBlock: result.scannedFromBlock,
    newestBorrowSafe: first ? first.safe_address : null,
    newestBorrowBlock: first ? first.block_number : null,
    oldestBorrowSafe: last ? last.safe_address : null,
    oldestBorrowBlock: last ? last.block_number : null,
    error: null
  };
}

module.exports = { importLatestBorrowActivitySafesForAllChains };
