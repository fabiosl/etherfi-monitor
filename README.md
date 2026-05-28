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

To run each worker job separately:

```powershell
npm.cmd run worker:discovery
npm.cmd run worker:discovery:once
npm.cmd run worker:health
npm.cmd run worker:health:reconcile
npm.cmd run worker:health:critical
npm.cmd run worker:health:critical:watch
npm.cmd run worker:health:asset -- 0xTokenAddress
npm.cmd run worker:health:asset:watch -- 0xTokenAddress
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

The worker has a simple pipeline:

1. **Discovery finds active safes** from Optimism borrow logs.
2. **Health polling refreshes those safes** from the protocol contracts.
3. **Alert evaluation checks the latest stored state** and opens or resolves durable alert events.

The worker currently schedules:

- **Optimism borrow discovery** every minute by default. Each run scans newest-to-oldest and stops once it reaches an already-monitored borrow transaction or the trailing 72-hour boundary.
- **Health polling for active Optimism safes** every 5 minutes by default.
- **Critical-safe health polling** every 30 minutes by default for safes above 85% liquidation utilization.
- **Alert evaluation** every 5 minutes by default.
- **Asset-risk health polling** only when `ASSET_RISK_TOKEN_ADDRESS` is set; this refreshes the riskiest safes holding that token.

### Worker Jobs

#### Optimism borrow discovery

Run continuously:

```powershell
npm.cmd run worker:discovery
```

Run once:

```powershell
npm.cmd run worker:discovery:once
```

Discovery reads `Borrowed(address,address,uint256)` logs from the configured Optimism DebtManager contract. It scans from newest to oldest, records unseen borrow events in `safe_activity`, and upserts the borrower safe into `safes`.

For each new borrow event, discovery updates:

- `safe_activity`: one durable event row keyed by source, tx hash, log index, and activity type.
- `safes`: safe address, chain, source, last seen block/time, `last_borrowed_at`, and `status = active`.
- `borrow_discovery_runs`: run summary, scanned block range, number of new events, and stop reason.

Discovery stops early when it reaches an already-monitored transaction. This makes normal runs incremental instead of rescanning the full 72-hour window every time. If it does not hit a known transaction first, it stops at the trailing active-safe lookback boundary.

Each cycle logs when the search starts, when it ends, why it stopped, how many new borrow events were stored, and how many unique user safes were discovered.

#### Active-safe health polling

Run once:

```powershell
npm.cmd run worker:health
```

Health polling selects Optimism safes whose `last_borrowed_at` is within `ACTIVE_SAFE_LOOKBACK_HOURS`, 72 hours by default. It claims a batch using PostgreSQL leases so multiple worker processes do not poll the same safe at the same time.

For each claimed safe, health polling reads protocol state over Optimism RPC and writes:

- `safe_health_snapshots`: collateral USD, borrow USD, max borrow values, LTV, liquidation utilization, mode, health status, data quality state, collateral tokens, and borrow tokens.
- `aggregate_snapshots`: portfolio-level totals and evaluated-safe count after the batch.
- `worker_leases`: short-lived coordination rows while a batch is in progress. Successful runs release these rows when finished.

This is the job that tracks health changes caused by additional borrowing and by USD value changes in collateral or debt.

#### Reconcile health polling

Run once:

```powershell
npm.cmd run worker:health:reconcile
```

Reconcile mode checks every Optimism safe in `safes`, not just recently active borrowers. It skips safes whose latest health snapshot was written within `HEALTH_RECONCILE_STALE_HOURS`, 24 hours by default, and only polls safes that are missing health or stale beyond that threshold.

Use this job after imports, after downtime, or whenever the database needs a broad catch-up pass.

#### Critical-safe health polling

Run once:

```powershell
npm.cmd run worker:health:critical
```

Run continuously every 30 minutes by default:

```powershell
npm.cmd run worker:health:critical:watch
```

Critical mode selects safes whose latest stored `liquidation_utilization_bps` is greater than `CRITICAL_HEALTH_THRESHOLD_BPS`, 8800 by default. It polls those safes first, sorted from riskiest to least risky, and uses the same PostgreSQL safe leases as the normal health worker.

#### Asset-risk health polling

Run once for a token:

```powershell
npm.cmd run worker:health:asset -- 0xTokenAddress
```

Run continuously for a token:

```powershell
npm.cmd run worker:health:asset:watch -- 0xTokenAddress
```

This worker is the target for a price-fluctuation trigger. When a token has a large USD move, run the worker with that token address or set `ASSET_RISK_TOKEN_ADDRESS`. Each cycle finds safes whose latest collateral snapshot contains the token, sorts them by liquidation utilization, and updates the top `ASSET_RISK_PERCENT`, 30% by default.

If no token is configured, the worker logs that it skipped the cycle instead of polling unrelated safes.

#### Alert evaluation

Run once:

```powershell
npm.cmd run worker:alerts
```

Alert evaluation does not read the chain directly. It evaluates the latest PostgreSQL state and persists monitor lifecycle records:

- `alert_definitions`: the configured alert catalog.
- `alert_runs`: one row per alert definition per evaluation cycle.
- `alert_events`: durable trigger/resolve state with stable dedupe keys.

PagerDuty dispatch is optional. Without `PAGERDUTY_INTEGRATION_KEY`, alerts are still stored locally in PostgreSQL.

### Continuous Mode

Run all worker jobs on their configured schedules:

```powershell
npm.cmd run worker
```

Continuous mode starts discovery, active-safe health, critical-safe health, and alert evaluation in one process. If `ASSET_RISK_TOKEN_ADDRESS` is set, it also starts asset-risk health polling. The scheduler prevents overlapping executions of the same job inside a process. Database leases provide cross-process coordination for health polling and borrow discovery.

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
- `HEALTH_RECONCILE_STALE_HOURS`
- `CRITICAL_HEALTH_INTERVAL_MS`
- `CRITICAL_HEALTH_THRESHOLD_BPS`
- `ASSET_RISK_HEALTH_INTERVAL_MS`
- `ASSET_RISK_TOKEN_ADDRESS`
- `ASSET_RISK_PERCENT`
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
npm.cmd run worker:discovery:once
npm.cmd run worker:health
npm.cmd run worker:health:reconcile
npm.cmd run worker:health:critical
npm.cmd run worker:health:critical:watch
npm.cmd run worker:health:asset -- 0xTokenAddress
npm.cmd run worker:health:asset:watch -- 0xTokenAddress
npm.cmd run worker:alerts
npm.cmd run worker
npm.cmd test
npm.cmd run start
```
