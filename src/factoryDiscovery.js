const { ethers } = require("ethers");
const config = require("./config");
const { upsertSafe } = require("./db");

const SAFE_FACTORY_ABI = [
  "function numContractsDeployed() view returns (uint256)",
  "function getDeployedAddresses(uint256 start, uint256 n) view returns (address[])"
];

function createFactoryContract() {
  if (!config.rpc.etherFiSafeFactoryAddress) {
    throw new Error("ETHERFI_SAFE_FACTORY_ADDRESS is required for factory imports");
  }
  const provider = new ethers.JsonRpcProvider(config.rpc.url, config.rpc.chainId);
  return new ethers.Contract(config.rpc.etherFiSafeFactoryAddress, SAFE_FACTORY_ABI, provider);
}

async function importLatestFactorySafes(db, limit) {
  const factory = createFactoryContract();
  const total = Number(await factory.numContractsDeployed());
  const count = Math.max(0, Math.min(Number(limit || 100), total));
  const start = Math.max(0, total - count);
  const addresses = await factory.getDeployedAddresses(start, count);

  let imported = 0;
  for (let index = 0; index < addresses.length; index += 1) {
    const ok = upsertSafe(db, {
      safe_address: addresses[index],
      source: "factory_rpc",
      first_seen_block: null,
      first_seen_at: null,
      last_seen_block: null,
      last_seen_at: null
    });
    if (ok) imported += 1;
  }
  db.save();
  return { total, start, requested: limit, imported, addresses };
}

module.exports = { importLatestFactorySafes };
