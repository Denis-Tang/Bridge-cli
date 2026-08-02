// ── R2: cost reservation heartbeat helpers ───────────────────────────────
// Shared by StageScheduler (Pi worker), PostWorkerHandler (task review) and
// StageIntegrationService (stage review). The heartbeat refreshes the one-shot
// lease while a Provider call is still running so the stale reclaimer never
// mistakes a live call for a dead one.
//
// Contract:
// - interval defaults to leaseWindow/3 or shorter; overridable for tests.
// - heartbeat DB failure is a sink failure: it must NEVER change business
//   semantics (no interrupt, no task failure). Only logged/ignored.
// - returned timer is unref'd (never keeps the process alive on its own) and
//   must be cleared via stopCostReservationHeartbeat on every exit path.

export interface HeartbeatSink {
  (id: string, ownerId: string, heartbeatAt: string, leaseExpiresAt: string): Promise<boolean>;
}

export function costLeaseWindowMs(workerTimeoutMs: number): number {
  return Math.max(workerTimeoutMs, 120_000) + 60_000;
}

export function costHeartbeatIntervalMs(workerTimeoutMs: number, overrideMs?: number): number {
  if (overrideMs && overrideMs > 0) return overrideMs;
  return Math.max(1_000, Math.floor(costLeaseWindowMs(workerTimeoutMs) / 3));
}

export function startCostReservationHeartbeat(opts: {
  reservationId: string;
  ownerId: string;
  workerTimeoutMs: number;
  overrideIntervalMs?: number;
  heartbeat: HeartbeatSink;
}): NodeJS.Timeout | null {
  const intervalMs = costHeartbeatIntervalMs(opts.workerTimeoutMs, opts.overrideIntervalMs);
  const timer = setInterval(() => {
    const now = new Date();
    opts.heartbeat(
      opts.reservationId,
      opts.ownerId,
      now.toISOString(),
      new Date(now.getTime() + costLeaseWindowMs(opts.workerTimeoutMs)).toISOString(),
    ).catch(() => {
      /* sink failure must not change business semantics */
    });
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

export function stopCostReservationHeartbeat(timer: NodeJS.Timeout | null): void {
  if (timer) clearInterval(timer);
}
