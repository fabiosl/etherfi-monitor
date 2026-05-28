const { ethers } = require("ethers");
const config = require("./config");
const { insertHealthSnapshot, normalizeAddress } = require("./db");

const DEBT_MANAGER_ABI = [
  "function collateralOf(address user) view returns (tuple(address token,uint256 amount)[] collateral, uint256 totalCollateralUsd)",
  "function borrowingOf(address user) view returns (tuple(address token,uint256 amount)[] borrows, uint256 totalBorrowUsd)",
  "function getMaxBorrowAmount(address user, bool forLtv) view returns (uint256)",
  "function liquidatable(address user) view returns (bool)"
];

const CASH_MODULE_ABI = [
  "function getMode(address safe) view returns (uint8)"
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringifyBigint(value) {
  if (value === null || value === undefined) return null;
  return value.toString();
}

function toTokenArray(items) {
  return Array.from(items || []).map((item) => ({
    token: normalizeAddress(item.token || item[0]),
    amount: stringifyBigint(item.amount || item[1])
  }));
}

function toBps(numerator, denominator) {
  if (!denominator || denominator === 0n) return null;
  return Number((numerator * 10000n) / denominator);
}

function classifyHealth(totalBorrow, maxBorrowLtv, maxBorrowLiquidation, isLiquidatable, hasPrices) {
  if (!hasPrices) return { healthStatus: "unknown", qualityState: "unevaluable_missing_price_or_config" };
  const criticalThresholdBps = BigInt(config.worker.criticalHealthThresholdBps);
  if (isLiquidatable || (maxBorrowLiquidation > 0n && totalBorrow > (maxBorrowLiquidation * criticalThresholdBps) / 10000n)) {
    return { healthStatus: "critical", qualityState: "fresh" };
  }
  if (maxBorrowLtv > 0n && totalBorrow >= (maxBorrowLtv * 9000n) / 10000n) {
    return { healthStatus: "warning", qualityState: "fresh" };
  }
  if (totalBorrow > 0n) return { healthStatus: "healthy", qualityState: "fresh" };
  return { healthStatus: "inactive", qualityState: "fresh" };
}

function createContracts(chain = legacyChainConfig()) {
  if (!chain.debtManagerAddress) {
    throw new Error(`DebtManager address is required for RPC health polling on ${chain.name}`);
  }
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, { chainId: chain.chainId, name: chain.name }, {
    batchMaxCount: 1,
    staticNetwork: true
  });
  const debtManager = new ethers.Contract(chain.debtManagerAddress, DEBT_MANAGER_ABI, provider);
  const cashModule = chain.cashModuleAddress
    ? new ethers.Contract(chain.cashModuleAddress, CASH_MODULE_ABI, provider)
    : null;
  return { provider, debtManager, cashModule, chain };
}

function legacyChainConfig() {
  return {
    name: "Optimism",
    chainId: 10,
    rpcUrl: config.optimism.rpcUrl || config.rpc.url,
    debtManagerAddress: config.rpc.debtManagerAddress,
    cashModuleAddress: config.rpc.cashModuleAddress
  };
}

async function readSafeHealth(contracts, safeAddress) {
  const safe = normalizeAddress(safeAddress);
  const blockNumber = await contracts.provider.getBlockNumber();
  const block = await contracts.provider.getBlock(blockNumber);

  try {
    const [
      collateralResult,
      borrowResult,
      maxBorrowLtv,
      maxBorrowLiquidation,
      liquidatable,
      modeRaw
    ] = await Promise.all([
      contracts.debtManager.collateralOf(safe),
      contracts.debtManager.borrowingOf(safe),
      contracts.debtManager.getMaxBorrowAmount(safe, true),
      contracts.debtManager.getMaxBorrowAmount(safe, false),
      contracts.debtManager.liquidatable(safe),
      contracts.cashModule ? contracts.cashModule.getMode(safe).catch(() => null) : Promise.resolve(null)
    ]);

    const totalCollateral = BigInt(collateralResult[1].toString());
    const totalBorrow = BigInt(borrowResult[1].toString());
    const maxLtv = BigInt(maxBorrowLtv.toString());
    const maxLiquidation = BigInt(maxBorrowLiquidation.toString());
    const hasPrices = totalCollateral > 0n || totalBorrow === 0n;
    const { healthStatus, qualityState } = classifyHealth(totalBorrow, maxLtv, maxLiquidation, liquidatable, hasPrices);

    return {
      safe_address: safe,
      chain_id: contracts.chain.chainId,
      chain_name: contracts.chain.name,
      source: "rpc",
      block_number: blockNumber,
      block_timestamp: block ? new Date(Number(block.timestamp) * 1000).toISOString() : null,
      mode: modeRaw === null ? null : Number(modeRaw) === 0 ? "Credit" : "Debit",
      total_collateral_usd: stringifyBigint(totalCollateral),
      total_borrow_usd: stringifyBigint(totalBorrow),
      max_borrow_ltv_usd: stringifyBigint(maxLtv),
      max_borrow_liquidation_usd: stringifyBigint(maxLiquidation),
      ltv_bps: toBps(totalBorrow, maxLtv),
      liquidation_utilization_bps: toBps(totalBorrow, maxLiquidation),
      health_status: healthStatus,
      data_quality_state: qualityState,
      collateral: toTokenArray(collateralResult[0]),
      borrows: toTokenArray(borrowResult[0]),
      error: null
    };
  } catch (error) {
    return {
      safe_address: safe,
      chain_id: contracts.chain.chainId,
      chain_name: contracts.chain.name,
      source: "rpc",
      block_number: blockNumber,
      block_timestamp: block ? new Date(Number(block.timestamp) * 1000).toISOString() : null,
      mode: null,
      total_collateral_usd: null,
      total_borrow_usd: null,
      max_borrow_ltv_usd: null,
      max_borrow_liquidation_usd: null,
      ltv_bps: null,
      liquidation_utilization_bps: null,
      health_status: "unknown",
      data_quality_state: "rpc_failed",
      collateral: [],
      borrows: [],
      error: error.message
    };
  }
}

async function readSafeCollateral(contracts, safeAddress) {
  const safe = normalizeAddress(safeAddress);
  const blockNumber = await contracts.provider.getBlockNumber();
  const block = await contracts.provider.getBlock(blockNumber);

  try {
    const collateralResult = await contracts.debtManager.collateralOf(safe);
    return {
      safe_address: safe,
      chain_id: contracts.chain.chainId,
      chain_name: contracts.chain.name,
      source: "rpc",
      block_number: blockNumber,
      block_timestamp: block ? new Date(Number(block.timestamp) * 1000).toISOString() : null,
      total_collateral_usd: stringifyBigint(BigInt(collateralResult[1].toString())),
      collateral: toTokenArray(collateralResult[0]),
      data_quality_state: "fresh",
      error: null
    };
  } catch (error) {
    return {
      safe_address: safe,
      chain_id: contracts.chain.chainId,
      chain_name: contracts.chain.name,
      source: "rpc",
      block_number: blockNumber,
      block_timestamp: block ? new Date(Number(block.timestamp) * 1000).toISOString() : null,
      total_collateral_usd: null,
      collateral: [],
      data_quality_state: "rpc_failed",
      error: error.message
    };
  }
}

async function pollSafes(db, safes) {
  const results = [];
  const byChain = new Map();
  for (const row of safes) {
    const chainId = Number(row.chain_id || config.rpc.chainId);
    if (!byChain.has(chainId)) byChain.set(chainId, []);
    byChain.get(chainId).push(row);
  }
  for (const [chainId, rows] of byChain.entries()) {
    const chain = config.chains.find((item) => Number(item.chainId) === Number(chainId)) || legacyChainConfig();
    if (!chain.debtManagerAddress) continue;
    const contracts = createContracts(chain);
    for (let index = 0; index < rows.length; index += config.rpc.batchSize) {
      console.log(`Polling health for chain ${chain.name} (${chain.chainId}), batch ${index / config.rpc.batchSize + 1} of ${Math.ceil(rows.length / config.rpc.batchSize)}`);
      const batch = rows.slice(index, index + config.rpc.batchSize);
      const snapshots = await Promise.all(batch.map((row) => readSafeHealth(contracts, row.safe_address || row)));
      for (const snapshot of snapshots) await insertHealthSnapshot(db, snapshot);
      await db.save();
      results.push(...snapshots);
      if (index + config.rpc.batchSize < rows.length) await sleep(config.rpc.batchDelayMs);
    }
  }
  return results;
}

module.exports = {
  classifyHealth,
  createContracts,
  pollSafes,
  readSafeHealth,
  readSafeCollateral
};
