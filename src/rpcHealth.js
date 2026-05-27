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
  if (isLiquidatable || (maxBorrowLiquidation > 0n && totalBorrow >= maxBorrowLiquidation)) {
    return { healthStatus: "critical", qualityState: "fresh" };
  }
  if (maxBorrowLtv > 0n && totalBorrow >= (maxBorrowLtv * 9000n) / 10000n) {
    return { healthStatus: "warning", qualityState: "fresh" };
  }
  if (totalBorrow > 0n) return { healthStatus: "healthy", qualityState: "fresh" };
  return { healthStatus: "inactive", qualityState: "fresh" };
}

function createContracts() {
  if (!config.rpc.debtManagerAddress) {
    throw new Error("DEBT_MANAGER_ADDRESS is required for RPC health polling");
  }
  const provider = new ethers.JsonRpcProvider(config.rpc.url, config.rpc.chainId);
  const debtManager = new ethers.Contract(config.rpc.debtManagerAddress, DEBT_MANAGER_ABI, provider);
  const cashModule = config.rpc.cashModuleAddress
    ? new ethers.Contract(config.rpc.cashModuleAddress, CASH_MODULE_ABI, provider)
    : null;
  return { provider, debtManager, cashModule };
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

async function pollSafes(db, safes) {
  const contracts = createContracts();
  const results = [];
  for (let index = 0; index < safes.length; index += config.rpc.batchSize) {
    const batch = safes.slice(index, index + config.rpc.batchSize);
    const snapshots = await Promise.all(batch.map((row) => readSafeHealth(contracts, row.safe_address || row)));
    for (const snapshot of snapshots) insertHealthSnapshot(db, snapshot);
    db.save();
    results.push(...snapshots);
    if (index + config.rpc.batchSize < safes.length) await sleep(config.rpc.batchDelayMs);
  }
  return results;
}

module.exports = {
  pollSafes,
  readSafeHealth
};
