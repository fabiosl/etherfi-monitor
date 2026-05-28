const fs = require("fs");
const { initDb, migrateDb, resetDb, upsertSafe, insertAggregateSnapshot } = require("./db");
const { importLatestFactorySafesForAllChains } = require("./factoryDiscovery");
const { importLatestBorrowActivitySafesForAllChains } = require("./borrowActivityDiscovery");
const {
  runAlertEvaluationJob,
  runAssetRiskHealthPollingJob,
  runBorrowDiscoveryJob,
  runCriticalHealthPollingJob,
  runHealthReconcileJob,
  runHealthPollingJob
} = require("./workerJobs");

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

async function importCsv(db, filePath) {
  const content = fs.readFileSync(filePath, "utf8").trim();
  const [headerLine, ...lines] = content.split(/\r?\n/);
  const headers = parseCsvLine(headerLine).map((header) => header.trim().toLowerCase());
  let count = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const values = parseCsvLine(line);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    if (await upsertSafe(db, { ...row, chain_id: row.chain_id || 10, chain_name: row.chain_name || "Optimism", source: row.source || "csv" })) count += 1;
  }
  await db.save();
  return count;
}

async function demoSeed(db) {
  const safes = [
    "0x11c4ea88ca616e17cd8f6c268f63216aadef67c1",
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000002"
  ];
  for (const safe of safes) await upsertSafe(db, { safe_address: safe, chain_id: 10, chain_name: "Optimism", source: "demo_seed" });
  await insertAggregateSnapshot(db, {
    source: "demo",
    safe_count: 3,
    total_borrow_usd: "0",
    total_collateral_usd: "0",
    latest_block: null,
    data_as_of: new Date().toISOString(),
    raw_json: '{"demo":true}'
  });
  await db.save();
  return safes.length;
}

async function main() {
  const command = process.argv[2];
  if (command === "init-db" || command === "migrate") {
    await migrateDb();
    console.log("PostgreSQL database initialized.");
    return;
  }

  const shouldReset = command === "clean-import-borrows";
  const db = shouldReset ? await resetDb() : await initDb();
  try {
    if (command === "clean-import-borrows") {
      const limit = Number(process.argv[3] || 100);
      const result = await importLatestBorrowActivitySafesForAllChains(db, limit);
      console.log(JSON.stringify({
        requested: result.requested,
        imported: result.imported,
        chains: result.chains,
        newest: result.safes[0] || null,
        oldest: result.safes[result.safes.length - 1] || null
      }, null, 2));
    } else if (command === "import-factory") {
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
    } else if (command === "worker:discovery" || command === "discover-borrows") {
      const limit = process.argv[3] ? Number(process.argv[3]) : undefined;
      const result = await runBorrowDiscoveryJob(db, { limit });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "worker:health" || command === "poll-health") {
      const limit = process.argv[3] ? Number(process.argv[3]) : undefined;
      const result = await runHealthPollingJob(db, { limit });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "worker:health:reconcile") {
      const limit = process.argv[3] ? Number(process.argv[3]) : undefined;
      const result = await runHealthReconcileJob(db, { limit });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "worker:health:critical") {
      const limit = process.argv[3] ? Number(process.argv[3]) : undefined;
      const result = await runCriticalHealthPollingJob(db, { limit });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "worker:health:asset") {
      const tokenAddress = process.argv[3];
      const limit = process.argv[4] ? Number(process.argv[4]) : undefined;
      const result = await runAssetRiskHealthPollingJob(db, { tokenAddress, limit });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "worker:alerts" || command === "evaluate-alerts") {
      const result = await runAlertEvaluationJob(db);
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "import-csv") {
      const filePath = process.argv[3];
      if (!filePath) throw new Error("Usage: npm run import-csv -- ./safes.csv");
      const count = await importCsv(db, filePath);
      console.log(`Imported ${count} safes from CSV.`);
    } else if (command === "demo-seed") {
      const count = await demoSeed(db);
      console.log(`Seeded ${count} demo safes.`);
    } else {
      console.log("Commands: init-db, clean-import-borrows, worker:discovery, worker:health, worker:health:reconcile, worker:health:critical, worker:health:asset, worker:alerts, import-factory, import-csv, poll-health, demo-seed");
      process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
