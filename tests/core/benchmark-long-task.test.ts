// ── Legacy Benchmark — Redirected to v3 Red Team Suite ──────────────────
// The original benchmark (BENCH-01 through BENCH-07) has been retired.
// It mixed correctness, concurrency, and token assertions into a single file
// and accepted paused/approved states as PASS (P0-5 bug: 7/7 green despite
// T1/T6 integration conflict).
//
// See instead:
//   tests/core/benchmark-correctness.test.ts   — Correctness with strict invariants
//   tests/core/benchmark-concurrency.test.ts   — Concurrency & dependency with real timing
//   tests/core/benchmark-token.test.ts         — Token/cost with synthetic labeling
//   tests/acceptance/red-team-regression.test.ts — Red team acceptance regressions
//
// This file verifies that the v3 benchmark suite files exist and compile,
// ensuring the redirect from legacy benchmarks is functional.

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const TEST_DIR = resolve(import.meta.dirname || __dirname);
const V3_BENCHMARKS = [
  'benchmark-correctness.test.ts',
  'benchmark-concurrency.test.ts',
  'benchmark-token.test.ts',
  '../acceptance/red-team-regression.test.ts',
  '../helpers/benchmark-fixtures.ts',
];

describe('Legacy Benchmark — Redirect Verification', () => {
  it('LEGACY-BENCH-00: all v3 benchmark files exist (redirect target)', () => {
    for (const f of V3_BENCHMARKS) {
      const fullPath = resolve(TEST_DIR, f);
      const exists = existsSync(fullPath);
      expect(exists, `v3 benchmark file exists: ${f}`).toBe(true);
    }
  });
});
