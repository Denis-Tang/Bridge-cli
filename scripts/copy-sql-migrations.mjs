#!/usr/bin/env node
// ── postbuild: copy SQLite migration files into dist ──────────────────────
// `tsc` does NOT copy `src/state/migrations/sqlite/*.sql` into `dist`, so a
// freshly built dist would fail at runtime with `no such table: runs`. This
// script copies them and FAILS the build when the count does not match the
// source (the migrations are a fixed, versioned set).
//
// Usage: node scripts/copy-sql-migrations.mjs [--root <repo-root>]
// Invoked automatically by `npm run build` (postbuild). Read-only except for
// creating dist/state/migrations/sqlite and copying the .sql files.

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');

const srcDir = resolve(root, 'src', 'state', 'migrations', 'sqlite');
const distDir = resolve(root, 'dist', 'state', 'migrations', 'sqlite');

const EXPECTED_COUNT = 15;

function sqlFiles(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
  } catch {
    return [];
  }
}

const srcFiles = sqlFiles(srcDir);
if (srcFiles.length === 0) {
  console.error(`[postbuild] ✗ source migrations dir not found: ${srcDir}`);
  process.exit(1);
}
if (srcFiles.length !== EXPECTED_COUNT) {
  console.error(`[postbuild] ✗ expected ${EXPECTED_COUNT} source migrations, found ${srcFiles.length} in ${srcDir}`);
  process.exit(1);
}

mkdirSync(distDir, { recursive: true });
const distFiles = sqlFiles(distDir);
let copied = 0;
for (const name of srcFiles) {
  const target = resolve(distDir, name);
  copyFileSync(resolve(srcDir, name), target);
  copied += 1;
}

const finalDistFiles = sqlFiles(distDir);
if (finalDistFiles.length !== srcFiles.length) {
  console.error(`[postbuild] ✗ dist migrations incomplete: expected ${srcFiles.length}, found ${finalDistFiles.length} after copy`);
  process.exit(1);
}

console.log(`[postbuild] ✓ copied ${copied}/${EXPECTED_COUNT} .sql migrations → ${distDir}`);
