const assert = require("node:assert/strict");
const test = require("node:test");
const { ethers } = require("ethers");

const { ACTIVITY_SOURCE, runBorrowDiscovery } = require("../src/borrowActivityDiscovery");
const { getSafeActivityRows, initDb, insertActivity } = require("../src/db");
const { createTestPool } = require("./testDb");

const iface = new ethers.Interface(["event Borrowed(address indexed user, address indexed token, uint256 amount)"]);
const chain = {
  name: "Optimism",
  chainId: 10,
  rpcUrl: "mock",
  debtManagerAddress: "0x0078C5a459132e279056B2371fE8A8eC973A9553"
};

function borrowLog({ blockNumber, index, safe, txHash }) {
  const encoded = iface.encodeEventLog("Borrowed", [safe, "0x0000000000000000000000000000000000000002", 123n]);
  return {
    address: chain.debtManagerAddress,
    blockNumber,
    index,
    transactionHash: txHash,
    topics: encoded.topics,
    data: encoded.data
  };
}

function fakeProvider(logs, timestampForBlock = (blockNumber) => Math.floor(Date.now() / 1000) - (100 - blockNumber)) {
  return {
    async getBlockNumber() {
      return 100;
    },
    async getLogs() {
      return logs;
    },
    async getBlock(blockNumber) {
      return { timestamp: timestampForBlock(blockNumber) };
    }
  };
}

async function openTestDb(t) {
  const db = await initDb({ pool: createTestPool() });
  t.after(async () => db.close());
  return db;
}

test("borrow discovery stops once it reaches an already-monitored transaction", async (t) => {
  const db = await openTestDb(t);

  await insertActivity(db, {
    source: ACTIVITY_SOURCE,
    activity_type: "borrowed",
    chain_id: 10,
    chain_name: "Optimism",
    safe_address: "0x0000000000000000000000000000000000000003",
    block_number: 98,
    block_timestamp: new Date().toISOString(),
    tx_hash: "0x0000000000000000000000000000000000000000000000000000000000000098",
    log_index: 0
  });

  const logs = [
    borrowLog({
      blockNumber: 100,
      index: 0,
      safe: "0x0000000000000000000000000000000000000001",
      txHash: "0x0000000000000000000000000000000000000000000000000000000000000100"
    }),
    borrowLog({
      blockNumber: 99,
      index: 0,
      safe: "0x0000000000000000000000000000000000000002",
      txHash: "0x0000000000000000000000000000000000000000000000000000000000000099"
    }),
    borrowLog({
      blockNumber: 98,
      index: 0,
      safe: "0x0000000000000000000000000000000000000003",
      txHash: "0x0000000000000000000000000000000000000000000000000000000000000098"
    }),
    borrowLog({
      blockNumber: 97,
      index: 0,
      safe: "0x0000000000000000000000000000000000000004",
      txHash: "0x0000000000000000000000000000000000000000000000000000000000000097"
    })
  ];

  const result = await runBorrowDiscovery(db, chain, { provider: fakeProvider(logs) });
  const rows = await getSafeActivityRows(db);

  assert.equal(result.stopReason, "already_monitored");
  assert.equal(result.newEvents, 2);
  assert.equal(rows.filter((row) => row.tx_hash.endsWith("0100")).length, 1);
  assert.equal(rows.filter((row) => row.tx_hash.endsWith("0099")).length, 1);
  assert.equal(rows.filter((row) => row.tx_hash.endsWith("0097")).length, 0);
});

test("borrow discovery stops at the 72 hour boundary", async (t) => {
  const db = await openTestDb(t);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const logs = [
    borrowLog({
      blockNumber: 100,
      index: 0,
      safe: "0x0000000000000000000000000000000000000001",
      txHash: "0x0000000000000000000000000000000000000000000000000000000000000100"
    }),
    borrowLog({
      blockNumber: 99,
      index: 0,
      safe: "0x0000000000000000000000000000000000000002",
      txHash: "0x0000000000000000000000000000000000000000000000000000000000000099"
    })
  ];
  const result = await runBorrowDiscovery(db, chain, {
    provider: fakeProvider(logs, (blockNumber) => blockNumber === 100 ? nowSeconds : nowSeconds - 73 * 60 * 60)
  });
  const rows = await getSafeActivityRows(db);

  assert.equal(result.stopReason, "lookback_exhausted");
  assert.equal(result.newEvents, 1);
  assert.equal(rows.length, 1);
});
