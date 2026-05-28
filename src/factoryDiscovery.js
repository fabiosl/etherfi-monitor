const { ethers } = require("ethers");
const config = require("./config");
const { upsertSafe } = require("./db");

const SAFE_FACTORY_ABI = [
  "function numContractsDeployed() view returns (uint256)",
  "function getDeployedAddresses(uint256 start, uint256 n) view returns (address[])",
  "event BeaconProxyDeployed(bytes32 salt, address indexed deployed)"
];

const SAFE_DEPLOYED_EVENT = ethers.id("BeaconProxyDeployed(bytes32,address)");

function createFactoryContract(chain = legacyChainConfig()) {
  if (!chain.etherFiSafeFactoryAddress) {
    throw new Error("ETHERFI_SAFE_FACTORY_ADDRESS is required for factory imports");
  }
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, { chainId: chain.chainId, name: chain.name }, { staticNetwork: true });
  return new ethers.Contract(chain.etherFiSafeFactoryAddress, SAFE_FACTORY_ABI, provider);
}

function legacyChainConfig() {
  return {
    name: "Optimism",
    chainId: 10,
    rpcUrl: config.optimism.rpcUrl,
    etherFiSafeFactoryAddress: config.optimism.etherFiSafeFactoryAddress
  };
}

async function importLatestFactorySafes(db, limit, chain = legacyChainConfig()) {
  const factory = createFactoryContract(chain);
  const provider = factory.runner.provider;
  const total = Number(await factory.numContractsDeployed());
  const count = Math.max(0, Math.min(Number(limit || 100), total));
  const latestStartIndex = Math.max(0, total - count);
  const latestEndIndex = total > 0 ? total - 1 : null;
  const eventRows = await findLatestSafeDeploymentEvents(provider, factory.target, count).catch((error) => {
    console.warn(`Could not read latest factory deployment events: ${error.message}`);
    return [];
  });
  const addresses = eventRows.length
    ? eventRows.map((row) => row.safe_address)
    : await factory.getDeployedAddresses(latestStartIndex, count);
  const createdBySafe = Object.fromEntries(eventRows.map((row) => [
    normalizeSafe(row.safe_address),
    {
      blockNumber: row.safe_created_block,
      createdAt: row.safe_created_at,
      txHash: row.tx_hash,
      logIndex: row.log_index
    }
  ]));
  if (!eventRows.length) {
    Object.assign(createdBySafe, await findSafeCreationMetadata(provider, factory.target, addresses).catch((error) => {
      console.warn(`Could not read factory creation logs: ${error.message}`);
      return {};
    }));
  }

  let imported = 0;
  for (let index = 0; index < addresses.length; index += 1) {
    const created = createdBySafe[normalizeSafe(addresses[index])] || {};
    const ok = await upsertSafe(db, {
      safe_address: addresses[index],
      chain_id: chain.chainId,
      chain_name: chain.name,
      source: "factory_rpc",
      safe_created_block: created.blockNumber || null,
      safe_created_at: created.createdAt || null,
      first_seen_block: created.blockNumber || null,
      first_seen_at: created.createdAt || null,
      last_seen_block: created.blockNumber || null,
      last_seen_at: created.createdAt || null
    });
    if (ok) imported += 1;
  }
  await db.save();
  return {
    total,
    start: latestStartIndex,
    end: latestEndIndex,
    requested: limit,
    imported,
    chainId: chain.chainId,
    chainName: chain.name,
    strategy: eventRows.length ? "latest_factory_events" : "latest_factory_indexes",
    addresses
  };
}

async function importLatestFactorySafesForAllChains(db, limit) {
  const results = [];
  for (const chain of config.chains.filter((item) => Number(item.chainId) === 10 && item.rpcUrl && item.etherFiSafeFactoryAddress)) {
    try {
      results.push(await importLatestFactorySafes(db, limit, chain));
    } catch (error) {
      results.push({
        chainId: chain.chainId,
        chainName: chain.name,
        requested: limit,
        imported: 0,
        error: error.message
      });
    }
  }
  return results;
}

async function findLatestSafeDeploymentEvents(provider, factoryAddress, limit) {
  if (!limit) return [];
  const latest = await provider.getBlockNumber();
  const startBlock = Math.max(0, Number(config.rpc.etherFiSafeFactoryStartBlock || 0));
  const chunkSize = Math.max(1, Number(config.rpc.factoryLogChunkSize || 5000));
  const logs = [];

  for (let toBlock = latest; toBlock >= startBlock && logs.length < limit; toBlock -= chunkSize) {
    const fromBlock = Math.max(startBlock, toBlock - chunkSize + 1);
    const chunk = await provider.getLogs({
      address: factoryAddress,
      topics: [SAFE_DEPLOYED_EVENT],
      fromBlock,
      toBlock
    });
    logs.push(...chunk);
  }

  const latestLogs = logs
    .sort(compareLogPosition)
    .slice(-limit);
  const timestamps = await blockTimestamps(provider, latestLogs.map((log) => log.blockNumber));

  return latestLogs.map((log) => ({
    safe_address: safeAddressFromDeploymentLog(log),
    safe_created_block: log.blockNumber,
    safe_created_at: timestamps[log.blockNumber] || null,
    tx_hash: log.transactionHash,
    log_index: log.index
  }));
}

async function findSafeCreationMetadata(provider, factoryAddress, safeAddresses) {
  const wanted = new Set(safeAddresses.map(normalizeSafe));
  const found = {};
  if (!wanted.size) return found;

  const latest = await provider.getBlockNumber();
  const startBlock = Math.max(0, Number(config.rpc.etherFiSafeFactoryStartBlock || 0));
  const chunkSize = Math.max(1, Number(config.rpc.factoryLogChunkSize || 5000));

  for (let toBlock = latest; toBlock >= startBlock && Object.keys(found).length < wanted.size; toBlock -= chunkSize) {
    const fromBlock = Math.max(startBlock, toBlock - chunkSize + 1);
    const logs = await provider.getLogs({ address: factoryAddress, fromBlock, toBlock });
    for (const log of logs) {
      for (const safe of safeAddressesInLog(log)) {
        if (!wanted.has(safe)) continue;
        const existing = found[safe];
        if (!existing || log.blockNumber < existing.blockNumber) {
          found[safe] = {
            blockNumber: log.blockNumber,
            txHash: log.transactionHash,
            logIndex: log.index
          };
        }
      }
    }
  }

  const timestamps = await blockTimestamps(provider, Object.values(found).map((row) => row.blockNumber));

  for (const row of Object.values(found)) row.createdAt = timestamps[row.blockNumber] || null;
  return found;
}

async function blockTimestamps(provider, blockNumbers) {
  const timestamps = {};
  for (const blockNumber of new Set(blockNumbers)) {
    const block = await provider.getBlock(blockNumber);
    timestamps[blockNumber] = block ? new Date(Number(block.timestamp) * 1000).toISOString() : null;
  }
  return timestamps;
}

function compareLogPosition(a, b) {
  const blockDelta = a.blockNumber - b.blockNumber;
  if (blockDelta) return blockDelta;
  return Number(a.index || 0) - Number(b.index || 0);
}

function safeAddressFromDeploymentLog(log) {
  return ethers.getAddress(`0x${log.topics[1].slice(-40)}`).toLowerCase();
}

function safeAddressesInLog(log) {
  const values = [...(log.topics || []), log.data || ""].join("").toLowerCase();
  const matches = values.match(/0{24}[0-9a-f]{40}/g) || [];
  return [...new Set(matches.map((word) => `0x${word.slice(-40)}`))];
}

function normalizeSafe(address) {
  return String(address || "").trim().toLowerCase();
}

module.exports = { importLatestFactorySafes, importLatestFactorySafesForAllChains };
