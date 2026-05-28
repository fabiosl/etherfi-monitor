const { DataType, newDb } = require("pg-mem");

function createTestPool() {
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  memoryDb.public.registerFunction({
    name: "now",
    returns: DataType.timestamptz,
    implementation: () => new Date()
  });
  for (const type of [DataType.timestamptz, DataType.bigint]) {
    memoryDb.public.registerFunction({
      name: "least",
      args: [type, type],
      returns: type,
      implementation: (a, b) => a <= b ? a : b
    });
    memoryDb.public.registerFunction({
      name: "greatest",
      args: [type, type],
      returns: type,
      implementation: (a, b) => a >= b ? a : b
    });
  }
  const { Pool } = memoryDb.adapters.createPg();
  return new Pool();
}

module.exports = { createTestPool };
