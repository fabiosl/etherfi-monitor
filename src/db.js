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

function upsertSafe(db, input) {
  const safe = normalizeAddress(input.safe_address || input.safe);
  if (!safe) return false;
  const existing = db.state.safes[safe];
  const sources = new Set(existing ? existing.sources || [] : []);
  sources.add(input.source || "unknown");

  db.state.safes[safe] = {
    safe_address: safe,
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
  db.state.safe_health_snapshots.push({
    id: nextId(db, "safe_health_snapshots"),
    ...snapshot,
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
      const aLast = latest[a.safe_address] && latest[a.safe_address].created_at;
      const bLast = latest[b.safe_address] && latest[b.safe_address].created_at;
      if (!aLast && bLast) return -1;
      if (aLast && !bLast) return 1;
      return String(aLast || a.updated_at).localeCompare(String(bLast || b.updated_at));
    })
    .slice(0, limit);
}

function latestBySafe(rows) {
  const latest = {};
  for (const row of rows) {
    const current = latest[row.safe_address];
    if (!current || row.id > current.id) latest[row.safe_address] = row;
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
  normalizeAddress,
  upsertSafe,
  insertActivity,
  insertHealthSnapshot,
  insertAggregateSnapshot,
  getSafesForPolling,
  getLatestHealthRows,
  getLatestBySource
};
