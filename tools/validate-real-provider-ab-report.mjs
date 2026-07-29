#!/usr/bin/env node
/**
 * validate-real-provider-ab-report.mjs
 *
 * Offline CLI validator for Real Provider A/B result reports.
 *
 * Usage:
 *   node tools/validate-real-provider-ab-report.mjs --report <path-to-json>
 *
 * Constraints:
 *   - No npm dependencies (Node.js built-in APIs only).
 *   - No network access.
 *   - Does not read environment variables.
 *   - Does not write project files.
 *   - Does not echo sensitive free text from the report.
 *
 * Output:
 *   - On failure: lists failures by mode/repeat + JSON field path + category.
 *   - On success: compact summary with medians/ranges and gate statuses.
 *   - Exit code 0 = PASS, 1 = FAIL, 2 = usage error.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Helpers ────────────────────────────────────────────────────────────────

const FAILURE_CATEGORIES = {
  SCHEMA: "schema_violation",
  MISSING_MODE: "missing_mode",
  INSUFFICIENT_REPEATS: "insufficient_repeats",
  FINGERPRINT_MISMATCH: "fingerprint_mismatch",
  CORRECTNESS_FAIL: "correctness_fail",
  TOKEN_CLASSIFICATION_MIXED: "token_classification_mixed",
  TOKEN_CLASSIFICATION_MISMATCH: "token_classification_mismatch",
  FIELD_INVALID: "missing_or_invalid",
  EFFICIENCY_GATE_FAIL: "efficiency_gate_fail",
  CROSS_MODE_INCONSISTENCY: "cross_mode_inconsistency",
};

const MODES = ["sequential-baseline", "default-orchestrated", "token-efficient"];

const CORRECTNESS_KEYS = [
  "runStatus",
  "stageStatus",
  "allTasksMerged",
  "targetBranchContentCorrect",
  "hasConflict",
  "hasPaused",
  "hasWaitingDecision",
  "hasMergeBlocked",
  "hasLeftoverWorktree",
];

const CORRECTNESS_PASS_MAP = {
  runStatus: "completed",
  stageStatus: "completed",
  allTasksMerged: true,
  targetBranchContentCorrect: true,
  hasConflict: false,
  hasPaused: false,
  hasWaitingDecision: false,
  hasMergeBlocked: false,
  hasLeftoverWorktree: false,
};

const TOKEN_STATUSES = ["confirmed", "estimated", "unavailable", "synthetic"];

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function range(arr) {
  return { min: Math.min(...arr), max: Math.max(...arr) };
}

function formatRatio(value) {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Collect validation failures. Each failure is { mode, repeat, path, category }.
 * mode and repeat are null when the failure is report-level.
 */
class FailureCollector {
  constructor() {
    this.failures = [];
  }

  add(mode, repeat, path, category) {
    this.failures.push({ mode, repeat, path, category });
  }

  get count() {
    return this.failures.length;
  }

  /**
   * Print failures conservatively: no free text from report.
   * Format: "{mode} repeat #{n}: {path} — {category}"
   */
  print() {
    for (const f of this.failures) {
      const modePart = f.mode ? `${f.mode}` : "report";
      const repeatPart = f.repeat !== null ? ` repeat #${f.repeat}` : "";
      console.log(`${modePart}${repeatPart}: ${f.path} — ${f.category}`);
    }
  }
}

// ─── Schema-Level Validation ─────────────────────────────────────────────────

function validateType(value, expected, path, mode, repeat, failures) {
  if (expected === "integer") {
    if (!Number.isInteger(value)) {
      failures.add(mode, repeat, path, FAILURE_CATEGORIES.FIELD_INVALID);
      return false;
    }
  } else if (expected === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) {
      failures.add(mode, repeat, path, FAILURE_CATEGORIES.FIELD_INVALID);
      return false;
    }
  } else if (expected === "boolean") {
    if (typeof value !== "boolean") {
      failures.add(mode, repeat, path, FAILURE_CATEGORIES.FIELD_INVALID);
      return false;
    }
  } else if (expected === "string") {
    if (typeof value !== "string") {
      failures.add(mode, repeat, path, FAILURE_CATEGORIES.FIELD_INVALID);
      return false;
    }
  } else if (expected === "array") {
    if (!Array.isArray(value)) {
      failures.add(mode, repeat, path, FAILURE_CATEGORIES.FIELD_INVALID);
      return false;
    }
  } else if (expected === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      failures.add(mode, repeat, path, FAILURE_CATEGORIES.FIELD_INVALID);
      return false;
    }
  }
  return true;
}

function validateRequired(obj, required, path, mode, repeat, failures) {
  let ok = true;
  for (const key of required) {
    if (!(key in obj) || obj[key] === undefined || obj[key] === null) {
      failures.add(mode, repeat, `${path}/${key}`, FAILURE_CATEGORIES.FIELD_INVALID);
      ok = false;
    }
  }
  return ok;
}

function validateEnum(value, allowed, path, mode, repeat, failures) {
  if (!allowed.includes(value)) {
    failures.add(mode, repeat, path, FAILURE_CATEGORIES.FIELD_INVALID);
    return false;
  }
  return true;
}

function validatePattern(value, pattern, path, mode, repeat, failures) {
  const re = new RegExp(pattern);
  if (!re.test(value)) {
    failures.add(mode, repeat, path, FAILURE_CATEGORIES.FIELD_INVALID);
    return false;
  }
  return true;
}

function validateMinimum(value, min, path, mode, repeat, failures) {
  if (value < min) {
    failures.add(mode, repeat, path, FAILURE_CATEGORIES.FIELD_INVALID);
    return false;
  }
  return true;
}

/**
 * Validate a single run object against the schema definition.
 * Uses the schema template's property definitions for structural checks.
 */
function validateRunSchema(run, mode, repeatNum, failures) {
  const prefix = `/runs[${repeatNum - 1}]`;
  let ok = true;

  // Required top-level fields
  const runRequired = [
    "runId", "mode", "repeatNumber", "timestamp", "modelInfo",
    "taskFingerprint", "qualityGateFingerprint", "acceptanceFingerprint",
    "correctness", "usage", "cost", "timing", "evidencePaths",
  ];
  if (!validateRequired(run, runRequired, prefix, mode, repeatNum, failures)) {
    ok = false;
  }

  // mode enum
  if (!validateEnum(run.mode, MODES, `${prefix}/mode`, mode, repeatNum, failures)) {
    ok = false;
  }

  // repeatNumber type and minimum
  if (
    !validateType(run.repeatNumber, "integer", `${prefix}/repeatNumber`, mode, repeatNum, failures) ||
    !validateMinimum(run.repeatNumber, 1, `${prefix}/repeatNumber`, mode, repeatNum, failures)
  ) {
    ok = false;
  }

  // Fingerprints (SHA-256 hex)
  for (const fp of ["taskFingerprint", "qualityGateFingerprint", "acceptanceFingerprint"]) {
    if (typeof run[fp] === "string") {
      if (!validatePattern(run[fp], "^[a-f0-9]{64}$", `${prefix}/${fp}`, mode, repeatNum, failures)) {
        ok = false;
      }
    }
  }

  // modelInfo
  if (run.modelInfo && typeof run.modelInfo === "object" && !Array.isArray(run.modelInfo)) {
    const miRequired = ["model", "providerVersion", "environmentType"];
    validateRequired(run.modelInfo, miRequired, `${prefix}/modelInfo`, mode, repeatNum, failures);
    if (run.modelInfo.environmentType !== undefined) {
      validateEnum(run.modelInfo.environmentType, ["disposable"], `${prefix}/modelInfo/environmentType`, mode, repeatNum, failures);
    }
  }

  // correctness
  if (run.correctness && typeof run.correctness === "object" && !Array.isArray(run.correctness)) {
    validateRequired(run.correctness, CORRECTNESS_KEYS, `${prefix}/correctness`, mode, repeatNum, failures);
    if (run.correctness.runStatus !== undefined) {
      validateEnum(run.correctness.runStatus, ["completed", "failed", "cancelled"], `${prefix}/correctness/runStatus`, mode, repeatNum, failures);
    }
    if (run.correctness.stageStatus !== undefined) {
      validateEnum(run.correctness.stageStatus, ["completed", "failed", "partial"], `${prefix}/correctness/stageStatus`, mode, repeatNum, failures);
    }
    for (const key of ["allTasksMerged", "targetBranchContentCorrect", "hasConflict", "hasPaused", "hasWaitingDecision", "hasMergeBlocked", "hasLeftoverWorktree"]) {
      if (run.correctness[key] !== undefined) {
        validateType(run.correctness[key], "boolean", `${prefix}/correctness/${key}`, mode, repeatNum, failures);
      }
    }
  }

  // usage
  if (run.usage && typeof run.usage === "object" && !Array.isArray(run.usage)) {
    validateRequired(run.usage, ["codex", "pi", "totalTokens", "totalTokensStatus"], `${prefix}/usage`, mode, repeatNum, failures);
    for (const provider of ["codex", "pi"]) {
      if (run.usage[provider] && typeof run.usage[provider] === "object" && !Array.isArray(run.usage[provider])) {
        const provReq = provider === "codex"
          ? ["inputTokens", "outputTokens", "cacheTokens", "callCount", "status"]
          : ["inputTokens", "outputTokens", "cacheTokens", "status"];
        validateRequired(run.usage[provider], provReq, `${prefix}/usage/${provider}`, mode, repeatNum, failures);
        for (const tk of ["inputTokens", "outputTokens", "cacheTokens"]) {
          if (run.usage[provider][tk] !== undefined) {
            validateType(run.usage[provider][tk], "integer", `${prefix}/usage/${provider}/${tk}`, mode, repeatNum, failures);
            validateMinimum(run.usage[provider][tk], 0, `${prefix}/usage/${provider}/${tk}`, mode, repeatNum, failures);
          }
        }
        if (provider === "codex" && run.usage.codex.callCount !== undefined) {
          validateType(run.usage.codex.callCount, "integer", `${prefix}/usage/codex/callCount`, mode, repeatNum, failures);
          validateMinimum(run.usage.codex.callCount, 0, `${prefix}/usage/codex/callCount`, mode, repeatNum, failures);
        }
        if (run.usage[provider].status !== undefined) {
          validateEnum(run.usage[provider].status, TOKEN_STATUSES, `${prefix}/usage/${provider}/status`, mode, repeatNum, failures);
        }
      }
    }
    if (run.usage.totalTokens !== undefined) {
      validateType(run.usage.totalTokens, "integer", `${prefix}/usage/totalTokens`, mode, repeatNum, failures);
      validateMinimum(run.usage.totalTokens, 0, `${prefix}/usage/totalTokens`, mode, repeatNum, failures);
    }
    if (run.usage.totalTokensStatus !== undefined) {
      validateEnum(run.usage.totalTokensStatus, TOKEN_STATUSES, `${prefix}/usage/totalTokensStatus`, mode, repeatNum, failures);
    }
  }

  // cost
  if (run.cost && typeof run.cost === "object" && !Array.isArray(run.cost)) {
    validateRequired(run.cost, ["weightedCost", "status"], `${prefix}/cost`, mode, repeatNum, failures);
    if (run.cost.weightedCost !== undefined) {
      validateType(run.cost.weightedCost, "number", `${prefix}/cost/weightedCost`, mode, repeatNum, failures);
      validateMinimum(run.cost.weightedCost, 0, `${prefix}/cost/weightedCost`, mode, repeatNum, failures);
    }
    if (run.cost.status !== undefined) {
      validateEnum(run.cost.status, TOKEN_STATUSES, `${prefix}/cost/status`, mode, repeatNum, failures);
    }
  }

  // timing
  if (run.timing && typeof run.timing === "object" && !Array.isArray(run.timing)) {
    validateRequired(run.timing, ["wallTimeMs", "retryCount", "failureCount", "recoveryTimeMs"], `${prefix}/timing`, mode, repeatNum, failures);
    for (const tk of ["wallTimeMs", "retryCount", "failureCount", "recoveryTimeMs"]) {
      if (run.timing[tk] !== undefined) {
        validateType(run.timing[tk], "integer", `${prefix}/timing/${tk}`, mode, repeatNum, failures);
        validateMinimum(run.timing[tk], 0, `${prefix}/timing/${tk}`, mode, repeatNum, failures);
      }
    }
  }

  // evidencePaths
  if (run.evidencePaths !== undefined) {
    if (!validateType(run.evidencePaths, "array", `${prefix}/evidencePaths`, mode, repeatNum, failures)) {
      ok = false;
    } else if (run.evidencePaths.length < 1) {
      failures.add(mode, repeatNum, `${prefix}/evidencePaths`, FAILURE_CATEGORIES.FIELD_INVALID);
      ok = false;
    } else {
      for (let i = 0; i < run.evidencePaths.length; i++) {
        const ep = run.evidencePaths[i];
        if (typeof ep !== "string") {
          failures.add(mode, repeatNum, `${prefix}/evidencePaths[${i}]`, FAILURE_CATEGORIES.FIELD_INVALID);
          ok = false;
        } else {
          // Must be relative POSIX path: no backslash, no .., no absolute, must start with evidence/
          if (
            ep.includes("\\") ||
            ep.includes("..") ||
            /^[A-Za-z]:/.test(ep) ||
            ep.startsWith("/") ||
            !ep.startsWith("evidence/")
          ) {
            failures.add(mode, repeatNum, `${prefix}/evidencePaths[${i}]`, FAILURE_CATEGORIES.FIELD_INVALID);
            ok = false;
          }
        }
      }
    }
  }

  // timestamp format check (basic)
  if (typeof run.timestamp === "string") {
    const ts = Date.parse(run.timestamp);
    if (Number.isNaN(ts)) {
      failures.add(mode, repeatNum, `${prefix}/timestamp`, FAILURE_CATEGORIES.FIELD_INVALID);
      ok = false;
    }
  }

  return ok;
}

// ─── Cross-Run Business Logic ────────────────────────────────────────────────

/**
 * Check that all runs share identical fingerprints.
 */
function validateFingerprints(runs, failures) {
  let ok = true;
  for (const fp of ["taskFingerprint", "qualityGateFingerprint", "acceptanceFingerprint"]) {
    const values = runs.map((r) => r[fp]).filter(Boolean);
    if (values.length === 0) continue;
    const first = values[0];
    for (let i = 1; i < values.length; i++) {
      if (values[i] !== first) {
        failures.add(null, null, `/runs/*/${fp}`, FAILURE_CATEGORIES.FINGERPRINT_MISMATCH);
        ok = false;
      }
    }
  }
  return ok;
}

/**
 * Check that token classification is not mixed within a run
 * and that report-level dataClassification matches every run's status.
 *
 * - dataClassification must exist and be "confirmed" or "synthetic".
 * - Within each run all usage/cost statuses must be identical.
 * - Every run status must equal the report dataClassification.
 * - estimated/unavailable must not appear in a confirmed or synthetic report.
 */
function validateTokenClassification(runs, reportMeta, failures) {
  let ok = true;

  // Report-level: dataClassification must exist and be valid
  const dc = reportMeta?.dataClassification;
  if (dc === undefined || dc === null) {
    failures.add(null, null, "/reportMeta/dataClassification", FAILURE_CATEGORIES.TOKEN_CLASSIFICATION_MISMATCH);
    ok = false;
  } else if (!["confirmed", "synthetic"].includes(dc)) {
    failures.add(null, null, "/reportMeta/dataClassification", FAILURE_CATEGORIES.TOKEN_CLASSIFICATION_MISMATCH);
    ok = false;
  }

  // If dataClassification is invalid, still check per-run mixing (below)
  // but skip the per-run matching since there's no valid target.
  const hasValidDc = dc === "confirmed" || dc === "synthetic";

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const mode = run.mode;
    const repeatNum = run.repeatNumber;
    const prefix = `/runs[${i}]`;

    // Gather all status fields for this run
    const statuses = new Set();
    if (run.usage?.codex?.status) statuses.add(run.usage.codex.status);
    if (run.usage?.pi?.status) statuses.add(run.usage.pi.status);
    if (run.usage?.totalTokensStatus) statuses.add(run.usage.totalTokensStatus);
    if (run.cost?.status) statuses.add(run.cost.status);

    // All statuses must be identical per run
    if (statuses.size > 1) {
      failures.add(mode, repeatNum, `${prefix}/usage/*/status`, FAILURE_CATEGORIES.TOKEN_CLASSIFICATION_MIXED);
      ok = false;
      continue; // Skip per-run matching — already mixed internally
    }

    // If there's a single consistent status for this run, check it against dataClassification
    if (statuses.size === 1 && hasValidDc) {
      const runStatus = [...statuses][0];
      if (runStatus !== dc) {
        failures.add(mode, repeatNum, `${prefix}/usage/*/status`, FAILURE_CATEGORIES.TOKEN_CLASSIFICATION_MISMATCH);
        ok = false;
      }
    }
  }

  return ok;
}

/**
 * Group runs by mode.
 */
function groupByMode(runs) {
  const groups = {};
  for (const mode of MODES) {
    groups[mode] = [];
  }
  for (const run of runs) {
    if (groups[run.mode]) {
      groups[run.mode].push(run);
    }
  }
  return groups;
}

/**
 * Validate mode coverage and repeat counts.
 */
function validateModeCoverage(groups, failures) {
  let ok = true;
  for (const mode of MODES) {
    if (groups[mode].length === 0) {
      failures.add(mode, null, "/runs", FAILURE_CATEGORIES.MISSING_MODE);
      ok = false;
    } else if (groups[mode].length < 3) {
      failures.add(mode, null, `/runs (${groups[mode].length} repeats)`, FAILURE_CATEGORIES.INSUFFICIENT_REPEATS);
      ok = false;
    }
  }
  return ok;
}

/**
 * Validate correctness gates for each run.
 */
function validateCorrectness(groups, failures) {
  let ok = true;
  for (const mode of MODES) {
    for (const run of groups[mode]) {
      for (const key of CORRECTNESS_KEYS) {
        const actual = run.correctness?.[key];
        const expected = CORRECTNESS_PASS_MAP[key];
        if (actual !== expected) {
          failures.add(mode, run.repeatNumber, `/correctness/${key}`, FAILURE_CATEGORIES.CORRECTNESS_FAIL);
          ok = false;
        }
      }
    }
  }
  return ok;
}

/**
 * Validate token efficiency gate:
 * token-efficient must show ≥30% reduction in Codex input tokens OR call count
 * relative to sequential baseline median.
 */
function validateEfficiencyGate(groups, failures) {
  const THRESHOLD = 0.30;

  const seqRuns = groups["sequential-baseline"];
  const teRuns = groups["token-efficient"];

  if (seqRuns.length === 0 || teRuns.length === 0) {
    // Mode coverage failures already reported
    return false;
  }

  const seqInputTokens = seqRuns.map((r) => r.usage?.codex?.inputTokens ?? 0);
  const seqCallCounts = seqRuns.map((r) => r.usage?.codex?.callCount ?? 0);
  const teInputTokens = teRuns.map((r) => r.usage?.codex?.inputTokens ?? 0);
  const teCallCounts = teRuns.map((r) => r.usage?.codex?.callCount ?? 0);

  const seqMedianTokens = median(seqInputTokens);
  const seqMedianCalls = median(seqCallCounts);
  const teMedianTokens = median(teInputTokens);
  const teMedianCalls = median(teCallCounts);

  const inputReduction = seqMedianTokens > 0
    ? 1 - teMedianTokens / seqMedianTokens
    : 0;
  const callReduction = seqMedianCalls > 0
    ? 1 - teMedianCalls / seqMedianCalls
    : 0;

  const inputPass = inputReduction >= THRESHOLD;
  const callPass = callReduction >= THRESHOLD;
  const gatePass = inputPass || callPass;

  // Always report the ratios (even on failure) — no sensitive data
  console.log(`  Codex input reduction: ${formatRatio(inputReduction)} (threshold: ${formatRatio(THRESHOLD)})${inputPass ? " ✓ met" : ""}`);
  console.log(`  Codex call reduction:   ${formatRatio(callReduction)} (threshold: ${formatRatio(THRESHOLD)})${callPass ? " ✓ met" : ""}`);

  if (!gatePass) {
    failures.add("token-efficient", null, "/efficiency-gate", FAILURE_CATEGORIES.EFFICIENCY_GATE_FAIL);
  }

  return gatePass;
}

/**
 * Compute and print per-mode summary statistics.
 */
function printSummary(groups) {
  console.log("");
  console.log("=== A/B Summary ===");
  console.log("");

  for (const mode of MODES) {
    const runs = groups[mode];
    console.log(`Mode: ${mode} (${runs.length} repeats)`);

    if (runs.length === 0) {
      console.log("  No runs.");
      console.log("");
      continue;
    }

    const wallTimes = runs.map((r) => r.timing?.wallTimeMs ?? 0);
    const retries = runs.map((r) => r.timing?.retryCount ?? 0);
    const failures = runs.map((r) => r.timing?.failureCount ?? 0);
    const codexInput = runs.map((r) => r.usage?.codex?.inputTokens ?? 0);
    const codexOutput = runs.map((r) => r.usage?.codex?.outputTokens ?? 0);
    const codexCalls = runs.map((r) => r.usage?.codex?.callCount ?? 0);
    const piInput = runs.map((r) => r.usage?.pi?.inputTokens ?? 0);
    const piOutput = runs.map((r) => r.usage?.pi?.outputTokens ?? 0);
    const totalTokens = runs.map((r) => r.usage?.totalTokens ?? 0);

    const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

    console.log(`  wallTimeMs:        median=${fmt(median(wallTimes))}  range=[${fmt(range(wallTimes).min)}, ${fmt(range(wallTimes).max)}]`);
    console.log(`  retryCount:        median=${fmt(median(retries))}  range=[${fmt(range(retries).min)}, ${fmt(range(retries).max)}]`);
    console.log(`  failureCount:      median=${fmt(median(failures))}  range=[${fmt(range(failures).min)}, ${fmt(range(failures).max)}]`);
    console.log(`  codexInputTokens:  median=${fmt(median(codexInput))}  range=[${fmt(range(codexInput).min)}, ${fmt(range(codexInput).max)}]`);
    console.log(`  codexOutputTokens: median=${fmt(median(codexOutput))}  range=[${fmt(range(codexOutput).min)}, ${fmt(range(codexOutput).max)}]`);
    console.log(`  codexCallCount:    median=${fmt(median(codexCalls))}  range=[${fmt(range(codexCalls).min)}, ${fmt(range(codexCalls).max)}]`);
    console.log(`  piInputTokens:     median=${fmt(median(piInput))}  range=[${fmt(range(piInput).min)}, ${fmt(range(piInput).max)}]`);
    console.log(`  piOutputTokens:    median=${fmt(median(piOutput))}  range=[${fmt(range(piOutput).min)}, ${fmt(range(piOutput).max)}]`);
    console.log(`  totalTokens:       median=${fmt(median(totalTokens))}  range=[${fmt(range(totalTokens).min)}, ${fmt(range(totalTokens).max)}]`);
    console.log("");
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let reportPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--report" && i + 1 < args.length) {
      reportPath = args[i + 1];
      i++;
    }
  }
  if (!reportPath) {
    console.error("Usage: node tools/validate-real-provider-ab-report.mjs --report <path-to-json>");
    process.exit(2);
  }
  return reportPath;
}

function main() {
  const reportPath = parseArgs();
  const resolvedPath = resolve(reportPath);

  // 1. Read and parse report
  let report;
  try {
    const raw = readFileSync(resolvedPath, "utf-8");
    report = JSON.parse(raw);
  } catch (err) {
    // Do not echo error message to avoid leaking path content
    console.error("report: / — schema_violation (unable to read or parse report JSON)");
    process.exit(1);
  }

  const failures = new FailureCollector();

  // 2. Validate report-level structure
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    failures.add(null, null, "/", FAILURE_CATEGORIES.SCHEMA);
    failures.print();
    console.error(`\n${failures.count} failure(s) found.`);
    process.exit(1);
  }

  if (!("reportMeta" in report)) {
    failures.add(null, null, "/reportMeta", FAILURE_CATEGORIES.FIELD_INVALID);
  }
  if (!("runs" in report) || !Array.isArray(report.runs)) {
    failures.add(null, null, "/runs", FAILURE_CATEGORIES.FIELD_INVALID);
    failures.print();
    console.error(`\n${failures.count} failure(s) found.`);
    process.exit(1);
  }

  const reportMeta = report.reportMeta || {};
  const runs = report.runs;

  if (!Array.isArray(runs) || runs.length < 9) {
    failures.add(null, null, `/runs (${Array.isArray(runs) ? runs.length : 0} total)`, FAILURE_CATEGORIES.INSUFFICIENT_REPEATS);
  }

  // Validate reportMeta
  if (reportMeta.dataClassification !== undefined) {
    if (!["confirmed", "synthetic"].includes(reportMeta.dataClassification)) {
      failures.add(null, null, "/reportMeta/dataClassification", FAILURE_CATEGORIES.FIELD_INVALID);
    }
  }
  if (reportMeta.reportId !== undefined && typeof reportMeta.reportId !== "string") {
    failures.add(null, null, "/reportMeta/reportId", FAILURE_CATEGORIES.FIELD_INVALID);
  }

  // 3. Validate each run schema
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (typeof run !== "object" || run === null || Array.isArray(run)) {
      failures.add(null, null, `/runs[${i}]`, FAILURE_CATEGORIES.SCHEMA);
      continue;
    }
    const mode = MODES.includes(run.mode) ? run.mode : null;
    const repeatNum = typeof run.repeatNumber === "number" ? run.repeatNumber : i + 1;
    validateRunSchema(run, mode, repeatNum, failures);
  }

  // 4. Group by mode
  const groups = groupByMode(runs);

  // 5. Validate mode coverage
  const coverageOk = validateModeCoverage(groups, failures);

  // Only proceed with cross-run checks if basic coverage is met
  if (coverageOk && failures.count === 0) {
    // 6. Validate fingerprints consistency
    validateFingerprints(runs, failures);

    // 7. Validate correctness gates
    validateCorrectness(groups, failures);

    // 8. Validate token classification
    validateTokenClassification(runs, reportMeta, failures);
  }

  // 9. Report results
  if (failures.count > 0) {
    failures.print();
    console.error(`\n${failures.count} failure(s) found.`);
    process.exit(1);
  }

  // If no schema failures, proceed to efficiency gate and summary
  // (Re-check coverage for efficiency gate)
  if (groups["sequential-baseline"].length >= 3 && groups["token-efficient"].length >= 3) {
    console.log("=== Correctness Gate: PASS ===");
    console.log("");
    console.log("=== Efficiency Gate ===");
    const effOk = validateEfficiencyGate(groups, failures);

    // Check if efficiency gate failures accumulated
    if (failures.count > 0) {
      failures.print();
      console.error(`\n${failures.count} failure(s) found.`);
      process.exit(1);
    }

    if (!effOk) {
      // Efficiency gate failure was already printed
      process.exit(1);
    }

    console.log("  Efficiency gate: PASS ✓");
  }

  // 10. Print summary
  printSummary(groups);

  console.log("=== Overall: PASS ===");
  console.log("  Correctness gate: ✓");
  console.log("  Efficiency gate:  ✓");
  console.log("  Schema valid:      ✓");
  process.exit(0);
}

main();
