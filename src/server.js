const express = require("express");
const { initDb, getLatestHealthRows, getLatestBySource, safeKey } = require("./db");
const config = require("./config");

const db = initDb();
const app = express();

app.use(express.json());
app.use(express.static("public"));

app.get("/api/summary", (req, res) => {
  const latestHealth = getLatestHealthRows(db);
  const safes = Object.keys(db.state.safes).length;
  const counts = new Map();
  for (const row of latestHealth) counts.set(row.health_status, (counts.get(row.health_status) || 0) + 1);
  const byStatus = [...counts.entries()].map(([health_status, count]) => ({ health_status, count }));
  const latestLocal = getLatestBySource(db, "aggregate_snapshots", "local_rpc");

  res.json({
    safes,
    evaluatedSafes: latestHealth.length,
    byStatus,
    latestLocal
  });
});

app.get("/api/safes", (req, res) => {
  const status = req.query.status;
  const latest = Object.fromEntries(getLatestHealthRows(db).map((row) => [safeKey(row.chain_id, row.safe_address), row]));
  const rank = { critical: 1, warning: 2, unknown: 3, healthy: 4, inactive: 5 };
  const rows = Object.values(db.state.safes)
    .map((safe) => {
      const health = latest[safeKey(safe.chain_id, safe.safe_address)];
      return { ...safe, ...(health || {}), last_evaluated_at: health && health.created_at };
    })
    .filter((row) => !status || row.health_status === status)
    .sort((a, b) => {
      const rankDelta = (rank[a.health_status] || 6) - (rank[b.health_status] || 6);
      if (rankDelta) return rankDelta;
      return (b.liquidation_utilization_bps || -1) - (a.liquidation_utilization_bps || -1);
    })
    .slice(0, 250);
  res.json(rows);
});

app.get("/api/runs", (req, res) => {
  res.json({
    aggregateSnapshots: [...db.state.aggregate_snapshots].reverse().slice(0, 25)
  });
});

app.listen(config.port, "127.0.0.1", () => {
  console.log(`EtherFi safe monitor listening at http://127.0.0.1:${config.port}`);
});
