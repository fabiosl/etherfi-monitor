const config = require("./config");
const {
  getLatestHealthRows,
  getPreviousHealthForSafe,
  getSafes,
  getAlertDefinitions,
  getAlertEvents,
  getAlertRuns,
  getOpenAlertEventsForDefinition,
  getSafeActivityRows,
  countSafeActivity,
  countSafes,
  insertAlertRun,
  resolveAlertEvent,
  safeKey,
  triggerAlertEvent,
  upsertAlertDefinitions
} = require("./db");

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const ALERT_DEFINITIONS = [
  {
    id: "safe-health-not-updated",
    name: "Safes not updated in 24h",
    severity: "warning",
    cadence: "every 5 minutes",
    monitor: "safe-health-worker",
    route: "PagerDuty: safe-health",
    description: "Fires when a safe has never been polled or its latest health snapshot is older than 24 hours."
  },
  {
    id: "liquidation-state-downgrade",
    name: "Liquidation risk / state downgrade",
    severity: "warning",
    cadence: "every 5 minutes",
    monitor: "safe-health-worker",
    route: "PagerDuty: liquidation-risk",
    description: "Fires while a safe is in warning or critical health, with payload context for state movement."
  },
  {
    id: "liquidation-threshold-breached",
    name: "Liquidation threshold breached",
    severity: "critical",
    cadence: "every 5 minutes",
    monitor: "safe-health-worker",
    route: "PagerDuty: liquidation-risk",
    description: "Fires when the latest safe health status is critical."
  },
  {
    id: "stale-oracle-prices",
    name: "Stale or missing oracle prices",
    severity: "warning",
    cadence: "every 5 minutes",
    monitor: "oracle-health",
    route: "PagerDuty: protocol-data",
    description: "Fires when health cannot be evaluated because price or protocol configuration data is missing."
  },
  {
    id: "rpc-read-failures",
    name: "RPC health read failures",
    severity: "warning",
    cadence: "every 5 minutes",
    monitor: "safe-health-worker",
    route: "PagerDuty: protocol-data",
    description: "Fires when the latest contract reads failed for a safe."
  },
  {
    id: "borrow-activity-fraud-watch",
    name: "Fraud watch: unusual borrow activity",
    severity: "warning",
    cadence: "every 5 minutes",
    monitor: "borrow-activity-rpc",
    route: "local-only: fraud-risk",
    description: "Fires on repeated borrow events from the same safe within the configured fraud window."
  }
];

const STATUS_RANK = {
  inactive: 0,
  unknown: 0,
  healthy: 1,
  warning: 2,
  critical: 3
};

function parseDate(value, fallback) {
  const date = value ? new Date(value) : fallback;
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function maxIso(rows, field = "created_at") {
  return rows.reduce((latest, row) => {
    const value = row && row[field];
    if (!value) return latest;
    return !latest || new Date(value).getTime() > new Date(latest).getTime() ? value : latest;
  }, null);
}

function inRange(row, start, end, field = "created_at") {
  const value = row && row[field];
  if (!value) return false;
  const time = new Date(value).getTime();
  return time >= start.getTime() && time <= end.getTime();
}

async function latestHealthBySafe(db) {
  return Object.fromEntries((await getLatestHealthRows(db)).map((row) => [safeKey(row.chain_id, row.safe_address), row]));
}

function eventScope(definition, row, payload = {}) {
  return {
    alert_id: definition.id,
    alert_name: definition.name,
    severity: payload.severity || definition.severity,
    dedupe_key: `etherfi:${row.chain_id}:${row.safe_address}:${definition.id}`,
    chain_id: Number(row.chain_id),
    chain_name: row.chain_name,
    safe_address: row.safe_address,
    route: definition.route,
    payload
  };
}

async function staleSafeEvents(db, definition, now) {
  const latest = await latestHealthBySafe(db);
  const cutoff = now.getTime() - Number(config.health.staleAfterHours || 24) * HOUR_MS;
  return (await getSafes(db))
    .filter((safe) => {
      const row = latest[safeKey(safe.chain_id, safe.safe_address)];
      return !row || !row.created_at || new Date(row.created_at).getTime() < cutoff;
    })
    .map((safe) => eventScope(definition, safe, {
      reason: "safe_health_stale",
      latest_health_at: latest[safeKey(safe.chain_id, safe.safe_address)] && latest[safeKey(safe.chain_id, safe.safe_address)].created_at || null
    }));
}

async function liquidationRiskEvents(db, definition) {
  const rows = (await getLatestHealthRows(db)).filter((row) => ["warning", "critical"].includes(row.health_status));
  const events = [];
  for (const row of rows) {
      const previous = await getPreviousHealthForSafe(db, row);
      const previousRank = STATUS_RANK[previous && previous.health_status] || 0;
      const currentRank = STATUS_RANK[row.health_status] || 0;
      events.push(eventScope(definition, row, {
        reason: currentRank > previousRank ? "state_downgrade" : "risk_state_open",
        severity: row.health_status === "critical" ? "critical" : "warning",
        previous_status: previous && previous.health_status || null,
        current_status: row.health_status,
        liquidation_utilization_bps: row.liquidation_utilization_bps,
        total_borrow_usd: row.total_borrow_usd,
        max_borrow_ltv_usd: row.max_borrow_ltv_usd,
        max_borrow_liquidation_usd: row.max_borrow_liquidation_usd
      }));
  }
  return events;
}

async function latestHealthEvents(db, definition, predicate, reason) {
  return (await getLatestHealthRows(db))
    .filter(predicate)
    .map((row) => eventScope(definition, row, {
      reason,
      health_status: row.health_status,
      data_quality_state: row.data_quality_state,
      error: row.error || null,
      liquidation_utilization_bps: row.liquidation_utilization_bps
    }));
}

async function fraudWatchEvents(db, definition, now) {
  const windowMs = Number(config.worker.fraudWindowMinutes || 60) * MINUTE_MS;
  const start = new Date(now.getTime() - windowMs);
  const bySafe = new Map();
  for (const row of await getSafeActivityRows(db)) {
    if (row.activity_type !== "borrowed" || !inRange(row, start, now, "block_timestamp")) continue;
    const key = safeKey(row.chain_id, row.safe_address);
    if (!bySafe.has(key)) bySafe.set(key, []);
    bySafe.get(key).push(row);
  }

  const events = [];
  for (const rows of bySafe.values()) {
    if (rows.length < 2) continue;
    const latest = rows.sort((a, b) => new Date(b.block_timestamp || 0).getTime() - new Date(a.block_timestamp || 0).getTime())[0];
    events.push(eventScope(definition, latest, {
      reason: "repeated_borrow_activity",
      borrow_event_count: rows.length,
      window_minutes: Number(config.worker.fraudWindowMinutes || 60),
      latest_tx_hash: latest.tx_hash || null
    }));
  }
  return events;
}

async function activeEventsForDefinition(db, definition, now) {
  if (definition.id === "safe-health-not-updated") return staleSafeEvents(db, definition, now);
  if (definition.id === "liquidation-state-downgrade") return liquidationRiskEvents(db, definition);
  if (definition.id === "liquidation-threshold-breached") {
    return latestHealthEvents(db, definition, (row) => row.health_status === "critical", "liquidation_threshold_breached");
  }
  if (definition.id === "stale-oracle-prices") {
    return latestHealthEvents(db, definition, (row) => row.data_quality_state === "unevaluable_missing_price_or_config", "missing_or_stale_oracle_price");
  }
  if (definition.id === "rpc-read-failures") {
    return latestHealthEvents(db, definition, (row) => row.data_quality_state === "rpc_failed", "rpc_read_failed");
  }
  if (definition.id === "borrow-activity-fraud-watch") return fraudWatchEvents(db, definition, now);
  return [];
}

async function evaluateAlertDefinition(db, definition, pagerDuty, now = new Date()) {
  const startedAt = now.toISOString();
  try {
    const activeEvents = await activeEventsForDefinition(db, definition, now);
    const activeKeys = new Set(activeEvents.map((event) => event.dedupe_key));
    let triggeredCount = 0;
    let resolvedCount = 0;

    for (const eventInput of activeEvents) {
      const result = await triggerAlertEvent(db, eventInput);
      if (result.created) triggeredCount += 1;
      if (pagerDuty) await pagerDuty.sendTrigger(definition, result.event, result.created);
    }

    const openEvents = await getOpenAlertEventsForDefinition(db, definition.id, activeKeys);
    for (const event of openEvents) {
      const resolved = await resolveAlertEvent(db, event.dedupe_key, { reason: "condition_cleared" });
      if (resolved) {
        resolvedCount += 1;
        if (pagerDuty) await pagerDuty.sendResolve(definition, resolved);
      }
    }

    const finishedAt = new Date().toISOString();
    await insertAlertRun(db, {
      alert_id: definition.id,
      started_at: startedAt,
      finished_at: finishedAt,
      status: "success",
      evaluated_count: await evaluatedCountFor(db, definition),
      triggered_count: triggeredCount,
      resolved_count: resolvedCount,
      error: null
    });
    return { alertId: definition.id, status: "success", triggeredCount, resolvedCount };
  } catch (error) {
    await insertAlertRun(db, {
      alert_id: definition.id,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: "failed",
      evaluated_count: 0,
      triggered_count: 0,
      resolved_count: 0,
      error: error.message
    });
    return { alertId: definition.id, status: "failed", error: error.message };
  }
}

async function evaluatedCountFor(db, definition) {
  if (definition.id === "borrow-activity-fraud-watch") return countSafeActivity(db);
  const safeCount = await countSafes(db);
  return safeCount || (await getLatestHealthRows(db)).length;
}

async function evaluateAlerts(db, options = {}) {
  await upsertAlertDefinitions(db, ALERT_DEFINITIONS);
  const pagerDuty = options.pagerDuty || null;
  const now = options.now || new Date();
  const results = [];
  for (const definition of ALERT_DEFINITIONS) {
    results.push(await evaluateAlertDefinition(db, definition, pagerDuty, now));
    await db.save();
  }
  return results;
}

async function buildAlertSummaries(db, query = {}) {
  const now = new Date();
  const end = parseDate(query.end, now);
  end.setHours(23, 59, 59, 999);
  const defaultStart = new Date(end.getTime() - 30 * DAY_MS);
  const start = parseDate(query.start, defaultStart);
  start.setHours(0, 0, 0, 0);

  const runs = await getAlertRuns(db);
  const events = await getAlertEvents(db);
  const storedDefinitions = Object.fromEntries((await getAlertDefinitions(db)).map((definition) => [definition.id, definition]));
  const definitions = ALERT_DEFINITIONS.map((definition) => ({ ...definition, ...(storedDefinitions[definition.id] || {}) }));

  return {
    range: {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10)
    },
    alerts: definitions.map((definition) => {
      const alertRuns = runs.filter((run) => run.alert_id === definition.id);
      const alertEvents = events.filter((event) => event.alert_id === definition.id);
      const latestRun = [...alertRuns].sort((a, b) => new Date(b.started_at || 0).getTime() - new Date(a.started_at || 0).getTime())[0] || null;
      const latestSuccess = [...alertRuns].filter((run) => run.status === "success")
        .sort((a, b) => new Date(b.started_at || 0).getTime() - new Date(a.started_at || 0).getTime())[0] || null;
      const openEvents = alertEvents.filter((event) => event.status === "triggered");
      const rangeEvents = alertEvents.filter((event) => inRange(event, start, end, "first_fired_at"));

      return {
        ...definition,
        status: latestRun ? latestRun.status === "failed" ? "failing" : "running" : "never_run",
        lastRunAt: latestRun && latestRun.started_at || null,
        lastSuccessfulRunAt: latestSuccess && latestSuccess.started_at || null,
        lastFiredAt: maxIso(alertEvents, "last_fired_at"),
        firedCount: rangeEvents.reduce((sum, event) => sum + Number(event.fire_count || 1), 0),
        currentOpen: openEvents.length,
        lastError: latestRun && latestRun.error || null,
        signal: openEvents.length ? `${openEvents.length} open events` : "no open events"
      };
    })
  };
}

module.exports = {
  ALERT_DEFINITIONS,
  activeEventsForDefinition,
  buildAlertSummaries,
  evaluateAlerts
};
