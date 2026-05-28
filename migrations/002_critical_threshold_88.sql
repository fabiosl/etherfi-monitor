UPDATE safe_health_snapshots
SET health_status = 'critical'
WHERE liquidation_utilization_bps > 8800
  AND health_status = 'warning';
