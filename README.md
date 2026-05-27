# EtherFi Safe Health Monitor

Demo monitor for EtherFi Cash user-safe health.

The data-source strategy is deliberately split:

- **EtherFiSafeFactory on each configured chain** is used for canonical safe discovery.
- **Configured chain RPCs** are used for current health reads from protocol contracts.
- **A local JSON store** is the working source for the UI and API.

This avoids dashboard/API query bottlenecks entirely. Safe discovery and health reads both come from protocol contracts, while the local store feeds the dashboard.

## Quick Start

```powershell
npm.cmd install
Copy-Item .env.example .env
npm.cmd run init-db
npm.cmd run import-factory -- 100
npm.cmd run start
```

Open `http://127.0.0.1:4173`.

For live chain polling, run:

```powershell
npm.cmd run poll-health
```

For continuous alert evaluation and hourly collateral refresh, run the worker in a separate process:

```powershell
npm.cmd run worker
```

To import the latest safes from the canonical on-chain factory events on every configured chain:

```powershell
npm.cmd run import-factory -- 100
```

## Completeness Controls

The app records:

- every safe candidate from the on-chain factory or CSV seed data
- safe creation timestamps from factory logs when available
- chain-aware safe identity using `chain_id + safe_address`
- every RPC health snapshot
- local aggregate snapshots
- data-quality states: `fresh`, `stale`, `rpc_failed`, `not_polled`, `unevaluable_missing_price_or_config`

## Alerts And Worker

The monitor's job is to catch loss-of-visibility, liquidation risk, bad protocol data, and suspicious user-safe activity before they become customer or treasury incidents. Alert evaluation runs in the standalone worker and persists monitor runs plus alert event lifecycle state into the local JSON store.

The worker currently schedules:

- **Alert evaluation** every 5 minutes by default.
- **Collateral refresh for all known safes** every hour by default.

Initial alert monitors persisted by the worker:

- **Safes not updated in 24h**: fires when a safe has never been polled or the latest health snapshot is older than 24 hours.
- **Liquidation risk / state downgrade**: fires while a safe is in warning or critical health, with downgrade context when available.
- **Liquidation threshold breached**: fires when latest safe health is critical.
- **Stale or missing oracle prices**: fires when health cannot be evaluated because price or protocol configuration data is missing.
- **RPC health read failures**: fires when the latest contract reads failed for a safe.
- **Fraud watch: unusual borrow activity**: first pass tracks repeated borrow events from the same safe in a configured window.

PagerDuty dispatch is optional. When `PAGERDUTY_INTEGRATION_KEY` is unset, alerts are persisted locally only. When configured, the worker sends trigger and resolve events with stable dedupe keys.

Worker knobs:

- `ALERT_WORKER_INTERVAL_MS`
- `COLLATERAL_REFRESH_INTERVAL_MS`
- `FRAUD_WATCH_WINDOW_MINUTES`
- `PAGERDUTY_INTEGRATION_KEY`
- `PAGERDUTY_EVENTS_URL`

## Useful Commands

```powershell
npm.cmd run init-db
npm.cmd run import-csv -- .\safes.csv
npm.cmd run import-factory -- 100
npm.cmd run poll-health
npm.cmd run worker
npm.cmd test
npm.cmd run start
```
