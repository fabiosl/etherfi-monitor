const assert = require("node:assert/strict");
const test = require("node:test");

const { buildAlertSummaries, evaluateAlerts } = require("../src/alerts");
const { getAlertDefinitions, getAlertEvents, getAlertRuns, initDb, insertHealthSnapshot, upsertSafe } = require("../src/db");
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
    liquidation_utilization_bps: 10001
  });

  await evaluateAlerts(db, { now: new Date("2026-05-27T10:00:00.000Z") });
  let event = (await getAlertEvents(db)).find((row) => row.alert_id === "liquidation-utilization-over-100");
  assert.equal(event.status, "triggered");
  assert.equal(event.fire_count, 1);

  await evaluateAlerts(db, { now: new Date("2026-05-27T10:05:00.000Z") });
  event = (await getAlertEvents(db)).find((row) => row.alert_id === "liquidation-utilization-over-100");
  assert.equal((await getAlertEvents(db)).filter((row) => row.alert_id === "liquidation-utilization-over-100").length, 1);
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
  event = (await getAlertEvents(db)).find((row) => row.alert_id === "liquidation-utilization-over-100");
  assert.equal(event.status, "resolved");
  assert.ok(event.resolved_at);
  assert.equal(event.payload.reason, "condition_cleared");
  assert.equal(event.payload.resolved_by, "alerts_worker");
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
      liquidation_utilization_bps: 10001
    });
  }

  await evaluateAlerts(db, { now: new Date("2026-05-27T10:00:00.000Z") });
  const events = (await getAlertEvents(db)).filter((row) => row.alert_id === "liquidation-utilization-over-100");
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
    liquidation_utilization_bps: 10001
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

test("alert definitions and summaries explain meaning and close condition", async (t) => {
  const db = await openTestDb(t);

  await evaluateAlerts(db, { now: new Date("2026-05-27T10:00:00.000Z") });
  const definitions = await getAlertDefinitions(db);
  const threshold = definitions.find((definition) => definition.id === "liquidation-utilization-over-100");
  const summaries = await buildAlertSummaries(db);
  const summary = summaries.alerts.find((alert) => alert.id === "liquidation-utilization-over-100");

  assert.match(threshold.description, /above 100%/);
  assert.match(summary.description, /above 100%/);
  assert.match(summary.clearCondition, /at or below 100%/);
});

test("alert summaries include details for open triggered events", async (t) => {
  const db = await openTestDb(t);
  await upsertSafe(db, { safe_address: "0x0000000000000000000000000000000000000004", chain_id: 10, chain_name: "Optimism", source: "test" });
  await insertHealthSnapshot(db, {
    safe_address: "0x0000000000000000000000000000000000000004",
    chain_id: 10,
    chain_name: "Optimism",
    health_status: "critical",
    data_quality_state: "fresh",
    liquidation_utilization_bps: 10100
  });

  await evaluateAlerts(db, { now: new Date("2026-05-27T10:00:00.000Z") });
  const summaries = await buildAlertSummaries(db);
  const summary = summaries.alerts.find((alert) => alert.id === "liquidation-utilization-over-100");

  assert.equal(summary.currentOpen, 1);
  assert.equal(summary.openEventDetails.length, 1);
  assert.equal(summary.openEventDetails[0].safeAddress, "0x0000000000000000000000000000000000000004");
  assert.equal(summary.openEventDetails[0].reason, "liquidation_utilization_over_100");
  assert.equal(summary.openEventDetails[0].liquidationUtilizationBps, 10100);
});
