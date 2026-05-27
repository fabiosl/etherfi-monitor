const path = require("path");
require("dotenv").config();

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
  return value;
}

function resolveFromRoot(input) {
  if (path.isAbsolute(input)) return input;
  return path.resolve(process.cwd(), input);
}

module.exports = {
  port: numberFromEnv("PORT", 4173),
  dataPath: resolveFromRoot(process.env.DATA_PATH || "./data/etherfi-monitor.json"),
  rpc: {
    url: process.env.SCROLL_RPC_URL || "https://rpc.scroll.io",
    chainId: numberFromEnv("CHAIN_ID", 534352),
    debtManagerAddress: process.env.DEBT_MANAGER_ADDRESS || "",
    cashModuleAddress: process.env.CASH_MODULE_ADDRESS || "",
    etherFiSafeFactoryAddress: process.env.ETHERFI_SAFE_FACTORY_ADDRESS || "",
    batchSize: numberFromEnv("RPC_BATCH_SIZE", 25),
    batchDelayMs: numberFromEnv("RPC_BATCH_DELAY_MS", 250)
  },
  health: {
    staleAfterHours: numberFromEnv("HEALTH_STALE_AFTER_HOURS", 24)
  }
};
