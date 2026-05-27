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

const DEFAULT_CHAINS = [
  {
    name: "Optimism",
    chainId: 10,
    rpcUrl: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
    etherFiSafeFactoryAddress: "0xF4e147Db314947fC1275a8CbB6Cde48c510cd8CF",
    debtManagerAddress: "0x0078C5a459132e279056B2371fE8A8eC973A9553",
    cashModuleAddress: "0x7Ca0b75E67E33c0014325B739A8d019C4FE445F0"
  },
  {
    name: "Scroll",
    chainId: 534352,
    rpcUrl: process.env.SCROLL_RPC_URL || "https://rpc.scroll.io",
    etherFiSafeFactoryAddress: process.env.ETHERFI_SAFE_FACTORY_ADDRESS || "0xF4e147Db314947fC1275a8CbB6Cde48c510cd8CF",
    debtManagerAddress: process.env.DEBT_MANAGER_ADDRESS || "0x0078C5a459132e279056B2371fE8A8eC973A9553",
    cashModuleAddress: process.env.CASH_MODULE_ADDRESS || "0x7Ca0b75E67E33c0014325B739A8d019C4FE445F0"
  }
];

function chainConfigsFromEnv() {
  if (process.env.CHAIN_CONFIGS_JSON) return JSON.parse(process.env.CHAIN_CONFIGS_JSON);
  return DEFAULT_CHAINS;
}

const chains = chainConfigsFromEnv().map((chain) => ({
  ...chain,
  chainId: Number(chain.chainId || chain.chain_id),
  rpcUrl: chain.rpcUrl || chain.rpc_url,
  etherFiSafeFactoryAddress: chain.etherFiSafeFactoryAddress || chain.etherFiSafeFactory || chain.factoryAddress,
  debtManagerAddress: chain.debtManagerAddress || "",
  cashModuleAddress: chain.cashModuleAddress || ""
}));

module.exports = {
  port: numberFromEnv("PORT", 4173),
  dataPath: resolveFromRoot(process.env.DATA_PATH || "./data/etherfi-monitor.json"),
  chains,
  rpc: {
    url: process.env.SCROLL_RPC_URL || "https://rpc.scroll.io",
    chainId: numberFromEnv("CHAIN_ID", 534352),
    debtManagerAddress: process.env.DEBT_MANAGER_ADDRESS || "",
    cashModuleAddress: process.env.CASH_MODULE_ADDRESS || "",
    etherFiSafeFactoryAddress: process.env.ETHERFI_SAFE_FACTORY_ADDRESS || "",
    etherFiSafeFactoryStartBlock: numberFromEnv("ETHERFI_SAFE_FACTORY_START_BLOCK", 0),
    factoryLogChunkSize: numberFromEnv("FACTORY_LOG_CHUNK_SIZE", 5000),
    borrowActivityLogChunkSize: numberFromEnv("BORROW_ACTIVITY_LOG_CHUNK_SIZE", 5000),
    batchSize: numberFromEnv("RPC_BATCH_SIZE", 25),
    batchDelayMs: numberFromEnv("RPC_BATCH_DELAY_MS", 250)
  },
  health: {
    staleAfterHours: numberFromEnv("HEALTH_STALE_AFTER_HOURS", 24)
  }
};
