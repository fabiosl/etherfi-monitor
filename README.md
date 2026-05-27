# EtherFi Safe Health Monitor

Demo monitor for EtherFi Cash user-safe health.

The data-source strategy is deliberately split:

- **EtherFiSafeFactory on Scroll** is used for canonical safe discovery.
- **Scroll RPC** is used for current health reads from protocol contracts.
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

To import the latest safes from the canonical on-chain factory list:

```powershell
npm.cmd run import-factory -- 100
```

## Completeness Controls

The app records:

- every safe candidate from the on-chain factory or CSV seed data
- every RPC health snapshot
- local aggregate snapshots
- data-quality states: `fresh`, `stale`, `rpc_failed`, `not_polled`, `unevaluable_missing_price_or_config`

## Useful Commands

```powershell
npm.cmd run init-db
npm.cmd run import-csv -- .\safes.csv
npm.cmd run import-factory -- 100
npm.cmd run poll-health
npm.cmd run start
```
