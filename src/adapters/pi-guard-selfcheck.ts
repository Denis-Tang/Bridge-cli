// ── R3: Pi guard runtime self-check (zero-inference probe) ───────────────
// Verifies that the clarification guard extension is ACTUALLY loaded and its
// `tool_call` handler ACTUALLY registered before a real Pi clarification
// session starts. Pi's extension mechanism fails SILENTLY (logs, keeps going)
// when an extension cannot load — this probe turns that assumption into a
// verified fact.
//
// Zero-cost contract:
// - the probe spawns Pi with `--mode rpc --offline --no-session` and an
//   immediately-EOF stdin; no prompt is ever sent, so NO model inference
//   happens and NO Provider money is spent (hard boundary of round 3).
// - the probe extension writes markers at module load (extension really
//   loaded), after `pi.on('tool_call')` registration (API surface intact),
//   and on `session_start` (event system alive).
// - ANY missing/abnormal signal → fail closed (refuse to start the real Pi
//   clarification session).
//
// Honest boundary (documented in R4): this verifies LOADING + REGISTRATION,
// NOT that a real tool_call is actually blocked end-to-end (that requires
// inference → separate proposal awaiting explicit user authorization).

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ProcessRunner } from './pi-worker-types.js';
import { resolveWindowsCliCommand } from './windows-cli-resolver.js';

export type GuardSelfCheckFailure =
  | 'probe_timeout'
  | 'probe_spawn_failed'
  | 'extension_not_loaded'
  | 'handler_registration_failed'
  | 'session_event_missing'
  | 'probe_failed';

export interface GuardSelfCheckResult {
  ok: boolean;
  piVersion: string | null;
  versionMismatch: boolean;
  verifiedPiVersion: string;
  durationMs: number;
  failureCategory: GuardSelfCheckFailure | null;
  stderrHash: string | null;
  markerRoot: string;
  checkedAt: string;
}

export interface GuardSelfCheckOptions {
  /** Directory for probe markers (system temp; NEVER the task worktree). */
  markerDir: string;
  piCommand?: string;
  piArgs?: string[];
  timeoutMs?: number;
  verifiedPiVersion?: string;
  /** Injectable runner for tests; real usage spawns Pi directly. */
  runner?: ProcessRunner;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_PI_ARGS = ['--mode', 'rpc'];

/** Same-structure probe extension (module-load marker + handler registration + session event). */
export function buildGuardSelfCheckExtensionSource(markerRoot: string): string {
  const loaded = JSON.stringify(`${markerRoot}.loaded`);
  const registered = JSON.stringify(`${markerRoot}.registered`);
  const session = JSON.stringify(`${markerRoot}.session`);
  const error = JSON.stringify(`${markerRoot}.error`);
  return [
    `import { writeFileSync } from 'node:fs';`,
    `const write = (p, c) => { try { writeFileSync(p, c, { encoding: 'utf8', flag: 'wx' }); } catch (e) { /* marker exists */ } };`,
    `write(${loaded}, 'loaded');`,
    `export default function piGuardSelfCheck(pi) {`,
    `  try {`,
    `    pi.on('session_start', () => write(${session}, 'session'));`,
    `    pi.on('tool_call', () => ({ block: true, reason: 'PI_GUARD_SELFCHECK_PROBE' }));`,
    `    write(${registered}, 'registered');`,
    `  } catch (e) {`,
    `    write(${error}, String((e && (e.message || e)) || e));`,
    `  }`,
    `}`,
    '',
  ].join('\n');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function readMarker(markerPath: string): string | null {
  try { return readFileSync(markerPath, 'utf8'); } catch { return null; }
}

export function detectPiVersion(piCommand: string): string | null {
  try {
    const resolved = resolveWindowsCliCommand(piCommand, ['--version']);
    const out = execFileSync(resolved.command, [...resolved.args, '--version'], {
      stdio: 'pipe', encoding: 'utf-8', timeout: 10_000, windowsHide: true,
    });
    const m = out.trim().match(/\d+\.\d+\.\d+/);
    return m ? m[0] : out.trim().slice(0, 40);
  } catch {
    return null;
  }
}

/** Run the probe. Returns a result; NEVER throws (fail closed via result.ok=false). */
export async function runGuardSelfCheck(options: GuardSelfCheckOptions): Promise<GuardSelfCheckResult> {
  const startedAt = Date.now();
  const markerRoot = join(options.markerDir, `pi-guard-probe-${process.pid}-${randomUUID().slice(0, 8)}`);
  const probePath = `${markerRoot}.mjs`;
  const piCommand = options.piCommand ?? 'pi';
  const piArgs = options.piArgs ?? DEFAULT_PI_ARGS;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const verifiedPiVersion = options.verifiedPiVersion ?? '0.82.1';
  const piVersion = detectPiVersion(piCommand);
  const versionMismatch = piVersion !== null && piVersion !== verifiedPiVersion;
  const resolved = resolveWindowsCliCommand(piCommand, piArgs);
  const spawnCommand = resolved.command;
  const spawnArgs = [...resolved.args];

  let failureCategory: GuardSelfCheckFailure | null = null;
  let stderrText = '';
  let timedOut = false;

  try {
    mkdirSync(options.markerDir, { recursive: true });
    writeFileSync(probePath, buildGuardSelfCheckExtensionSource(markerRoot), { encoding: 'utf8', flag: 'wx' });

    const markerLoaded = `${markerRoot}.loaded`;
    const markerRegistered = `${markerRoot}.registered`;
    const markerSession = `${markerRoot}.session`;
    const markerError = `${markerRoot}.error`;

    if (options.runner) {
      // Test injection: the runner plays the role of the spawned Pi process.
      // Race against the timeout so a hung runner fails closed too.
      const result = await Promise.race([
        options.runner.run({
          command: spawnCommand,
          args: [...spawnArgs, '--offline', '--no-session', '--no-extensions', '--no-skills',
            '--no-prompt-templates', '--no-context-files', '--no-approve', '--extension', probePath],
          cwd: options.markerDir,
          env: options.env ?? process.env,
          timeoutMs,
          stdin: '',
          signal: undefined,
          onSpawn: () => { /* probe has no spawn hook */ },
        }),
        new Promise<never>((_, rejectPromise) => {
          setTimeout(() => {
            timedOut = true;
            rejectPromise(new Error('probe timeout'));
          }, timeoutMs);
        }),
      ]);
      stderrText = result.stderr ?? '';
    } else {
      // Real execution: stdin EOF immediately (rpc reads until EOF, no prompt → no inference).
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn(spawnCommand, [...spawnArgs, '--offline', '--no-session', '--no-extensions',
          '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--extension', probePath],
        {
          cwd: options.markerDir,
          env: { ...process.env, ...options.env } as NodeJS.ProcessEnv,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.stdin.end(); // EOF immediately — no prompt is ever sent
        const timer = setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          rejectPromise(new Error('probe timeout'));
        }, timeoutMs);
        child.on('error', (err) => { clearTimeout(timer); rejectPromise(err); });
        child.on('close', (code) => {
          clearTimeout(timer);
          stderrText = stderr;
          resolvePromise();
        });
      });
    }

  try {
    const loaded = readMarker(markerLoaded);
    const registered = readMarker(markerRegistered);
    const session = readMarker(markerSession);
    const error = readMarker(markerError);

    if (timedOut) {
      failureCategory = 'probe_timeout';
    } else if (loaded === null) {
      // THE silent failure mode: the extension was never loaded.
      failureCategory = 'extension_not_loaded';
    } else if (error !== null || registered === null) {
      // Extension loaded but `pi.on('tool_call')` registration failed/errored.
      failureCategory = 'handler_registration_failed';
    } else if (session === null) {
      // Extension + registration OK but the event system did not fire.
      failureCategory = 'session_event_missing';
    }
  } catch { /* marker reads are best-effort */ }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderrText = `${stderrText}\n${message}`;
    failureCategory = timedOut ? 'probe_timeout' : 'probe_spawn_failed';
  } finally {
    try {
      for (const suffix of ['', '.loaded', '.registered', '.session', '.error']) {
        rmSync(`${markerRoot}${suffix}`, { force: true });
      }
    } catch { /* best-effort cleanup */ }
  }

  return {
    ok: failureCategory === null,
    piVersion,
    versionMismatch,
    verifiedPiVersion,
    durationMs: Date.now() - startedAt,
    failureCategory,
    stderrHash: stderrText ? sha256(stderrText) : null,
    markerRoot,
    checkedAt: new Date().toISOString(),
  };
}

// ── Process-wide cache: probe once per process/version, reuse across runs ──
let cachedSelfCheck: { key: string; result: GuardSelfCheckResult } | null = null;

export function getCachedGuardSelfCheck(): GuardSelfCheckResult | null {
  return cachedSelfCheck?.result ?? null;
}

export async function runGuardSelfCheckCached(options: GuardSelfCheckOptions): Promise<GuardSelfCheckResult> {
  const piVersion = detectPiVersion(options.piCommand ?? 'pi');
  const key = `${options.piCommand ?? 'pi'}:${piVersion ?? 'unknown'}`;
  if (cachedSelfCheck && cachedSelfCheck.key === key) {
    return cachedSelfCheck.result;
  }
  const result = await runGuardSelfCheck(options);
  cachedSelfCheck = { key, result };
  return result;
}

/** Test hook: reset the process-wide cache. */
export function resetGuardSelfCheckCache(): void {
  cachedSelfCheck = null;
}
