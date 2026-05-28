CREATE TABLE IF NOT EXISTS safes (
  chain_id integer NOT NULL,
  chain_name text NOT NULL,
  safe_address text NOT NULL,
  safe_created_at timestamptz,
  safe_created_block bigint,
  first_seen_block bigint,
  first_seen_at timestamptz,
  last_seen_block bigint,
  last_seen_at timestamptz,
  last_borrowed_at timestamptz,
  sources text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'discovered',
  latest_collateral_json jsonb,
  latest_collateral_usd text,
  latest_collateral_refreshed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, safe_address)
);

CREATE TABLE IF NOT EXISTS safe_activity (
  id bigserial PRIMARY KEY,
  source text NOT NULL,
  activity_type text NOT NULL,
  chain_id integer NOT NULL,
  chain_name text NOT NULL,
  safe_address text NOT NULL,
  token_address text,
  amount text,
  block_number bigint,
  block_timestamp timestamptz,
  tx_hash text,
  log_index integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, tx_hash, log_index, activity_type)
);

CREATE TABLE IF NOT EXISTS safe_health_snapshots (
  id bigserial PRIMARY KEY,
  safe_address text NOT NULL,
  chain_id integer NOT NULL,
  chain_name text NOT NULL,
  source text,
  block_number bigint,
  block_timestamp timestamptz,
  mode text,
  total_collateral_usd text,
  total_borrow_usd text,
  max_borrow_ltv_usd text,
  max_borrow_liquidation_usd text,
  ltv_bps integer,
  liquidation_utilization_bps integer,
  health_status text,
  data_quality_state text,
  collateral_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  borrows_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS aggregate_snapshots (
  id bigserial PRIMARY KEY,
  source text NOT NULL,
  safe_count integer,
  total_borrow_usd text,
  total_collateral_usd text,
  latest_block bigint,
  data_as_of timestamptz,
  raw_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_definitions (
  id text PRIMARY KEY,
  name text NOT NULL,
  severity text NOT NULL,
  cadence text,
  monitor text,
  route text,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_runs (
  id bigserial PRIMARY KEY,
  alert_id text NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  status text NOT NULL,
  evaluated_count integer,
  triggered_count integer,
  resolved_count integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_events (
  id bigserial PRIMARY KEY,
  alert_id text NOT NULL,
  alert_name text,
  severity text,
  dedupe_key text NOT NULL,
  chain_id integer,
  chain_name text,
  safe_address text,
  route text,
  status text NOT NULL,
  first_fired_at timestamptz,
  last_fired_at timestamptz,
  resolved_at timestamptz,
  fire_count integer NOT NULL DEFAULT 1,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS alert_events_open_dedupe_idx
  ON alert_events (dedupe_key)
  WHERE status = 'triggered';

CREATE TABLE IF NOT EXISTS collateral_runs (
  id bigserial PRIMARY KEY,
  started_at timestamptz,
  finished_at timestamptz,
  status text,
  evaluated_count integer,
  refreshed_count integer,
  failed_count integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collateral_snapshots (
  id bigserial PRIMARY KEY,
  safe_address text NOT NULL,
  chain_id integer NOT NULL,
  chain_name text NOT NULL,
  source text,
  block_number bigint,
  block_timestamp timestamptz,
  total_collateral_usd text,
  collateral_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  data_quality_state text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worker_leases (
  lease_key text PRIMARY KEY,
  owner text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS borrow_discovery_runs (
  id bigserial PRIMARY KEY,
  chain_id integer NOT NULL,
  chain_name text NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  latest_scanned_block bigint,
  oldest_scanned_block bigint,
  new_events integer NOT NULL DEFAULT 0,
  stop_reason text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS safes_last_borrowed_at_idx ON safes (last_borrowed_at DESC);
CREATE INDEX IF NOT EXISTS safe_activity_recent_idx ON safe_activity (chain_id, block_timestamp DESC);
CREATE INDEX IF NOT EXISTS safe_health_latest_idx ON safe_health_snapshots (chain_id, safe_address, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS alert_events_status_idx ON alert_events (alert_id, status);
CREATE INDEX IF NOT EXISTS collateral_latest_idx ON collateral_snapshots (chain_id, safe_address, created_at DESC);
