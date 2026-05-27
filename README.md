# EtherFi Safe Health Monitor

Demo monitor for EtherFi Cash user-safe health.

The data-source strategy is deliberately split:

- **Dune** is used for broad, low-frequency safe discovery, historical activity, and aggregate reconciliation.
- **Scroll RPC** is used for current health reads from protocol contracts.
- **A local JSON store** is the working source for the UI and API.

This avoids the bad pattern of running one Dune query per safe. Dune imports are batched, while current health is computed from chain in controlled RPC batches.

## Quick Start

```powershell
npm.cmd install
Copy-Item .env.example .env
npm.cmd run init-db
npm.cmd run demo-seed
npm.cmd run start
```

Open `http://127.0.0.1:4173`.

For live chain polling, set `DEBT_MANAGER_ADDRESS` and `SCROLL_RPC_URL` in `.env`, then run:

```powershell
npm.cmd run poll-health
npm.cmd run reconcile
```

For Dune imports, set the Dune query IDs in `.env`, then run:

```powershell
npm.cmd run import-dune
```

## Expected Dune Query Shapes

`DUNE_SAFE_UNIVERSE_QUERY_ID` should return one row per safe candidate:

```text
safe_address, source, first_seen_block, first_seen_at, last_seen_block, last_seen_at
```

`DUNE_RECENT_ACTIVITY_QUERY_ID` should return recent activity rows:

```text
safe_address, activity_type, token_address, amount, amount_usd, block_number, tx_hash, log_index, happened_at
```

`DUNE_AGGREGATES_QUERY_ID` should return one aggregate row:

```text
safe_count, total_borrow_usd, total_collateral_usd, latest_block, data_as_of
```

Column names are normalized case-insensitively.

## Completeness Controls

The app records:

- every safe candidate from Dune or CSV seed data
- every RPC health snapshot
- Dune aggregate snapshots
- reconciliation checks comparing Dune totals with locally computed RPC totals
- data-quality states: `fresh`, `stale`, `rpc_failed`, `dune_missing`, `dune_rpc_mismatch`, `unevaluable_missing_price_or_config`

## Useful Commands

```powershell
npm.cmd run init-db
npm.cmd run import-dune
npm.cmd run import-csv -- .\safes.csv
npm.cmd run poll-health
npm.cmd run reconcile
npm.cmd run start
```
