const assert = require("node:assert/strict");
const test = require("node:test");

const { claimSafesForHealth, getSafesForPolling, initDb, releaseLease, upsertSafe } = require("../src/db");
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
