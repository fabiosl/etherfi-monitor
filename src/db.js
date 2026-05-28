const fs = require("fs");
const os = require("os");
const path = require("path");
const { Pool } = require("pg");
const config = require("./config");

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

function nowIso() {
  return new Date().toISOString();
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

function requireDatabaseUrl() {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required for PostgreSQL storage. Set it in .env and run npm run migrate.");
  }
}

async function migrate(pool) {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const exists = await pool.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [file]);
    if (exists.rowCount) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }
}

async function initDb(options = {}) {
  if (!options.pool) requireDatabaseUrl();
  const pool = options.pool || new Pool({ connectionString: config.databaseUrl });
  const db = {
    pool,
    owner: options.owner || `${os.hostname()}:${process.pid}:${Math.random().toString(16).slice(2)}`,
    async query(sql, params = []) {
      return pool.query(sql, params);
    },
    async reload() {
      return null;
    },
    async save() {
      return null;
    },
    async close() {
      if (!options.pool) await pool.end();
    }
  };
  if (options.migrate !== false) await migrate(pool);
  return db;
}

async function resetDb() {
  const db = await initDb();
  await db.query(`
    TRUNCATE
      borrow_discovery_runs,
      worker_leases,
      collateral_snapshots,
      collateral_runs,
      alert_events,
      alert_runs,
      alert_definitions,
      aggregate_snapshots,
      safe_health_snapshots,
      safe_activity,
      safes
    RESTART IDENTITY CASCADE
  `);
  return db;
}

async function migrateDb() {
  const db = await initDb();
  await db.close();
}

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function rowDates(row) {
  const copy = { ...row };
  for (const [key, value] of Object.entries(copy)) {
    if (value instanceof Date) copy[key] = value.toISOString();
  }
  return copy;
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

function healthRow(row) {
  const copy = rowDates(row);
  copy.collateral = parseJson(copy.collateral_json, []);
  copy.borrows = parseJson(copy.borrows_json, []);
  if (copy.collateral_json && typeof copy.collateral_json !== "string") copy.collateral_json = JSON.stringify(copy.collateral_json);
  if (copy.borrows_json && typeof copy.borrows_json !== "string") copy.borrows_json = JSON.stringify(copy.borrows_json);
  return copy;
}

async function upsertSafe(db, input) {
  const safe = normalizeAddress(input.safe_address || input.safe);
  if (!safe) return false;
  const chainId = Number(input.chain_id || input.chainId || config.optimism.chainId || 10);
  const chainName = input.chain_name || input.chainName || chainNameForId(chainId);
  const source = input.source || "unknown";
  const inserted = await db.query(`
    INSERT INTO safes (
      chain_id, chain_name, safe_address, safe_created_at, safe_created_block,
      first_seen_block, first_seen_at, last_seen_block, last_seen_at, last_borrowed_at,
      sources, status, created_at, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,ARRAY[$11]::text[],$12,now(),now())
    ON CONFLICT (chain_id, safe_address) DO NOTHING
    RETURNING safe_address
  `, [
    chainId,
    chainName,
    safe,
    input.safe_created_at || input.safe_createdAt || null,
    input.safe_created_block || input.safe_createdBlock || null,
    input.first_seen_block || null,
    input.first_seen_at || null,
    input.last_seen_block || input.first_seen_block || null,
    input.last_seen_at || input.first_seen_at || null,
    input.last_borrowed_at || null,
    source,
    input.status || (input.last_borrowed_at ? "active" : "discovered")
  ]);
  if (inserted.rowCount) return true;

  const existingResult = await db.query("SELECT * FROM safes WHERE chain_id = $1 AND safe_address = $2", [chainId, safe]);
  const existing = existingResult.rows[0] || {};
  const sources = [...new Set([...(existing.sources || []), source])].sort();
  await db.query(`
    UPDATE safes SET
      chain_name = $3,
      safe_created_at = $4,
      safe_created_block = $5,
      first_seen_block = $6,
      first_seen_at = $7,
      last_seen_block = $8,
      last_seen_at = $9,
      last_borrowed_at = $10,
      sources = $11,
      status = $12,
      updated_at = now()
    WHERE chain_id = $1 AND safe_address = $2
  `, [
    chainId,
    safe,
    chainName,
    minIso(existing.safe_created_at, input.safe_created_at || input.safe_createdAt || null),
    minNullable(existing.safe_created_block, input.safe_created_block || input.safe_createdBlock || null),
    minNullable(existing.first_seen_block, input.first_seen_block || null),
    minIso(existing.first_seen_at, input.first_seen_at || null),
    maxNullable(existing.last_seen_block, input.last_seen_block || input.first_seen_block || null),
    maxIso(existing.last_seen_at, input.last_seen_at || input.first_seen_at || null),
    maxIso(existing.last_borrowed_at, input.last_borrowed_at || null),
    sources,
    input.status === "active" ? "active" : existing.status || "discovered"
  ]);
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

function minIso(a, b) {
  if (!a) return b || null;
  if (!b) return iso(a);
  return new Date(a).getTime() <= new Date(b).getTime() ? iso(a) : iso(b);
}

function maxIso(a, b) {
  if (!a) return b || null;
  if (!b) return iso(a);
  return new Date(a).getTime() >= new Date(b).getTime() ? iso(a) : iso(b);
}

async function insertActivity(db, input) {
  const result = await db.query(`
    INSERT INTO safe_activity (
      source, activity_type, chain_id, chain_name, safe_address, token_address, amount,
      block_number, block_timestamp, tx_hash, log_index, created_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
    ON CONFLICT (source, tx_hash, log_index, activity_type) DO NOTHING
    RETURNING id
  `, [
    input.source,
    input.activity_type,
    Number(input.chain_id || config.optimism.chainId || 10),
    input.chain_name || chainNameForId(input.chain_id || config.optimism.chainId || 10),
    normalizeAddress(input.safe_address),
    normalizeAddress(input.token_address),
    input.amount == null ? null : String(input.amount),
    input.block_number || null,
    input.block_timestamp || null,
    input.tx_hash || null,
    input.log_index == null ? null : Number(input.log_index)
  ]);
  return result.rowCount > 0;
}

async function hasActivity(db, input) {
  const result = await db.query(`
    SELECT 1 FROM safe_activity
    WHERE source = $1 AND tx_hash = $2 AND log_index = $3 AND activity_type = $4
    LIMIT 1
  `, [input.source, input.tx_hash, Number(input.log_index), input.activity_type]);
  return result.rowCount > 0;
}

async function insertHealthSnapshot(db, snapshot) {
  const chainId = Number(snapshot.chain_id || snapshot.chainId || config.optimism.chainId || 10);
  await db.query(`
    INSERT INTO safe_health_snapshots (
      safe_address, chain_id, chain_name, source, block_number, block_timestamp, mode,
      total_collateral_usd, total_borrow_usd, max_borrow_ltv_usd, max_borrow_liquidation_usd,
      ltv_bps, liquidation_utilization_bps, health_status, data_quality_state,
      collateral_json, borrows_json, error, created_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,now())
  `, [
    normalizeAddress(snapshot.safe_address),
    chainId,
    snapshot.chain_name || snapshot.chainName || chainNameForId(chainId),
    snapshot.source || "rpc",
    snapshot.block_number || null,
    snapshot.block_timestamp || null,
    snapshot.mode || null,
    snapshot.total_collateral_usd,
    snapshot.total_borrow_usd,
    snapshot.max_borrow_ltv_usd,
    snapshot.max_borrow_liquidation_usd,
    snapshot.ltv_bps,
    snapshot.liquidation_utilization_bps,
    snapshot.health_status,
    snapshot.data_quality_state,
    JSON.stringify(snapshot.collateral || []),
    JSON.stringify(snapshot.borrows || []),
    snapshot.error || null
  ]);
}

async function insertAggregateSnapshot(db, input) {
  await db.query(`
    INSERT INTO aggregate_snapshots (
      source, safe_count, total_borrow_usd, total_collateral_usd, latest_block, data_as_of, raw_json, created_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,now())
  `, [
    input.source,
    input.safe_count || 0,
    input.total_borrow_usd || null,
    input.total_collateral_usd || null,
    input.latest_block || null,
    input.data_as_of || nowIso(),
    typeof input.raw_json === "string" ? input.raw_json : JSON.stringify(input.raw_json || {})
  ]);
}

async function upsertAlertDefinitions(db, definitions) {
  for (const definition of definitions) {
    await db.query(`
      INSERT INTO alert_definitions (id, name, severity, cadence, monitor, route, description, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        severity = EXCLUDED.severity,
        cadence = EXCLUDED.cadence,
        monitor = EXCLUDED.monitor,
        route = EXCLUDED.route,
        description = EXCLUDED.description,
        updated_at = now()
    `, [
      definition.id,
      definition.name,
      definition.severity,
      definition.cadence || null,
      definition.monitor || null,
      definition.route || null,
      definition.description || null
    ]);
  }
}

async function insertAlertRun(db, input) {
  const result = await db.query(`
    INSERT INTO alert_runs (
      alert_id, started_at, finished_at, status, evaluated_count, triggered_count, resolved_count, error, created_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
    RETURNING *
  `, [
    input.alert_id,
    input.started_at || null,
    input.finished_at || null,
    input.status,
    input.evaluated_count || 0,
    input.triggered_count || 0,
    input.resolved_count || 0,
    input.error || null
  ]);
  return rowDates(result.rows[0]);
}

async function findOpenAlertEvent(db, dedupeKey) {
  const result = await db.query("SELECT * FROM alert_events WHERE dedupe_key = $1 AND status = 'triggered' ORDER BY id DESC LIMIT 1", [dedupeKey]);
  return result.rows[0] ? rowDates(result.rows[0]) : null;
}

async function triggerAlertEvent(db, input) {
  const existing = await findOpenAlertEvent(db, input.dedupe_key);
  if (existing) {
    const result = await db.query(`
      UPDATE alert_events
      SET last_fired_at = now(),
          fire_count = fire_count + 1,
          severity = COALESCE($2, severity),
          payload = COALESCE($3::jsonb, payload),
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `, [existing.id, input.severity || null, JSON.stringify(input.payload || null)]);
    return { event: rowDates(result.rows[0]), created: false };
  }

  const result = await db.query(`
    INSERT INTO alert_events (
      alert_id, alert_name, severity, dedupe_key, chain_id, chain_name, safe_address,
      route, status, first_fired_at, last_fired_at, resolved_at, fire_count, payload,
      created_at, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'triggered',now(),now(),NULL,1,$9::jsonb,now(),now())
    RETURNING *
  `, [
    input.alert_id,
    input.alert_name,
    input.severity,
    input.dedupe_key,
    input.chain_id || null,
    input.chain_name || null,
    normalizeAddress(input.safe_address),
    input.route || null,
    JSON.stringify(input.payload || {})
  ]);
  return { event: rowDates(result.rows[0]), created: true };
}

async function resolveAlertEvent(db, dedupeKey, payload = null) {
  const result = await db.query(`
    UPDATE alert_events
    SET status = 'resolved', resolved_at = now(), payload = COALESCE($2::jsonb, payload), updated_at = now()
    WHERE id = (
      SELECT id FROM alert_events WHERE dedupe_key = $1 AND status = 'triggered' ORDER BY id DESC LIMIT 1
    )
    RETURNING *
  `, [dedupeKey, payload ? JSON.stringify(payload) : null]);
  return result.rows[0] ? rowDates(result.rows[0]) : null;
}

async function insertCollateralRun(db, input) {
  const result = await db.query(`
    INSERT INTO collateral_runs (started_at, finished_at, status, evaluated_count, refreshed_count, failed_count, error, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,now())
    RETURNING *
  `, [
    input.started_at || null,
    input.finished_at || null,
    input.status || null,
    input.evaluated_count || 0,
    input.refreshed_count || 0,
    input.failed_count || 0,
    input.error || null
  ]);
  return rowDates(result.rows[0]);
}

async function insertCollateralSnapshot(db, input) {
  const chainId = Number(input.chain_id || input.chainId || config.optimism.chainId || 10);
  const row = await db.query(`
    INSERT INTO collateral_snapshots (
      safe_address, chain_id, chain_name, source, block_number, block_timestamp,
      total_collateral_usd, collateral_json, data_quality_state, error, created_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,now())
    RETURNING *
  `, [
    normalizeAddress(input.safe_address),
    chainId,
    input.chain_name || input.chainName || chainNameForId(chainId),
    input.source || "rpc",
    input.block_number || null,
    input.block_timestamp || null,
    input.total_collateral_usd || null,
    JSON.stringify(input.collateral || []),
    input.data_quality_state || null,
    input.error || null
  ]);
  await db.query(`
    UPDATE safes
    SET latest_collateral_json = $3::jsonb,
        latest_collateral_usd = $4,
        latest_collateral_refreshed_at = now(),
        updated_at = now()
    WHERE chain_id = $1 AND safe_address = $2
  `, [chainId, normalizeAddress(input.safe_address), JSON.stringify(input.collateral || []), input.total_collateral_usd || null]);
  return rowDates(row.rows[0]);
}

async function getSafesForPolling(db, limit, options = {}) {
  const activeOnly = options.activeOnly !== false;
  const chainId = Number(options.chainId || config.optimism.chainId || 10);
  const params = [chainId, Number(limit || 10000)];
  let activeClause = "";
  if (activeOnly) {
    params.push(Number(options.lookbackHours || config.worker.activeSafeLookbackHours || 72));
    activeClause = "AND s.last_borrowed_at >= now() - ($3::text || ' hours')::interval";
  }
  const result = await db.query(`
    SELECT s.*, latest.latest_health_at
    FROM safes s
    LEFT JOIN (
      SELECT chain_id, safe_address, max(created_at) AS latest_health_at
      FROM safe_health_snapshots
      GROUP BY chain_id, safe_address
    ) latest ON latest.chain_id = s.chain_id AND latest.safe_address = s.safe_address
    WHERE s.chain_id = $1 ${activeClause}
    ORDER BY latest_health_at NULLS FIRST, s.last_borrowed_at DESC NULLS LAST, s.updated_at ASC
    LIMIT $2
  `, params);
  return result.rows.map(rowDates);
}

async function getSafesForHealthReconcile(db, limit, options = {}) {
  const chainId = Number(options.chainId || config.optimism.chainId || 10);
  const staleHours = Number(options.staleHours || config.worker.healthReconcileStaleHours || 24);
  const result = await db.query(`
    SELECT s.*, latest.latest_health_at
    FROM safes s
    LEFT JOIN (
      SELECT chain_id, safe_address, max(created_at) AS latest_health_at
      FROM safe_health_snapshots
      GROUP BY chain_id, safe_address
    ) latest ON latest.chain_id = s.chain_id AND latest.safe_address = s.safe_address
    WHERE s.chain_id = $1
      AND (
        latest.latest_health_at IS NULL
        OR latest.latest_health_at < now() - ($3::text || ' hours')::interval
      )
    ORDER BY latest.latest_health_at NULLS FIRST, s.updated_at ASC
    LIMIT $2
  `, [chainId, Number(limit || 10000), staleHours]);
  return result.rows.map(rowDates);
}

async function getCriticalSafesForHealth(db, limit, options = {}) {
  const chainId = Number(options.chainId || config.optimism.chainId || 10);
  const thresholdBps = Number(options.thresholdBps || config.worker.criticalHealthThresholdBps || 8800);
  const result = await db.query(`
    SELECT s.*, latest.latest_health_at, latest.liquidation_utilization_bps
    FROM safes s
    JOIN (
      SELECT DISTINCT ON (chain_id, safe_address)
        chain_id, safe_address, created_at AS latest_health_at, liquidation_utilization_bps
      FROM safe_health_snapshots
      WHERE chain_id = $1
      ORDER BY chain_id, safe_address, created_at DESC, id DESC
    ) latest ON latest.chain_id = s.chain_id AND latest.safe_address = s.safe_address
    WHERE s.chain_id = $1
      AND latest.liquidation_utilization_bps > $3
    ORDER BY latest.liquidation_utilization_bps DESC NULLS LAST, latest.latest_health_at ASC
    LIMIT $2
  `, [chainId, Number(limit || 10000), thresholdBps]);
  return result.rows.map(rowDates);
}

async function getRiskiestSafesForAsset(db, tokenAddress, options = {}) {
  const token = normalizeAddress(tokenAddress);
  if (!token) return [];
  const chainId = Number(options.chainId || config.optimism.chainId || 10);
  const percent = Math.max(1, Math.min(100, Number(options.percent || config.worker.assetRiskPercent || 30)));
  const limit = Number(options.limit || 10000);
  const latestRows = (await getLatestHealthRows(db))
    .filter((row) => Number(row.chain_id) === chainId)
    .filter((row) => Array.isArray(row.collateral) && row.collateral.some((item) => normalizeAddress(item.token) === token))
    .sort((a, b) => Number(b.liquidation_utilization_bps || -1) - Number(a.liquidation_utilization_bps || -1));
  const targetCount = Math.min(limit, Math.ceil(latestRows.length * (percent / 100)));
  return latestRows.slice(0, targetCount).map((row) => rowDates({
    chain_id: row.chain_id,
    chain_name: row.chain_name,
    safe_address: row.safe_address,
    latest_health_at: row.created_at,
    liquidation_utilization_bps: row.liquidation_utilization_bps
  }));
}

async function claimSafesForHealthRows(db, candidates, limit) {
  const claimed = [];
  for (const safe of candidates) {
    const key = `safe-health:${safe.chain_id}:${safe.safe_address}`;
    const ok = await acquireLease(db, key, config.worker.workerLeaseTtlMs);
    if (ok) claimed.push(safe);
    if (claimed.length >= Number(limit || candidates.length)) break;
  }
  return claimed;
}

async function claimSafesForHealth(db, limit, options = {}) {
  const candidates = await getSafesForPolling(db, limit * 3, options);
  return claimSafesForHealthRows(db, candidates, limit);
}

async function getLatestHealthRows(db) {
  const result = await db.query(`
    SELECT DISTINCT ON (chain_id, safe_address) *
    FROM safe_health_snapshots
    ORDER BY chain_id, safe_address, created_at DESC, id DESC
  `);
  return result.rows.map(healthRow);
}

async function getPreviousHealthForSafe(db, latest) {
  const result = await db.query(`
    SELECT * FROM safe_health_snapshots
    WHERE chain_id = $1 AND safe_address = $2 AND id <> $3
    ORDER BY id DESC
    LIMIT 1
  `, [Number(latest.chain_id), normalizeAddress(latest.safe_address), latest.id]);
  return result.rows[0] ? healthRow(result.rows[0]) : null;
}

async function getLatestBySource(db, table, source) {
  const allowed = new Set(["aggregate_snapshots"]);
  if (!allowed.has(table)) throw new Error(`Unsupported source lookup table: ${table}`);
  const result = await db.query(`SELECT * FROM ${table} WHERE source = $1 ORDER BY id DESC LIMIT 1`, [source]);
  return result.rows[0] ? rowDates(result.rows[0]) : null;
}

async function getSafes(db) {
  const result = await db.query("SELECT * FROM safes ORDER BY updated_at DESC");
  return result.rows.map(rowDates);
}

async function countSafes(db, options = {}) {
  const params = [];
  const where = [];
  if (options.chainId) {
    params.push(Number(options.chainId));
    where.push(`chain_id = $${params.length}`);
  }
  const result = await db.query(`SELECT count(*)::int AS count FROM safes ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`, params);
  return Number(result.rows[0].count || 0);
}

async function getAggregateSnapshots(db, limit = 25) {
  const result = await db.query("SELECT * FROM aggregate_snapshots ORDER BY id DESC LIMIT $1", [Number(limit)]);
  return result.rows.map(rowDates);
}

async function getHealthSnapshots(db) {
  const result = await db.query("SELECT * FROM safe_health_snapshots ORDER BY created_at ASC, id ASC");
  return result.rows.map(healthRow);
}

async function getAlertDefinitions(db) {
  const result = await db.query("SELECT * FROM alert_definitions ORDER BY id");
  return result.rows.map(rowDates);
}

async function getAlertRuns(db) {
  const result = await db.query("SELECT * FROM alert_runs ORDER BY id ASC");
  return result.rows.map(rowDates);
}

async function getAlertEvents(db) {
  const result = await db.query("SELECT * FROM alert_events ORDER BY id ASC");
  return result.rows.map(rowDates);
}

async function getOpenAlertEventsForDefinition(db, alertId, activeKeys) {
  const result = await db.query(`
    SELECT * FROM alert_events
    WHERE alert_id = $1 AND status = 'triggered' AND NOT (dedupe_key = ANY($2::text[]))
  `, [alertId, [...activeKeys]]);
  return result.rows.map(rowDates);
}

async function getSafeActivityRows(db) {
  const result = await db.query("SELECT * FROM safe_activity ORDER BY id ASC");
  return result.rows.map(rowDates);
}

async function countSafeActivity(db) {
  const result = await db.query("SELECT count(*)::int AS count FROM safe_activity");
  return Number(result.rows[0].count || 0);
}

async function acquireLease(db, leaseKey, ttlMs = config.worker.workerLeaseTtlMs) {
  const expiresAt = new Date(Date.now() + Number(ttlMs)).toISOString();
  await db.query(`
    INSERT INTO worker_leases (lease_key, owner, expires_at, updated_at)
    VALUES ($1, $2, $3, now())
    ON CONFLICT (lease_key) DO NOTHING
  `, [leaseKey, db.owner, expiresAt]);

  const current = await db.query("SELECT owner, expires_at FROM worker_leases WHERE lease_key = $1", [leaseKey]);
  const row = current.rows[0];
  if (row && row.owner === db.owner) return true;
  if (row && row.expires_at && new Date(row.expires_at).getTime() >= Date.now()) return false;

  await db.query(`
    UPDATE worker_leases
    SET owner = $2,
        expires_at = $3,
        updated_at = now()
    WHERE lease_key = $1 AND (expires_at < now() OR owner = $2)
  `, [leaseKey, db.owner, expiresAt]);
  const updated = await db.query("SELECT owner FROM worker_leases WHERE lease_key = $1", [leaseKey]);
  return Boolean(updated.rows[0] && updated.rows[0].owner === db.owner);
}

async function releaseLease(db, leaseKey) {
  await db.query("DELETE FROM worker_leases WHERE lease_key = $1 AND owner = $2", [leaseKey, db.owner]);
}

async function insertBorrowDiscoveryRun(db, input) {
  const result = await db.query(`
    INSERT INTO borrow_discovery_runs (
      chain_id, chain_name, started_at, finished_at, latest_scanned_block,
      oldest_scanned_block, new_events, stop_reason, error, created_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
    RETURNING *
  `, [
    Number(input.chain_id),
    input.chain_name,
    input.started_at || null,
    input.finished_at || null,
    input.latest_scanned_block || null,
    input.oldest_scanned_block || null,
    input.new_events || 0,
    input.stop_reason || null,
    input.error || null
  ]);
  return rowDates(result.rows[0]);
}

module.exports = {
  initDb,
  resetDb,
  migrateDb,
  normalizeAddress,
  safeKey,
  chainNameForId,
  upsertSafe,
  insertActivity,
  hasActivity,
  insertHealthSnapshot,
  insertAggregateSnapshot,
  upsertAlertDefinitions,
  insertAlertRun,
  triggerAlertEvent,
  resolveAlertEvent,
  insertCollateralRun,
  insertCollateralSnapshot,
  getSafesForPolling,
  getSafesForHealthReconcile,
  getCriticalSafesForHealth,
  getRiskiestSafesForAsset,
  claimSafesForHealthRows,
  claimSafesForHealth,
  getLatestHealthRows,
  getPreviousHealthForSafe,
  getLatestBySource,
  getSafes,
  countSafes,
  getAggregateSnapshots,
  getHealthSnapshots,
  getAlertDefinitions,
  getAlertRuns,
  getAlertEvents,
  getOpenAlertEventsForDefinition,
  getSafeActivityRows,
  countSafeActivity,
  acquireLease,
  releaseLease,
  insertBorrowDiscoveryRun
};
