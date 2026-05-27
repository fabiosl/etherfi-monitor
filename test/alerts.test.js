const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "etherfi-alerts-"));
process.env.DATA_PATH = path.join(tempDir, "db.json");

const { evaluateAlerts } = require("../src/alerts");
const { initDb, insertHealthSnapshot, upsertSafe } = require("../src/db");

function openTestDb() {
  const db = initDb();
  db.state.safes = {};
  db.state.safe_activity = [];
  db.state.safe_health_snapshots = [];
  db.state.alert_runs = [];
  db.state.alert_events = [];
  db.state.seq.alert_runs = 1;
  db.state.seq.alert_events = 1;
  db.state.seq.safe_health_snapshots = 1;
  return db;
}

test("alert evaluation opens, updates, and resolves a durable event", async () => {
  const db = openTestDb();
  upsertSafe(db, { safe_address: "0x0000000000000000000000000000000000000001", chain_id: 1, source: "test" });
  insertHealthSnapshot(db, {
    safe_address: "0x0000000000000000000000000000000000000001",
    chain_id: 1,
    chain_name: "Test",
    health_status: "critical",
    data_quality_state: "fresh",
    liquidation_utilization_bps: 10000
  });

  await evaluateAlerts(db, { now: new Date("2026-05-27T10:00:00.000Z") });
  let event = db.state.alert_events.find((row) => row.alert_id === "liquidation-threshold-breached");
  assert.equal(event.status, "triggered");
  assert.equal(event.fire_count, 1);

  await evaluateAlerts(db, { now: new Date("2026-05-27T10:05:00.000Z") });
  event = db.state.alert_events.find((row) => row.alert_id === "liquidation-threshold-breached");
  assert.equal(db.state.alert_events.filter((row) => row.alert_id === "liquidation-threshold-breached").length, 1);
  assert.equal(event.fire_count, 2);

  insertHealthSnapshot(db, {
    safe_address: "0x0000000000000000000000000000000000000001",
    chain_id: 1,
    chain_name: "Test",
    health_status: "healthy",
    data_quality_state: "fresh",
    liquidation_utilization_bps: 1000
  });

  await evaluateAlerts(db, { now: new Date("2026-05-27T10:10:00.000Z") });
  event = db.state.alert_events.find((row) => row.alert_id === "liquidation-threshold-breached");
  assert.equal(event.status, "resolved");
  assert.ok(event.resolved_at);
});

test("alert dedupe keys are chain-aware", async () => {
  const db = openTestDb();
  for (const chainId of [1, 2]) {
    upsertSafe(db, { safe_address: "0x0000000000000000000000000000000000000001", chain_id: chainId, source: "test" });
    insertHealthSnapshot(db, {
      safe_address: "0x0000000000000000000000000000000000000001",
      chain_id: chainId,
      chain_name: `Test ${chainId}`,
      health_status: "critical",
      data_quality_state: "fresh",
      liquidation_utilization_bps: 10000
    });
  }

  await evaluateAlerts(db, { now: new Date("2026-05-27T10:00:00.000Z") });
  const events = db.state.alert_events.filter((row) => row.alert_id === "liquidation-threshold-breached");
  assert.equal(events.length, 2);
  assert.notEqual(events[0].dedupe_key, events[1].dedupe_key);
});

test("alert evaluation records failed monitor runs", async () => {
  const db = openTestDb();
  upsertSafe(db, { safe_address: "0x0000000000000000000000000000000000000002", chain_id: 1, source: "test" });
  insertHealthSnapshot(db, {
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

  assert.ok(db.state.alert_runs.some((run) => run.status === "failed" && run.error === "pagerduty unavailable"));
});
