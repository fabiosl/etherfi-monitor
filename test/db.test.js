const assert = require("node:assert/strict");
const test = require("node:test");

const {
  claimSafesForHealth,
  getCriticalSafesForHealth,
  getRiskiestSafesForAsset,
  getSafesForHealthReconcile,
  getSafesForPolling,
  initDb,
  insertHealthSnapshot,
  releaseLease,
  upsertSafe
} = require("../src/db");
const { createTestPool } = require("./testDb");

async function openTestDb(t, owner = undefined) {
  const db = await initDb({ pool: createTestPool(), owner });
  t.after(async () => db.close());
  return db;
}

test("active safe polling selects only recent Optimism borrowers", async (t) => {
  const db = await openTestDb(t);
  const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const old = new Date(Date.now() - 80 * 60 * 60 * 1000).toISOString();

  await upsertSafe(db, {
    chain_id: 10,
    chain_name: "Optimism",
    safe_address: "0x0000000000000000000000000000000000000001",
    source: "test",
    last_borrowed_at: recent,
    status: "active"
  });
  await upsertSafe(db, {
    chain_id: 10,
    chain_name: "Optimism",
    safe_address: "0x0000000000000000000000000000000000000002",
    source: "test",
    last_borrowed_at: old,
    status: "active"
  });
  await upsertSafe(db, {
    chain_id: 999,
    chain_name: "Other",
    safe_address: "0x0000000000000000000000000000000000000003",
    source: "test",
    last_borrowed_at: recent,
    status: "active"
  });

  const safes = await getSafesForPolling(db, 10, { chainId: 10, lookbackHours: 72, activeOnly: true });

  assert.deepEqual(safes.map((safe) => safe.safe_address), ["0x0000000000000000000000000000000000000001"]);
});

test("health leases prevent duplicate claims and can be released", async (t) => {
  const pool = createTestPool();
  const first = await initDb({ pool, owner: "worker-a" });
  const second = await initDb({ pool, owner: "worker-b", migrate: false });
  t.after(async () => {
    await first.close();
    await second.close();
  });

  await upsertSafe(first, {
    chain_id: 10,
    chain_name: "Optimism",
    safe_address: "0x0000000000000000000000000000000000000001",
    source: "test",
    last_borrowed_at: new Date().toISOString(),
    status: "active"
  });

  const firstClaim = await claimSafesForHealth(first, 1, { chainId: 10, lookbackHours: 72, activeOnly: true });
  const secondClaimWhileLeased = await claimSafesForHealth(second, 1, { chainId: 10, lookbackHours: 72, activeOnly: true });
  await releaseLease(first, "safe-health:10:0x0000000000000000000000000000000000000001");
  const secondClaimAfterRelease = await claimSafesForHealth(second, 1, { chainId: 10, lookbackHours: 72, activeOnly: true });

  assert.equal(firstClaim.length, 1);
  assert.equal(secondClaimWhileLeased.length, 0);
  assert.equal(secondClaimAfterRelease.length, 1);
});

test("health reconcile selects all Optimism safes without a recent snapshot", async (t) => {
  const db = await openTestDb(t);
  const addresses = [
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000002",
    "0x0000000000000000000000000000000000000003"
  ];
  for (const safe_address of addresses) {
    await upsertSafe(db, { chain_id: 10, chain_name: "Optimism", safe_address, source: "test" });
  }

  await insertHealthSnapshot(db, {
    chain_id: 10,
    chain_name: "Optimism",
    safe_address: addresses[1],
    liquidation_utilization_bps: 1000,
    data_quality_state: "fresh"
  });
  await db.query("UPDATE safe_health_snapshots SET created_at = now() - interval '25 hours' WHERE safe_address = $1", [addresses[1]]);
  await insertHealthSnapshot(db, {
    chain_id: 10,
    chain_name: "Optimism",
    safe_address: addresses[2],
    liquidation_utilization_bps: 1000,
    data_quality_state: "fresh"
  });

  const safes = await getSafesForHealthReconcile(db, 10, { chainId: 10, staleHours: 24 });

  assert.deepEqual(safes.map((safe) => safe.safe_address), [addresses[0], addresses[1]]);
});

test("critical health selector returns safes above liquidation utilization threshold", async (t) => {
  const db = await openTestDb(t);
  const safeA = "0x0000000000000000000000000000000000000001";
  const safeB = "0x0000000000000000000000000000000000000002";
  const safeC = "0x0000000000000000000000000000000000000003";
  for (const safe_address of [safeA, safeB, safeC]) {
    await upsertSafe(db, { chain_id: 10, chain_name: "Optimism", safe_address, source: "test" });
  }
  await insertHealthSnapshot(db, { chain_id: 10, chain_name: "Optimism", safe_address: safeA, liquidation_utilization_bps: 8900, data_quality_state: "fresh" });
  await insertHealthSnapshot(db, { chain_id: 10, chain_name: "Optimism", safe_address: safeB, liquidation_utilization_bps: 8800, data_quality_state: "fresh" });
  await insertHealthSnapshot(db, { chain_id: 10, chain_name: "Optimism", safe_address: safeC, liquidation_utilization_bps: 8700, data_quality_state: "fresh" });

  const safes = await getCriticalSafesForHealth(db, 10, { chainId: 10, thresholdBps: 8800 });

  assert.deepEqual(safes.map((safe) => safe.safe_address), [safeA]);
});

test("asset-risk selector returns the riskiest slice of safes holding a token", async (t) => {
  const db = await openTestDb(t);
  const token = "0x1111111111111111111111111111111111111111";
  const otherToken = "0x2222222222222222222222222222222222222222";
  const rows = [
    ["0x0000000000000000000000000000000000000001", 9100, token],
    ["0x0000000000000000000000000000000000000002", 8700, token],
    ["0x0000000000000000000000000000000000000003", 5000, token],
    ["0x0000000000000000000000000000000000000004", 9900, otherToken]
  ];
  for (const [safe_address, liquidation_utilization_bps, heldToken] of rows) {
    await upsertSafe(db, { chain_id: 10, chain_name: "Optimism", safe_address, source: "test" });
    await insertHealthSnapshot(db, {
      chain_id: 10,
      chain_name: "Optimism",
      safe_address,
      liquidation_utilization_bps,
      data_quality_state: "fresh",
      collateral: [{ token: heldToken, amount: "1" }]
    });
  }

  const safes = await getRiskiestSafesForAsset(db, token, { chainId: 10, percent: 30 });

  assert.deepEqual(safes.map((safe) => safe.safe_address), ["0x0000000000000000000000000000000000000001"]);
});
