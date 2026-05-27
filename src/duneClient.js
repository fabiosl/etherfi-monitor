const config = require("./config");
const { normalizeAddress, upsertSafe, insertActivity, insertDuneRun, insertAggregateSnapshot } = require("./db");

function requireDuneKey() {
  if (!config.dune.apiKey) throw new Error("DUNE_API_KEY is required for Dune imports");
}

function normalizeRow(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row || {})) {
    normalized[String(key).toLowerCase()] = value;
  }
  return normalized;
}

async function duneGet(path, params = {}) {
  requireDuneKey();
  const url = new URL(`https://api.dune.com/api/v1${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: { "x-dune-api-key": config.dune.apiKey }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Dune API ${response.status}: ${body}`);
  }
  return response.json();
}

async function fetchLatestQueryRows(queryId) {
  const rows = [];
  let offset = 0;
  const limit = config.dune.pageSize;
  let executionId = null;
  let latestBlock = null;
  let dataAsOf = null;

  while (true) {
    const payload = await duneGet(`/query/${queryId}/results`, { limit, offset });
    const result = payload.result || {};
    executionId = payload.execution_id || payload.executionId || executionId;
    latestBlock = payload.latest_block || result.latest_block || latestBlock;
    dataAsOf = payload.submitted_at || payload.execution_ended_at || dataAsOf;
    const batch = (result.rows || []).map(normalizeRow);
    rows.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }

  return { rows, executionId, latestBlock, dataAsOf };
}

function importSafeUniverse(db, rows) {
  let count = 0;
  for (const row of rows) {
    const ok = upsertSafe(db, {
      safe_address: row.safe_address || row.safe,
      source: row.source || "dune_safe_universe",
      first_seen_block: row.first_seen_block || row.block_number,
      first_seen_at: row.first_seen_at || row.block_time,
      last_seen_block: row.last_seen_block || row.block_number,
      last_seen_at: row.last_seen_at || row.block_time
    });
    if (ok) count += 1;
  }
  db.save();
  return count;
}

function importRecentActivity(db, rows) {
  let count = 0;
  for (const row of rows) {
    const safe = normalizeAddress(row.safe_address || row.safe);
    if (!safe) continue;
    upsertSafe(db, {
      safe_address: safe,
      source: row.source || "dune_recent_activity",
      first_seen_block: row.block_number,
      first_seen_at: row.happened_at || row.block_time,
      last_seen_block: row.block_number,
      last_seen_at: row.happened_at || row.block_time
    });
    const inserted = insertActivity(db, {
      safe_address: safe,
      activity_type: row.activity_type || row.event_name || "unknown",
      token_address: normalizeAddress(row.token_address || row.token),
      amount: row.amount == null ? null : String(row.amount),
      amount_usd: row.amount_usd == null ? null : String(row.amount_usd),
      block_number: row.block_number || null,
      tx_hash: row.tx_hash || null,
      log_index: row.log_index || null,
      happened_at: row.happened_at || row.block_time || null,
      source: row.source || "dune_recent_activity"
    });
    if (inserted) count += 1;
  }
  db.save();
  return count;
}

function importAggregates(db, rows) {
  const row = rows[0] || {};
  insertAggregateSnapshot(db, {
    source: "dune",
    safe_count: row.safe_count || row.total_safes || null,
    total_borrow_usd: row.total_borrow_usd == null ? null : String(row.total_borrow_usd),
    total_collateral_usd: row.total_collateral_usd == null ? null : String(row.total_collateral_usd),
    latest_block: row.latest_block || row.block_number || null,
    data_as_of: row.data_as_of || row.block_time || null,
    raw_json: JSON.stringify(row)
  });
  db.save();
  return rows.length > 0 ? 1 : 0;
}

async function importConfiguredDuneQueries(db) {
  const jobs = [
    ["safe_universe", config.dune.safeUniverseQueryId, importSafeUniverse],
    ["recent_activity", config.dune.recentActivityQueryId, importRecentActivity],
    ["aggregates", config.dune.aggregatesQueryId, importAggregates]
  ].filter(([, queryId]) => queryId);

  const results = [];
  for (const [kind, queryId, importer] of jobs) {
    try {
      const { rows, executionId, latestBlock, dataAsOf } = await fetchLatestQueryRows(queryId);
      const count = importer(db, rows);
      insertDuneRun(db, {
        query_id: queryId,
        query_kind: kind,
        execution_id: executionId,
        row_count: count,
        latest_block: latestBlock,
        data_as_of: dataAsOf,
        status: "ok",
        error: null
      });
      db.save();
      results.push({ kind, queryId, rows: rows.length, imported: count });
    } catch (error) {
      insertDuneRun(db, {
        query_id: queryId,
        query_kind: kind,
        execution_id: null,
        row_count: 0,
        latest_block: null,
        data_as_of: null,
        status: "error",
        error: error.message
      });
      db.save();
      throw error;
    }
  }
  return results;
}

module.exports = {
  fetchLatestQueryRows,
  importConfiguredDuneQueries,
  importSafeUniverse,
  importRecentActivity,
  importAggregates
};
