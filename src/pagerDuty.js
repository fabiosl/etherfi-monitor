const config = require("./config");

function createPagerDutyClient() {
  if (!config.pagerDuty.integrationKey) return null;

  async function enqueue(payload) {
    const response = await fetch(config.pagerDuty.eventsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw new Error(`PagerDuty event failed with ${response.status}`);
    }
  }

  return {
    async sendTrigger(definition, event, isNew) {
      if (!isNew) return;
      await enqueue({
        routing_key: config.pagerDuty.integrationKey,
        event_action: "trigger",
        dedup_key: event.dedupe_key,
        payload: {
          summary: `${definition.name}: ${event.safe_address || event.chain_name || "system"}`,
          severity: event.severity === "critical" ? "critical" : "warning",
          source: "etherfi-monitor",
          component: definition.monitor,
          group: event.chain_name || "protocol",
          custom_details: event.payload || {}
        }
      });
    },

    async sendResolve(definition, event) {
      await enqueue({
        routing_key: config.pagerDuty.integrationKey,
        event_action: "resolve",
        dedup_key: event.dedupe_key,
        payload: {
          summary: `${definition.name} resolved`,
          severity: event.severity === "critical" ? "critical" : "warning",
          source: "etherfi-monitor",
          component: definition.monitor,
          group: event.chain_name || "protocol",
          custom_details: event.payload || {}
        }
      });
    }
  };
}

module.exports = { createPagerDutyClient };
