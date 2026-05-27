const assert = require("node:assert/strict");
const test = require("node:test");

const { createScheduledJob } = require("../src/scheduler");

test("scheduled jobs do not overlap", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const job = createScheduledJob("test", 1000, async () => {
    calls += 1;
    await gate;
  }, { runImmediately: false });

  const first = job.runOnce();
  const second = await job.runOnce();
  assert.deepEqual(second, { skipped: true });
  release();
  await first;
  assert.equal(calls, 1);
});

test("scheduled jobs catch failures and keep callable", async () => {
  let calls = 0;
  const job = createScheduledJob("test", 1000, async () => {
    calls += 1;
    if (calls === 1) throw new Error("boom");
    return { status: "success" };
  }, { runImmediately: false });

  const first = await job.runOnce();
  const second = await job.runOnce();
  assert.equal(first.status, "failed");
  assert.equal(first.error, "boom");
  assert.deepEqual(second, { status: "success" });
});
