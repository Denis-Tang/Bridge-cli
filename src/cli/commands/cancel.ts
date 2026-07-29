import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { readSqliteConfigFromEnv } from '../../state/sqlite-config.js';
import { SqliteStateStore } from '../../state/sqlite-store.js';
import { StageScheduler } from '../../core/stage-scheduler.js';

const isWindows = process.platform === 'win32';

function killProcessTree(pid: number): boolean {
  try {
    if (isWindows) {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe' });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await checkProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !await checkProcessAlive(pid);
}

function getCommandLine(pid: number): string | null {
  if (!isWindows) return null;
  try {
    return execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 3000 }).trim();
  } catch {
    return null;
  }
}

function isControlledPiPid(pid: number): boolean {
  if (!isWindows) return true;
  const cmd = getCommandLine(pid);
  if (!cmd) return false;
  return /\bpi(\.exe)?\b/i.test(cmd) && /--mode\s+rpc/i.test(cmd);
}

function forceKillProcessTree(pid: number): boolean {
  try {
    if (isWindows) {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
    return true;
  } catch {
    return false;
  }
}

async function checkProcessAlive(pid: number): Promise<boolean> {
  try {
    if (isWindows) {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { stdio: 'pipe', encoding: 'utf-8' });
      return out.includes('\"' + pid + '\"');
    } else {
      process.kill(pid, 0);
      return true;
    }
  } catch {
    return false;
  }
}

async function reconcileRunningAttempts(store: SqliteStateStore, runId: string): Promise<void> {
  const stages = await store.listStages(runId);
  const now = new Date().toISOString();

  for (const stage of stages) {
    if (stage.status === 'completed' || stage.status === 'canceled') continue;
    const attempts = await store.listAttemptsByStage(stage.id);
    for (const attempt of attempts) {
      if (attempt.status !== 'running') continue;
      if (attempt.piPid == null) {
        await store.updateAttemptStatus(attempt.id, 'interrupted', now);
        await store.updateAttemptResult(attempt.id, { exitReason: 'reconciled: no PID recorded', stoppedAt: now });
        await store.createEvent({ id: runId + '-ev-rec-' + Date.now(), runId, stageId: stage.id, taskId: attempt.taskId, attemptId: attempt.id, eventType: 'attempt_interrupted', eventData: { reason: 'reconciled_no_pid', attemptId: attempt.id } });
        continue;
      }
      const alive = await checkProcessAlive(attempt.piPid);
      if (!alive) {
        await store.updateAttemptStatus(attempt.id, 'interrupted', now);
        await store.updateAttemptResult(attempt.id, { exitReason: 'reconciled: PID ' + attempt.piPid + ' not found', stoppedAt: now });
        await store.createEvent({ id: runId + '-ev-rec-' + Date.now(), runId, stageId: stage.id, taskId: attempt.taskId, attemptId: attempt.id, eventType: 'attempt_interrupted', eventData: { reason: 'reconciled_pid_gone', pid: attempt.piPid, attemptId: attempt.id } });
      }
    }
  }
}

export const cancelCommand = new Command('cancel')
  .description('Cancel run: kill unfinished Pi processes, keep worktrees')
  .argument('<run-id>', 'run ID')
  .action(async (runId: string) => {
    console.log('='.repeat(50));
    console.log('  brainctl cancel');
    console.log('='.repeat(50));

    try {
      const config = readSqliteConfigFromEnv();
      const store = SqliteStateStore.create(config.path);

      const run = await store.getRun(runId);
      if (!run) { console.log('  x Run not found.'); await store.close(); process.exit(1); }
      if (run.status === 'completed' || run.status === 'canceled') {
        console.log('  o Run already ' + run.status); await store.close(); process.exit(0);
      }

      // Reconcile first
      console.log('  Reconcile running attempts...');
      await reconcileRunningAttempts(store, runId);

      const now = new Date().toISOString();
      const stages = await store.listStages(runId);
      let killed = 0;
      let notFound = 0;
      let blocked = 0;

      for (const stage of stages) {
        if (stage.status === 'completed' || stage.status === 'canceled') continue;
        await store.updateStageStatus(stage.id, 'canceled', now);

        const attempts = await store.listAttemptsByStage(stage.id);
        for (const attempt of attempts) {
          if (attempt.status !== 'running') {
            if (attempt.status === 'pending') { await store.updateAttemptStatus(attempt.id, 'canceled', now); }
            continue;
          }

          // Kill Pi process
          if (attempt.piPid != null) {
            const alive = await checkProcessAlive(attempt.piPid);
            if (alive) {
              if (!isControlledPiPid(attempt.piPid)) {
                blocked++;
                console.log('  BLOCKED: PID ' + attempt.piPid + ' could not be verified as this attempt controlled Pi process.');
                await store.updateAttemptResult(attempt.id, { exitReason: 'cancel_blocked_pid_not_controlled' });
                continue;
              }
              const ok = killProcessTree(attempt.piPid);
              const exited = ok && await waitForExit(attempt.piPid, 5000);
              if (!exited) {
                forceKillProcessTree(attempt.piPid);
              }
              const confirmedDead = await waitForExit(attempt.piPid, 3000);
              if (confirmedDead) { killed++; console.log('  Killed PID tree ' + attempt.piPid + ' (task ' + attempt.taskId + ')'); }
              else {
                blocked++;
                console.log('  BLOCKED: PID tree ' + attempt.piPid + ' could not be confirmed dead.');
                await store.updateAttemptResult(attempt.id, { exitReason: 'cancel_blocked_pid_still_alive' });
                continue;
              }
            } else {
              notFound++;
              console.log('  PID ' + attempt.piPid + ' already gone (task ' + attempt.taskId + ')');
            }
          }

          await store.updateAttemptStatus(attempt.id, 'canceled', now);
          await store.updateAttemptResult(attempt.id, { exitReason: 'canceled_by_user', stoppedAt: now });
        }
      }

      if (blocked > 0) {
        for (const stage of stages) {
          if (stage.status !== 'completed' && stage.status !== 'canceled') {
            await store.updateStageStatus(stage.id, 'paused', now);
          }
        }
        await store.updateRunStatus(runId, 'waiting_decision', now);
        await store.createEvent({ id: runId + '-ev-cancel-blocked-' + Date.now(), runId, eventType: 'error', eventData: { reason: 'cancel_blocked', killed, notFound, blocked } });
        console.log('  x Cancel blocked. Some process trees could not be verified stopped; run moved to waiting_decision.');
        await store.close();
        process.exit(1);
      }

      await store.updateRunStatus(runId, 'canceled', now);
      await store.updateRunFinishedAt(runId, now);
      await store.createEvent({ id: runId + '-ev-cancel-' + Date.now(), runId, eventType: 'run_canceled', eventData: { killed, notFound } });

      console.log('  o Run ' + runId + ' canceled. Killed: ' + killed + ' Pi process(es).');
      console.log('  Worktrees and logs preserved for evidence.');
      await store.close();
    } catch (err) {
      console.error('  x Error: ' + (err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    }
    console.log('='.repeat(50));
  });
