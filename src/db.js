const fs = require("fs");
const path = require("path");
const config = require("./config");

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    safes: {},
    safe_activity: [],
    safe_health_snapshots: [],
    aggregate_snapshots: [],
    alert_definitions: [],
    alert_runs: [],
    alert_events: [],
    collateral_runs: [],
    collateral_snapshots: [],
    seq: {
      safe_activity: 1,
      safe_health_snapshots: 1,
      aggregate_snapshots: 1,
      alert_runs: 1,
      alert_events: 1,
      collateral_runs: 1,
      collateral_snapshots: 1
    }
  };
}

function openDb() {
  fs.mkdirSync(path.dirname(config.dataPath), { recursive: true });
  if (!fs.existsSync(config.dataPath)) {
    fs.writeFileSync(config.dataPath, JSON.stringify(defaultState(), null, 2));
  }
  const state = loadState();
  migrateState(state);
  return {
    state,
    save() {
      fs.writeFileSync(config.dataPath, JSON.stringify(state, null, 2));
    },
    reload() {
      const fresh = loadState();
      migrateState(fresh);
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, fresh);
      return state;
    },
    close() {
      this.save();
    }
  };
}

function loadState() {
  return JSON.parse(fs.readFileSync(config.dataPath, "utf8"));
}

function resetDb() {
  fs.mkdirSync(path.dirname(config.dataPath), { recursive: true });
  fs.writeFileSync(config.dataPath, JSON.stringify(defaultState(), null, 2));
  return openDb();
}

function migrateState(state) {
  state.safes ||= {};
  state.safe_activity ||= [];
  state.safe_health_snapshots ||= [];
  state.aggregate_snapshots ||= [];
  state.alert_definitions ||= [];
  state.alert_runs ||= [];
  state.alert_events ||= [];
  state.collateral_runs ||= [];
  state.collateral_snapshots ||= [];
  state.seq ||= {};
  for (const table of [
    "safe_activity",
    "safe_health_snapshots",
    "aggregate_snapshots",
    "alert_runs",
    "alert_events",
    "collateral_runs",
    "collateral_snapshots"
  ]) {
    state.seq[table] ||= nextSequenceValue(state[table]);
  }
  const migratedSafes = {};
  for (const safe of Object.values(state.safes)) {
    safe.chain_id ||= config.rpc.chainId;
    safe.chain_name ||= chainNameForId(safe.chain_id);
    safe.safe_address = normalizeAddress(safe.safe_address);
    if (!Object.prototype.hasOwnProperty.call(safe, "safe_created_at")) safe.safe_created_at = null;
    if (!Object.prototype.hasOwnProperty.call(safe, "safe_created_block")) safe.safe_created_block = null;
    migratedSafes[safeKey(safe.chain_id, safe.safe_address)] = safe;
  }
  state.safes = migratedSafes;
  for (const row of state.safe_health_snapshots || []) {
    row.chain_id ||= config.rpc.chainId;
    row.chain_name ||= chainNameForId(row.chain_id);
    row.safe_address = normalizeAddress(row.safe_address);
  }
  for (const row of state.alert_events || []) {
    if (row.safe_address) row.safe_address = normalizeAddress(row.safe_address);
  }
  for (const row of state.collateral_snapshots || []) {
    row.chain_id ||= config.rpc.chainId;
    row.chain_name ||= chainNameForId(row.chain_id);
    row.safe_address = normalizeAddress(row.safe_address);
  }
}

function nextSequenceValue(rows) {
  return (rows || []).reduce((max, row) => Math.max(max, Number(row.id || 0)), 0) + 1;
}

function initDb() {
  const db = openDb();
  db.save();
  return db;
}

function nextId(db, table) {
  const id = db.state.seq[table] || 1;
  db.state.seq[table] = id + 1;
  return id;
}

function normalizeAddress(address) {
  if (!address) return null;
  return String(address).trim().toLowerCase();
}

function safeKey(chainId, address) {
  return `${Number(chainId || config.rpc.chainId)}:${normalizeAddress(address)}`;
}

function chainNameForId(chainId) {
  const chain = config.chains.find((item) => Number(item.chainId) === Number(chainId));
  return chain ? chain.name : String(chainId || config.rpc.chainId);
}

function upsertSafe(db, input) {
  const safe = normalizeAddress(input.safe_address || input.safe);
  if (!safe) return false;
  const chainId = Number(input.chain_id || input.chainId || config.rpc.chainId);
  const chainName = input.chain_name || input.chainName || chainNameForId(chainId);
  const key = safeKey(chainId, safe);
  const existing = db.state.safes[key];
  const sources = new Set(existing ? existing.sources || [] : []);
  sources.add(input.source || "unknown");
  const safeCreatedAt = minIso(existing && existing.safe_created_at, input.safe_created_at || input.safe_createdAt || null);

  db.state.safes[key] = {
    chain_id: chainId,
    chain_name: chainName,
    safe_address: safe,
    safe_created_at: safeCreatedAt,
    safe_created_block: minNullable(existing && existing.safe_created_block, input.safe_created_block || input.safe_createdBlock || null),
    first_seen_block: minNullable(existing && existing.first_seen_block, input.first_seen_block || null),
    first_seen_at: (existing && existing.first_seen_at) || input.first_seen_at || null,
    last_seen_block: maxNullable(existing && existing.last_seen_block, input.last_seen_block || input.first_seen_block || null),
    last_seen_at: input.last_seen_at || input.first_seen_at || (existing && existing.last_seen_at) || null,
    sources: [...sources].sort(),
    status: (existing && existing.status) || "discovered",
    created_at: (existing && existing.created_at) || nowIso(),
    updated_at: nowIso()
  };
  return true;
}

function minNullable(a, b) {
  if (a == null) return b == null ? null : Number(b);
  if (b == null) return Number(a);
  return Math.min(Number(a), Number(b));
}

function minIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

function maxNullable(a, b) {
  if (a == null) return b == null ? null : Number(b);
  if (b == null) return Number(a);
  return Math.max(Number(a), Number(b));
}

function insertActivity(db, input) {
  const key = `${input.source}|${input.tx_hash || ""}|${input.log_index || ""}|${input.activity_type}`;
  if (db.state.safe_activity.some((row) => row._key === key)) return false;
  db.state.safe_activity.push({
    id: nextId(db, "safe_activity"),
    _key: key,
    ...input,
    created_at: nowIso()
  });
  return true;
}

function insertHealthSnapshot(db, snapshot) {
  const chainId = Number(snapshot.chain_id || snapshot.chainId || config.rpc.chainId);
  db.state.safe_health_snapshots.push({
    id: nextId(db, "safe_health_snapshots"),
    ...snapshot,
    chain_id: chainId,
    chain_name: snapshot.chain_name || snapshot.chainName || chainNameForId(chainId),
    safe_address: normalizeAddress(snapshot.safe_address),
    collateral_json: JSON.stringify(snapshot.collateral || []),
    borrows_json: JSON.stringify(snapshot.borrows || []),
    created_at: nowIso()
  });
}

function insertAggregateSnapshot(db, input) {
  db.state.aggregate_snapshots.push({ id: nextId(db, "aggregate_snapshots"), ...input, created_at: nowIso() });
}

function upsertAlertDefinitions(db, definitions) {
  const byId = Object.fromEntries((db.state.alert_definitions || []).map((definition) => [definition.id, definition]));
  db.state.alert_definitions = definitions.map((definition) => ({
    ...(byId[definition.id] || {}),
    ...definition,
    updated_at: nowIso(),
    created_at: byId[definition.id] && byId[definition.id].created_at || nowIso()
  }));
}

function insertAlertRun(db, input) {
  const row = { id: nextId(db, "alert_runs"), ...input, created_at: nowIso() };
  db.state.alert_runs.push(row);
  return row;
}

function findOpenAlertEvent(db, dedupeKey) {
  return [...(db.state.alert_events || [])].reverse().find((row) => row.dedupe_key === dedupeKey && row.status === "triggered") || null;
}

function triggerAlertEvent(db, input) {
  const now = nowIso();
  const existing = findOpenAlertEvent(db, input.dedupe_key);
  if (existing) {
    existing.last_fired_at = now;
    existing.fire_count = Number(existing.fire_count || 1) + 1;
    existing.severity = input.severity || existing.severity;
    existing.payload = input.payload || existing.payload;
    existing.updated_at = now;
    return { event: existing, created: false };
  }

  const event = {
    id: nextId(db, "alert_events"),
    status: "triggered",
    first_fired_at: now,
    last_fired_at: now,
    resolved_at: null,
    fire_count: 1,
    ...input,
    safe_address: normalizeAddress(input.safe_address),
    created_at: now,
    updated_at: now
  };
  db.state.alert_events.push(event);
  return { event, created: true };
}

function resolveAlertEvent(db, dedupeKey, payload = null) {
  const event = findOpenAlertEvent(db, dedupeKey);
  if (!event) return null;
  const now = nowIso();
  event.status = "resolved";
  event.resolved_at = now;
  event.payload = payload || event.payload;
  event.updated_at = now;
  return event;
}

function insertCollateralRun(db, input) {
  const row = { id: nextId(db, "collateral_runs"), ...input, created_at: nowIso() };
  db.state.collateral_runs.push(row);
  return row;
}

function insertCollateralSnapshot(db, input) {
  const chainId = Number(input.chain_id || input.chainId || config.rpc.chainId);
  const row = {
    id: nextId(db, "collateral_snapshots"),
    ...input,
    chain_id: chainId,
    chain_name: input.chain_name || input.chainName || chainNameForId(chainId),
    safe_address: normalizeAddress(input.safe_address),
    collateral_json: JSON.stringify(input.collateral || []),
    created_at: nowIso()
  };
  db.state.collateral_snapshots.push(row);
  const safe = db.state.safes[safeKey(chainId, row.safe_address)];
  if (safe) {
    safe.latest_collateral_json = row.collateral_json;
    safe.latest_collateral_usd = row.total_collateral_usd;
    safe.latest_collateral_refreshed_at = row.created_at;
    safe.updated_at = nowIso();
  }
  return row;
}

function getSafesForPolling(db, limit) {
  const latest = latestBySafe(db.state.safe_health_snapshots);
  return Object.values(db.state.safes)
    .sort((a, b) => {
      const aLast = latest[safeKey(a.chain_id, a.safe_address)] && latest[safeKey(a.chain_id, a.safe_address)].created_at;
      const bLast = latest[safeKey(b.chain_id, b.safe_address)] && latest[safeKey(b.chain_id, b.safe_address)].created_at;
      if (!aLast && bLast) return -1;
      if (aLast && !bLast) return 1;
      return String(aLast || a.updated_at).localeCompare(String(bLast || b.updated_at));
    })
    .slice(0, limit);
}

function latestBySafe(rows) {
  const latest = {};
  for (const row of rows) {
    const key = safeKey(row.chain_id, row.safe_address);
    const current = latest[key];
    if (!current || row.id > current.id) latest[key] = row;
  }
  return latest;
}

function getLatestHealthRows(db) {
  return Object.values(latestBySafe(db.state.safe_health_snapshots));
}

function getLatestBySource(db, table, source) {
  return [...db.state[table]].reverse().find((row) => row.source === source) || null;
}

module.exports = {
  openDb,
  initDb,
  resetDb,
  normalizeAddress,
  safeKey,
  upsertSafe,
  insertActivity,
  insertHealthSnapshot,
  insertAggregateSnapshot,
  upsertAlertDefinitions,
  insertAlertRun,
  triggerAlertEvent,
  resolveAlertEvent,
  insertCollateralRun,
  insertCollateralSnapshot,
  getSafesForPolling,
  getLatestHealthRows,
  getLatestBySource
};
