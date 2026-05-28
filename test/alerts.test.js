const assert = require("node:assert/strict");
const test = require("node:test");

const { evaluateAlerts } = require("../src/alerts");
const { getAlertEvents, getAlertRuns, initDb, insertHealthSnapshot, upsertSafe } = require("../src/db");
const { createTestPool } = require("./testDb");

async function openTestDb(t) {
  const db = await initDb({ pool: createTestPool() });
  t.after(async () => db.close());
  return db;
}

test("alert evaluation opens, updates, and resolves a durable event", async (t) => {
  const db = await openTestDb(t);
  await upsertSafe(db, { safe_address: "0x0000000000000000000000000000000000000001", chain_id: 1, chain_name: "Test", source: "test" });
  await insertHealthSnapshot(db, {
    safe_address: "0x0000000000000000000000000000000000000001",
    chain_id: 1,
    chain_name: "Test",
    health_status: "critical",
    data_quality_state: "fresh",
    liquidation_utilization_bps: 10000
  });

  await evaluateAlerts(db, { now: new Date("2026-05-27T10:00:00.000Z") });
  let event = (await getAlertEvents(db)).find((row) => row.alert_id === "liquidation-threshold-breached");
  assert.equal(event.status, "triggered");
  assert.equal(event.fire_count, 1);

  await evaluateAlerts(db, { now: new Date("2026-05-27T10:05:00.000Z") });
  event = (await getAlertEvents(db)).find((row) => row.alert_id === "liquidation-threshold-breached");
  assert.equal((await getAlertEvents(db)).filter((row) => row.alert_id === "liquidation-threshold-breached").length, 1);
  assert.equal(event.fire_count, 2);

  await insertHealthSnapshot(db, {
    safe_address: "0x0000000000000000000000000000000000000001",
    chain_id: 1,
    chain_name: "Test",
    health_status: "healthy",
    data_quality_state: "fresh",
    liquidation_utilization_bps: 1000
  });

  await evaluateAlerts(db, { now: new Date("2026-05-27T10:10:00.000Z") });
  event = (await getAlertEvents(db)).find((row) => row.alert_id === "liquidation-threshold-breached");
  assert.equal(event.status, "resolved");
  assert.ok(event.resolved_at);
});

test("alert dedupe keys are chain-aware", async (t) => {
  const db = await openTestDb(t);
  for (const chainId of [1, 2]) {
    await upsertSafe(db, { safe_address: "0x0000000000000000000000000000000000000001", chain_id: chainId, chain_name: `Test ${chainId}`, source: "test" });
    await insertHealthSnapshot(db, {
      safe_address: "0x0000000000000000000000000000000000000001",
      chain_id: chainId,
      chain_name: `Test ${chainId}`,
      health_status: "critical",
      data_quality_state: "fresh",
      liquidation_utilization_bps: 10000
    });
  }

  await evaluateAlerts(db, { now: new Date("2026-05-27T10:00:00.000Z") });
  const events = (await getAlertEvents(db)).filter((row) => row.alert_id === "liquidation-threshold-breached");
  assert.equal(events.length, 2);
  assert.notEqual(events[0].dedupe_key, events[1].dedupe_key);
});

test("alert evaluation records failed monitor runs", async (t) => {
  const db = await openTestDb(t);
  await upsertSafe(db, { safe_address: "0x0000000000000000000000000000000000000002", chain_id: 1, chain_name: "Test", source: "test" });
  await insertHealthSnapshot(db, {
    safe_address: "0x0000000000000000000000000000000000000002",
    chain_id: 1,
    chain_name: "Test",
    health_status: "critical",
    data_quality_state: "fresh",
    liquidation_utilization_bps: 10000
  });

  await evaluateAlerts(db, {
    now: new Date("2026-05-27T10:00:00.000Z"),
    pagerDuty: {
      async sendTrigger() {
        throw new Error("pagerduty unavailable");
      },
      async sendResolve() {}
    }
  });

  assert.ok((await getAlertRuns(db)).some((run) => run.status === "failed" && run.error === "pagerduty unavailable"));
});
