# EtherFi Safe Health Monitor

Demo monitor for EtherFi Cash user-safe health on Optimism.

The data-source strategy is deliberately split:

- **Optimism Borrowed events** discover safes active in the trailing 72 hours.
- **Optimism RPC** reads current safe health from protocol contracts.
- **PostgreSQL** stores safes, activity, health snapshots, aggregate snapshots, alerts, and worker leases.

The schema remains chain-aware for future expansion, but the worker intentionally monitors Optimism only.

## Quick Start

```powershell
npm.cmd install
Copy-Item .env.example .env
npm.cmd run migrate
npm.cmd run start
```

Open `http://127.0.0.1:4173`.

For a one-shot health poll of active Optimism safes, run:

```powershell
npm.cmd run worker:health
```

For continuous Optimism borrow discovery, active-safe health polling, and alert evaluation, run the worker in a separate process:

```powershell
npm.cmd run worker
```

To run each worker job separately once:

```powershell
npm.cmd run worker:discovery
npm.cmd run worker:health
npm.cmd run worker:alerts
```

To import latest Optimism factory safes manually:

```powershell
npm.cmd run import-factory -- 100
```

## Completeness Controls

The app records:

- every safe candidate from Optimism borrow activity, factory import, or CSV seed data
- safe creation timestamps from factory logs when available
- chain-aware safe identity using `chain_id + safe_address`
- every RPC health snapshot
- aggregate snapshots
- data-quality states: `fresh`, `stale`, `rpc_failed`, `not_polled`, `unevaluable_missing_price_or_config`

## Worker And Alerts

The monitor catches loss of visibility, liquidation risk, bad protocol data, and suspicious user-safe activity. Alert evaluation runs in the standalone worker and persists monitor runs plus alert event lifecycle state into PostgreSQL.

The worker currently schedules:

- **Optimism borrow discovery** every 5 minutes by default. Each run scans newest-to-oldest and stops once it reaches an already-monitored borrow transaction or the trailing 72-hour boundary.
- **Health polling for active Optimism safes** every 5 minutes by default.
- **Alert evaluation** every 5 minutes by default.

Initial alert monitors persisted by the worker:

- **Safes not updated in 24h**: fires when a safe has never been polled or its latest health snapshot is older than 24 hours.
- **Liquidation risk / state downgrade**: fires while a safe is in warning or critical health, with downgrade context when available.
- **Liquidation threshold breached**: fires when latest safe health is critical.
- **Stale or missing oracle prices**: fires when health cannot be evaluated because price or protocol configuration data is missing.
- **RPC health read failures**: fires when the latest contract reads failed for a safe.
- **Fraud watch: unusual borrow activity**: tracks repeated borrow events from the same safe in a configured window.

PagerDuty dispatch is optional. When `PAGERDUTY_INTEGRATION_KEY` is unset, alerts are persisted only in PostgreSQL. When configured, the worker sends trigger and resolve events with stable dedupe keys.

Worker knobs:

- `ACTIVE_SAFE_LOOKBACK_HOURS`
- `BORROW_DISCOVERY_INTERVAL_MS`
- `HEALTH_POLL_INTERVAL_MS`
- `HEALTH_POLL_BATCH_SIZE`
- `WORKER_LEASE_TTL_MS`
- `ALERT_WORKER_INTERVAL_MS`
- `FRAUD_WATCH_WINDOW_MINUTES`
- `PAGERDUTY_INTEGRATION_KEY`
- `PAGERDUTY_EVENTS_URL`

## Useful Commands

```powershell
npm.cmd run migrate
npm.cmd run init-db
npm.cmd run import-csv -- .\safes.csv
npm.cmd run import-factory -- 100
npm.cmd run clean-import-borrows -- 100
npm.cmd run poll-health
npm.cmd run worker:discovery
npm.cmd run worker:health
npm.cmd run worker:alerts
npm.cmd run worker
npm.cmd test
npm.cmd run start
```
