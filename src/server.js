const express = require("express");
const {
  countSafes,
  getAggregateSnapshots,
  getHealthSnapshots,
  getLatestHealthRows,
  getSafes,
  getLatestBySource,
  initDb,
  safeKey
} = require("./db");
const config = require("./config");
const { buildAlertSummaries } = require("./alerts");

const app = express();

app.use(express.json());
app.use(express.static("public"));

const TOKEN_METADATA = {
  "0x08c6f91e2b681faf5e17227f2a44c307b3c1364c": { symbol: "liquidUSD", name: "Ether.Fi Liquid USD" },
  "0x0b2c639c533813f4aa9d7837caf62653d097ff85": { symbol: "USDC", name: "USD Coin" },
  "0x4200000000000000000000000000000000000006": { symbol: "WETH", name: "Wrapped Ether" },
  "0x5a7facb970d094b6c7ff1df0ea68d99e6e73cbff": { symbol: "weETH", name: "Wrapped eETH" },
  "0x5f46d540b6ed704c3c8789105f30e075aa900726": { symbol: "liquidBTC", name: "Ether.Fi Liquid BTC" },
  "0x657e8c867d8b37dcc18fa4caead9c45eb088c642": { symbol: "eBTC", name: "ether.fi BTC" },
  "0x80eede496655fb9047dd39d9f418d5483ed600df": { symbol: "frxUSD", name: "Frax USD" },
  "0x86b5780b606940eb59a062aa85a07959518c0161": { symbol: "sETHFI", name: "Staked ETHFI" },
  "0x939778d83b46b456224a33fb59630b11dec56663": { symbol: "eUSD", name: "EtherFi USD" },
  "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58": { symbol: "USDT", name: "Tether USD" },
  "0xa519afbc91986c0e7501d7e34968fee51cd901ac": { symbol: "beHYPE", name: "hyperbeat x ether.fi HYPE" },
  "0xca5921df65e2e1b0b98ae91c0187ba80d4124898": { symbol: "liquidRESERVE", name: "Ether.Fi Liquid Reserve" },
  "0xcc476b1a49bcdf5192561e87b6fb8ea78aa28c13": { symbol: "weEUR", name: "Liquid Euro" },
  "0xd83e3d560ba6f05094d9d8b3eb8aaea571d1864e": { symbol: "WHYPE", name: "Wrapped HYPE" },
  "0xdcb612005417dc906ff72c87df732e5a90d49e11": { symbol: "EURC", name: "EURC" },
  "0xe0080d2f853ecddbd81a643dc10da075df26fd3f": { symbol: "ETHFI", name: "ether.fi governance token" },
  "0xf0bb20865277abd641a307ece5ee04e79073416c": { symbol: "liquidETH", name: "Ether.Fi Liquid ETH" }
};

function scoreHealthRows(rows) {
  const usableRows = rows.filter((row) => Number.isFinite(Number(row.liquidation_utilization_bps)));
  if (!usableRows.length) {
    return {
      healthScore: null,
      averageLiquidationUtilizationPct: null,
      sampleSize: 0
    };
  }

  const totalUtilizationPct = usableRows.reduce((sum, row) => {
    return sum + Math.min(100, Math.max(0, Number(row.liquidation_utilization_bps) / 100));
  }, 0);
  const averageLiquidationUtilizationPct = totalUtilizationPct / usableRows.length;

  return {
    healthScore: Math.round(100 - averageLiquidationUtilizationPct),
    averageLiquidationUtilizationPct: Math.round(averageLiquidationUtilizationPct * 10) / 10,
    sampleSize: usableRows.length
  };
}

function statusCounts(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.health_status, (counts.get(row.health_status) || 0) + 1);
  return [...counts.entries()].map(([health_status, count]) => ({ health_status, count }));
}

function maxIso(rows, field = "created_at") {
  return rows.reduce((latest, row) => {
    const value = row && row[field];
    if (!value) return latest;
    return !latest || new Date(value).getTime() > new Date(latest).getTime() ? value : latest;
  }, null);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeTokenRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function matchesCollateralFilter(row, filter) {
  if (!filter) return true;
  const query = filter.toLowerCase();
  return normalizeTokenRows(row.collateral).some((item) => {
    const token = String(item.token || "").toLowerCase();
    const metadata = TOKEN_METADATA[token] || {};
    return [
      token,
      metadata.symbol,
      metadata.name
    ].some((value) => String(value || "").toLowerCase().includes(query));
  });
}

app.get("/api/summary", async (req, res, next) => {
  try {
  const latestHealth = await getLatestHealthRows(req.app.locals.db);
  const safes = await countSafes(req.app.locals.db, { chainId: config.optimism.chainId });
  const latestLocal = await getLatestBySource(req.app.locals.db, "aggregate_snapshots", "local_rpc");

  res.json({
    safes,
    evaluatedSafes: latestHealth.length,
    byStatus: statusCounts(latestHealth),
    portfolioHealth: scoreHealthRows(latestHealth),
    latestLocal
  });
  } catch (error) {
    next(error);
  }
});

app.get("/api/safes", async (req, res, next) => {
  try {
  const status = req.query.status;
  const safeFilter = String(req.query.safe || "").trim().toLowerCase();
  const collateralFilter = String(req.query.collateral || "").trim();
  const minPageSize = 50;
  const maxPageSize = 250;
  const page = positiveInteger(req.query.page, 1);
  const pageSize = Math.min(maxPageSize, Math.max(minPageSize, positiveInteger(req.query.pageSize, minPageSize)));
  const latest = Object.fromEntries((await getLatestHealthRows(req.app.locals.db)).map((row) => [safeKey(row.chain_id, row.safe_address), row]));
  const rank = { critical: 1, warning: 2, unknown: 3, healthy: 4, inactive: 5 };
  const rows = (await getSafes(req.app.locals.db))
    .map((safe) => {
      const health = latest[safeKey(safe.chain_id, safe.safe_address)];
      return { ...safe, ...(health || {}), last_evaluated_at: health && health.created_at };
    })
    .filter((row) => !status || row.health_status === status)
    .filter((row) => !safeFilter || String(row.safe_address || "").toLowerCase().includes(safeFilter))
    .filter((row) => matchesCollateralFilter(row, collateralFilter))
    .sort((a, b) => {
      const rankDelta = (rank[a.health_status] || 6) - (rank[b.health_status] || 6);
      if (rankDelta) return rankDelta;
      return (b.liquidation_utilization_bps || -1) - (a.liquidation_utilization_bps || -1);
    });
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;

  res.json({
    rows: rows.slice(start, start + pageSize),
    pagination: {
      page: currentPage,
      pageSize,
      totalRows,
      totalPages,
      hasPreviousPage: currentPage > 1,
      hasNextPage: currentPage < totalPages,
      minPageSize
    }
  });
  } catch (error) {
    next(error);
  }
});

app.get("/api/runs", async (req, res, next) => {
  try {
  res.json({
    aggregateSnapshots: await getAggregateSnapshots(req.app.locals.db, 25)
  });
  } catch (error) {
    next(error);
  }
});

app.get("/api/alerts", async (req, res, next) => {
  try {
    res.json(await buildAlertSummaries(req.app.locals.db, req.query));
  } catch (error) {
    next(error);
  }
});

app.get("/api/health-trend", async (req, res, next) => {
  try {
  const rows = (await getHealthSnapshots(req.app.locals.db))
    .filter((row) => row.created_at)
    .sort((a, b) => {
      const timeDelta = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      if (timeDelta) return timeDelta;
      return Number(a.id || 0) - Number(b.id || 0);
    });
  const latestBySafe = new Map();
  const pointsByMinute = new Map();

  for (const row of rows) {
    latestBySafe.set(safeKey(row.chain_id, row.safe_address), row);
    const minute = row.created_at.slice(0, 16);
    const score = scoreHealthRows([...latestBySafe.values()]);
    if (score.healthScore !== null) {
      pointsByMinute.set(minute, {
        timestamp: `${minute}:00.000Z`,
        ...score,
        byStatus: statusCounts([...latestBySafe.values()])
      });
    }
  }

  const latestRows = await getLatestHealthRows(req.app.locals.db);
  const currentScore = scoreHealthRows(latestRows);
  if (currentScore.healthScore !== null) {
    const currentMinute = maxIso(latestRows, "created_at").slice(0, 16);
    pointsByMinute.set(currentMinute, {
      timestamp: `${currentMinute}:00.000Z`,
      ...currentScore,
      byStatus: statusCounts(latestRows)
    });
  }

  const points = [...pointsByMinute.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, point]) => point)
    .slice(-60);

  res.json({ points });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: error.message });
});

async function startServer() {
  const db = await initDb();
  app.locals.db = db;
  return app.listen(config.port, "127.0.0.1", () => {
    console.log(`EtherFi safe monitor listening at http://127.0.0.1:${config.port}`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { app, startServer };
