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
    seq: {
      safe_activity: 1,
      safe_health_snapshots: 1,
      aggregate_snapshots: 1
    }
  };
}

function openDb() {
  fs.mkdirSync(path.dirname(config.dataPath), { recursive: true });
  if (!fs.existsSync(config.dataPath)) {
    fs.writeFileSync(config.dataPath, JSON.stringify(defaultState(), null, 2));
  }
  const state = JSON.parse(fs.readFileSync(config.dataPath, "utf8"));
  migrateState(state);
  return {
    state,
    save() {
      fs.writeFileSync(config.dataPath, JSON.stringify(state, null, 2));
    },
    close() {
      this.save();
    }
  };
}

function resetDb() {
  fs.mkdirSync(path.dirname(config.dataPath), { recursive: true });
  fs.writeFileSync(config.dataPath, JSON.stringify(defaultState(), null, 2));
  return openDb();
}

function migrateState(state) {
  state.safes ||= {};
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
  getSafesForPolling,
  getLatestHealthRows,
  getLatestBySource
};
