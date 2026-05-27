function createScheduledJob(name, intervalMs, task, options = {}) {
  let timer = null;
  let running = false;
  let stopped = false;

  async function runOnce() {
    if (running) {
      console.log(`[worker] Skipping ${name}; previous run still active.`);
      return { skipped: true };
    }
    running = true;
    try {
      console.log(`[worker] Starting ${name}.`);
      const result = await task();
      console.log(`[worker] Finished ${name}.`);
      return result;
    } catch (error) {
      console.error(`[worker] ${name} failed: ${error.message}`);
      return { status: "failed", error: error.message };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    stopped = false;
    if (options.runImmediately !== false) runOnce();
    timer = setInterval(runOnce, intervalMs);
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  function isRunning() {
    return running && !stopped;
  }

  return { name, intervalMs, runOnce, start, stop, isRunning };
}

module.exports = { createScheduledJob };
