const { getLatestHealthRows, getLatestBySource, insertAggregateSnapshot, insertReconciliationCheck } = require("./db");

function sumBigint(rows, column) {
  return rows.reduce((acc, row) => {
    if (row[column] === null || row[column] === undefined || row[column] === "") return acc;
    try {
      return acc + BigInt(row[column]);
    } catch {
      return acc;
    }
  }, 0n);
}

function percentDelta(local, remote) {
  if (!remote || remote === 0n) return local === 0n ? 0 : 10000;
  const diff = local > remote ? local - remote : remote - local;
  return Number((diff * 10000n) / remote);
}

function insertCheck(db, checkName, status, duneValue, localValue, details = {}) {
  let delta = null;
  try {
    if (duneValue !== null && localValue !== null) delta = (BigInt(localValue) - BigInt(duneValue)).toString();
  } catch {
    delta = null;
  }
  insertReconciliationCheck(db, {
    check_name: checkName,
    status,
    dune_value: duneValue == null ? null : String(duneValue),
    local_value: localValue == null ? null : String(localValue),
    delta_value: delta,
    details_json: JSON.stringify(details)
  });
}

function reconcile(db) {
  const latestDune = getLatestBySource(db, "aggregate_snapshots", "dune");
  const localHealth = getLatestHealthRows(db).filter((row) => row.data_quality_state === "fresh");
  const localSafeCount = Object.keys(db.state.safes).length;
  const localBorrow = sumBigint(localHealth, "total_borrow_usd");
  const localCollateral = sumBigint(localHealth, "total_collateral_usd");

  insertAggregateSnapshot(db, {
    source: "local_rpc",
    safe_count: localSafeCount,
    total_borrow_usd: localBorrow.toString(),
    total_collateral_usd: localCollateral.toString(),
    latest_block: localHealth.reduce((max, row) => Math.max(max, row.block_number || 0), 0),
    data_as_of: new Date().toISOString(),
    raw_json: JSON.stringify({ evaluated_safes: localHealth.length })
  });

  if (!latestDune) {
    insertCheck(db, "dune_snapshot_present", "warn", null, "missing", { message: "No Dune aggregate snapshot imported yet." });
    db.save();
    return { status: "warn", message: "No Dune aggregate snapshot imported yet." };
  }

  const checks = [];
  const safeCountStatus = Number(latestDune.safe_count || 0) === Number(localSafeCount) ? "ok" : "warn";
  insertCheck(db, "safe_count", safeCountStatus, latestDune.safe_count, localSafeCount);
  checks.push({ check: "safe_count", status: safeCountStatus });

  if (latestDune.total_borrow_usd != null) {
    const remote = BigInt(String(latestDune.total_borrow_usd));
    const status = percentDelta(localBorrow, remote) <= 100 ? "ok" : "warn";
    insertCheck(db, "total_borrow_usd", status, latestDune.total_borrow_usd, localBorrow.toString(), { tolerance_bps: 100 });
    checks.push({ check: "total_borrow_usd", status });
  }

  if (latestDune.total_collateral_usd != null) {
    const remote = BigInt(String(latestDune.total_collateral_usd));
    const status = percentDelta(localCollateral, remote) <= 100 ? "ok" : "warn";
    insertCheck(db, "total_collateral_usd", status, latestDune.total_collateral_usd, localCollateral.toString(), { tolerance_bps: 100 });
    checks.push({ check: "total_collateral_usd", status });
  }

  db.save();
  return { status: checks.some((check) => check.status !== "ok") ? "warn" : "ok", checks };
}

module.exports = { reconcile };
