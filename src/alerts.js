const config = require("./config");
const {
  getLatestHealthRows,
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
    description: "A safe is missing a recent health snapshot, so the monitor may be making decisions from stale or absent risk data.",
    clearCondition: "Automatically closes after the safe receives a health snapshot newer than the stale-health threshold."
  },
  {
    id: "liquidation-utilization-over-100",
    name: "Liquidation utilization beyond 100%",
    severity: "critical",
    cadence: "every 5 minutes",
    monitor: "safe-health-worker",
    route: "PagerDuty: liquidation-risk",
    description: "A safe has liquidation utilization above 100%, meaning current borrow exceeds the latest calculated liquidation capacity.",
    clearCondition: "Automatically closes after the latest safe liquidation utilization is at or below 100%."
  },
  {
    id: "stale-oracle-prices",
    name: "Stale or missing oracle prices",
    severity: "warning",
    cadence: "every 5 minutes",
    monitor: "oracle-health",
    route: "PagerDuty: protocol-data",
    description: "The protocol read could not produce reliable health because required price or configuration data was missing.",
    clearCondition: "Automatically closes after the latest safe health snapshot has evaluable protocol and price data."
  },
  {
    id: "rpc-read-failures",
    name: "RPC health read failures",
    severity: "warning",
    cadence: "every 5 minutes",
    monitor: "safe-health-worker",
    route: "PagerDuty: protocol-data",
    description: "The latest Optimism RPC contract reads failed for a safe, so the stored health state is not trustworthy.",
    clearCondition: "Automatically closes after a later health read succeeds for that safe."
  },
  {
    id: "borrow-activity-fraud-watch",
    name: "Fraud watch: unusual borrow activity",
    severity: "warning",
    cadence: "every 5 minutes",
    monitor: "borrow-activity-rpc",
    route: "local-only: fraud-risk",
    description: "A safe has repeated borrow events inside the configured fraud-watch window, which can indicate unusual user or automation behavior.",
    clearCondition: "Automatically closes after the repeated borrow pattern is no longer present in the current fraud-watch window."
  }
];

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
    payload: {
      alert_description: definition.description,
      clear_condition: definition.clearCondition || null,
      ...payload
    }
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
  if (definition.id === "liquidation-utilization-over-100") {
    return latestHealthEvents(db, definition, (row) => Number(row.liquidation_utilization_bps) > 10000, "liquidation_utilization_over_100");
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
      const resolved = await resolveAlertEvent(db, event.dedupe_key, {
        reason: "condition_cleared",
        alert_description: definition.description,
        clear_condition: definition.clearCondition || null,
        resolved_by: "alerts_worker",
        resolved_because: "This alert was open in PostgreSQL but was not produced by the current alert evaluation cycle."
      });
      if (resolved) {
        resolvedCount += 1;
        if (pagerDuty) await pagerDuty.sendResolve(definition, resolved);
      }
    }
    console.log(`[alerts] ${definition.id}: active=${activeEvents.length}; new_triggers=${triggeredCount}; auto_resolved=${resolvedCount}.`);

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
      const openEventDetails = openEvents
        .sort((a, b) => new Date(b.last_fired_at || 0).getTime() - new Date(a.last_fired_at || 0).getTime())
        .map((event) => ({
          id: event.id,
          severity: event.severity,
          chainId: event.chain_id,
          chainName: event.chain_name,
          safeAddress: event.safe_address,
          firstFiredAt: event.first_fired_at,
          lastFiredAt: event.last_fired_at,
          fireCount: Number(event.fire_count || 1),
          reason: event.payload && event.payload.reason || null,
          liquidationUtilizationBps: event.payload && event.payload.liquidation_utilization_bps || null,
          dataQualityState: event.payload && event.payload.data_quality_state || null,
          error: event.payload && event.payload.error || null,
          dedupeKey: event.dedupe_key
        }));

      return {
        ...definition,
        status: latestRun ? latestRun.status === "failed" ? "failing" : "running" : "never_run",
        lastRunAt: latestRun && latestRun.started_at || null,
        lastSuccessfulRunAt: latestSuccess && latestSuccess.started_at || null,
        lastFiredAt: maxIso(alertEvents, "last_fired_at"),
        firedCount: rangeEvents.reduce((sum, event) => sum + Number(event.fire_count || 1), 0),
        currentOpen: openEvents.length,
        openEventDetails,
        lastError: latestRun && latestRun.error || null,
        clearCondition: definition.clearCondition || null,
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
