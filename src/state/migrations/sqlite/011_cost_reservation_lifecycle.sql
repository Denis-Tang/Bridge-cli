-- 011_cost_reservation_lifecycle.sql
-- Conservative Provider cost reservation lease and spawn evidence.

ALTER TABLE cost_reservations ADD COLUMN phase TEXT NOT NULL DEFAULT 'reserved';
ALTER TABLE cost_reservations ADD COLUMN spawned_at TEXT;
ALTER TABLE cost_reservations ADD COLUMN owner_id TEXT;
ALTER TABLE cost_reservations ADD COLUMN lease_expires_at TEXT;
ALTER TABLE cost_reservations ADD COLUMN heartbeat_at TEXT;
ALTER TABLE cost_reservations ADD COLUMN termination_evidence TEXT;
ALTER TABLE cost_reservations ADD COLUMN settled_at TEXT;

CREATE INDEX IF NOT EXISTS idx_cost_reservations_lifecycle
  ON cost_reservations(status, phase, lease_expires_at);
