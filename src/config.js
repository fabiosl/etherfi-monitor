require("dotenv").config();

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
  return value;
}

const DEFAULT_CHAINS = [
  {
    name: "Optimism",
    chainId: 10,
    rpcUrl: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
    etherFiSafeFactoryAddress: "0xF4e147Db314947fC1275a8CbB6Cde48c510cd8CF",
    debtManagerAddress: "0x0078C5a459132e279056B2371fE8A8eC973A9553",
    cashModuleAddress: "0x7Ca0b75E67E33c0014325B739A8d019C4FE445F0"
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
  databaseUrl: process.env.DATABASE_URL || "",
  chains,
  optimism: chains.find((chain) => Number(chain.chainId) === 10) || chains[0],
  rpc: {
    url: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
    chainId: numberFromEnv("CHAIN_ID", 10),
    debtManagerAddress: process.env.DEBT_MANAGER_ADDRESS || DEFAULT_CHAINS[0].debtManagerAddress,
    cashModuleAddress: process.env.CASH_MODULE_ADDRESS || DEFAULT_CHAINS[0].cashModuleAddress,
    etherFiSafeFactoryAddress: process.env.ETHERFI_SAFE_FACTORY_ADDRESS || DEFAULT_CHAINS[0].etherFiSafeFactoryAddress,
    etherFiSafeFactoryStartBlock: numberFromEnv("ETHERFI_SAFE_FACTORY_START_BLOCK", 0),
    factoryLogChunkSize: numberFromEnv("FACTORY_LOG_CHUNK_SIZE", 5000),
    borrowActivityLogChunkSize: numberFromEnv("BORROW_ACTIVITY_LOG_CHUNK_SIZE", 5000),
    batchSize: numberFromEnv("RPC_BATCH_SIZE", 25),
    batchDelayMs: numberFromEnv("RPC_BATCH_DELAY_MS", 250)
  },
  health: {
    staleAfterHours: numberFromEnv("HEALTH_STALE_AFTER_HOURS", 24)
  },
  worker: {
    alertIntervalMs: numberFromEnv("ALERT_WORKER_INTERVAL_MS", 5 * 60 * 1000),
    borrowDiscoveryIntervalMs: numberFromEnv("BORROW_DISCOVERY_INTERVAL_MS", 5 * 60 * 1000),
    healthPollIntervalMs: numberFromEnv("HEALTH_POLL_INTERVAL_MS", 5 * 60 * 1000),
    activeSafeLookbackHours: numberFromEnv("ACTIVE_SAFE_LOOKBACK_HOURS", 72),
    healthPollBatchSize: numberFromEnv("HEALTH_POLL_BATCH_SIZE", 25),
    workerLeaseTtlMs: numberFromEnv("WORKER_LEASE_TTL_MS", 4 * 60 * 1000),
    fraudWindowMinutes: numberFromEnv("FRAUD_WATCH_WINDOW_MINUTES", 60)
  },
  pagerDuty: {
    integrationKey: process.env.PAGERDUTY_INTEGRATION_KEY || "",
    eventsUrl: process.env.PAGERDUTY_EVENTS_URL || "https://events.pagerduty.com/v2/enqueue"
  }
};
