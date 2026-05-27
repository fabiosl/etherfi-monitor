const { getLatestHealthRows, insertAggregateSnapshot } = require("./db");

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

function writeLocalAggregateSnapshot(db) {
  const latestHealth = getLatestHealthRows(db).filter((row) => row.data_quality_state === "fresh");
  insertAggregateSnapshot(db, {
    source: "local_rpc",
    safe_count: Object.keys(db.state.safes).length,
    total_borrow_usd: sumBigint(latestHealth, "total_borrow_usd").toString(),
    total_collateral_usd: sumBigint(latestHealth, "total_collateral_usd").toString(),
    latest_block: latestHealth.reduce((max, row) => Math.max(max, row.block_number || 0), 0),
    data_as_of: new Date().toISOString(),
    raw_json: JSON.stringify({ evaluated_safes: latestHealth.length })
  });
  db.save();
}

module.exports = { writeLocalAggregateSnapshot };
