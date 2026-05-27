const fs = require("fs");
const { initDb, upsertSafe, getSafesForPolling, insertAggregateSnapshot } = require("./db");
const { pollSafes } = require("./rpcHealth");
const { importLatestFactorySafesForAllChains } = require("./factoryDiscovery");
const { writeLocalAggregateSnapshot } = require("./localAggregates");

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function importCsv(db, filePath) {
  const content = fs.readFileSync(filePath, "utf8").trim();
  const [headerLine, ...lines] = content.split(/\r?\n/);
  const headers = parseCsvLine(headerLine).map((header) => header.trim().toLowerCase());
  let count = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const values = parseCsvLine(line);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    if (upsertSafe(db, { ...row, source: row.source || "csv" })) count += 1;
  }
  db.save();
  return count;
}

function demoSeed(db) {
  const safes = [
    "0x11c4ea88ca616e17cd8f6c268f63216aadef67c1",
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000002"
  ];
  for (const safe of safes) upsertSafe(db, { safe_address: safe, source: "demo_seed" });
  insertAggregateSnapshot(db, {
    source: "demo",
    safe_count: 3,
    total_borrow_usd: "0",
    total_collateral_usd: "0",
    latest_block: null,
    data_as_of: new Date().toISOString(),
    raw_json: '{"demo":true}'
  });
  db.save();
  return safes.length;
}

async function main() {
  const command = process.argv[2];
  if (command === "init-db") {
    initDb().close();
    console.log("Database initialized.");
    return;
  }

  const db = initDb();
  try {
    if (command === "import-factory") {
      const limit = Number(process.argv[3] || 100);
      const results = await importLatestFactorySafesForAllChains(db, limit);
      console.log(JSON.stringify(results.map((result) => ({
        chainId: result.chainId,
        chainName: result.chainName,
        total: result.total,
        start: result.start,
        end: result.end,
        requested: limit,
        imported: result.imported,
        strategy: result.strategy,
        first: result.addresses && result.addresses[0] || null,
        last: result.addresses && result.addresses[result.addresses.length - 1] || null,
        error: result.error || null
      })), null, 2));
    } else if (command === "import-csv") {
      const filePath = process.argv[3];
      if (!filePath) throw new Error("Usage: npm run import-csv -- ./safes.csv");
      const count = importCsv(db, filePath);
      console.log(`Imported ${count} safes from CSV.`);
    } else if (command === "poll-health") {
      const limit = Number(process.argv[3] || 10000);
      const safes = getSafesForPolling(db, limit);
      const results = await pollSafes(db, safes);
      writeLocalAggregateSnapshot(db);
      console.log(`Polled ${results.length} safes.`);
      const failed = results.filter((row) => row.data_quality_state === "rpc_failed").length;
      if (failed) console.log(`${failed} RPC reads failed.`);
    } else if (command === "demo-seed") {
      const count = demoSeed(db);
      console.log(`Seeded ${count} demo safes.`);
    } else {
      console.log("Commands: init-db, import-factory, import-csv, poll-health, demo-seed");
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
