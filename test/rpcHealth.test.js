const assert = require("node:assert/strict");
const test = require("node:test");

const { classifyHealth } = require("../src/rpcHealth");

test("RPC health classifies liquidation utilization above 88 percent as critical", () => {
  assert.equal(classifyHealth(8800n, 9000n, 10000n, false, true).healthStatus, "warning");
  assert.equal(classifyHealth(8801n, 9000n, 10000n, false, true).healthStatus, "critical");
});
