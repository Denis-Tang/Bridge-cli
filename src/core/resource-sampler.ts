// ── M3 Windows Resource Sampler ──────────────────────────────────────────
// Three-layer degradation: os → PowerShell CIM → tasklist → budget=1

import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import type { ResourceSample, ResourceSampler } from '../types/m3-types.js';

/** Default timeout per sampling layer (ms) */
const DEFAULT_LAYER_TIMEOUT_MS = 2000;

/** Sampling timeout per layer */
const L1_TIMEOUT_MS = 1500;
const L2_TIMEOUT_MS = 2000;
const L3_TIMEOUT_MS = 2000;

// ══════════════════════════════════════════════════════════════
// Layer 1: Node os module
// ══════════════════════════════════════════════════════════════

function sampleCpuOs(): { usagePercent: number; cores: number } {
  const cpus = os.cpus();
  const cores = cpus.length;

  if (cores === 0) {
    return { usagePercent: 0, cores: 0 };
  }

  // Calculate CPU usage from times
  let totalIdle = 0;
  let totalTick = 0;
  for (const cpu of cpus) {
    for (const type of Object.keys(cpu.times) as Array<keyof typeof cpu.times>) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  }

  const usagePercent = totalTick > 0
    ? Math.round(((totalTick - totalIdle) / totalTick) * 10000) / 100
    : 0;

  return { usagePercent, cores };
}

function sampleMemoryOs(): { totalMb: number; usedMb: number; freeMb: number; usagePercent: number } {
  const totalMb = Math.round(os.totalmem() / (1024 * 1024));
  const freeMb = Math.round(os.freemem() / (1024 * 1024));
  const usedMb = totalMb - freeMb;
  const usagePercent = totalMb > 0 ? Math.round((usedMb / totalMb) * 10000) / 100 : 0;
  return { totalMb, usedMb, freeMb, usagePercent };
}

// ══════════════════════════════════════════════════════════════
// Layer 2: PowerShell CIM (more precise memory)
// ══════════════════════════════════════════════════════════════

function sampleMemoryCim(): { totalMb: number; freeMb: number } | null {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', 'Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json -Compress'],
      { timeout: L2_TIMEOUT_MS, stdio: 'pipe', encoding: 'utf-8', windowsHide: true },
    );
    const parsed = JSON.parse(out.trim());
    const totalKb = Number(parsed.TotalVisibleMemorySize) || 0;
    const freeKb = Number(parsed.FreePhysicalMemory) || 0;
    if (totalKb === 0) return null;
    return { totalMb: Math.round(totalKb / 1024), freeMb: Math.round(freeKb / 1024) };
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// Layer 3: tasklist for Pi process count
// ══════════════════════════════════════════════════════════════

function samplePiCount(): number {
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
      timeout: L3_TIMEOUT_MS,
      stdio: 'pipe',
      encoding: 'utf-8',
      windowsHide: true,
    });
    let count = 0;
    const lines = out.trim().split(/\r?\n/);
    for (const line of lines) {
      // Pi processes have --mode rpc in the command line
      // tasklist CSV only has image name, not full command line.
      // We count processes named "pi.exe" or "pi" (case-insensitive)
      const parts = line.split(',');
      if (parts.length > 0) {
        const name = parts[0].replace(/"/g, '').trim().toLowerCase();
        if (name === 'pi.exe' || name === 'pi') {
          count++;
        }
      }
    }
    return count;
  } catch {
    return -1; // signal: unavailable
  }
}

// ══════════════════════════════════════════════════════════════
// WindowsResourceSampler
// ══════════════════════════════════════════════════════════════

export class WindowsResourceSampler implements ResourceSampler {
  async sample(): Promise<ResourceSample> {
    const degradeReasons: string[] = [];
    let overallDegraded = false;
    let finalSource: ResourceSample['source'] = 'os';

    // ── Layer 1: Node os (always attempt first) ──
    const cpu = sampleCpuOs();
    let mem = sampleMemoryOs();

    if (cpu.cores === 0) {
      overallDegraded = true;
      degradeReasons.push('os_cpus_empty');
      finalSource = 'fallback';
    }

    // ── Layer 2: PowerShell CIM (enhance memory precision) ──
    const cimMem = sampleMemoryCim();
    if (cimMem) {
      mem = {
        totalMb: cimMem.totalMb,
        usedMb: cimMem.totalMb - cimMem.freeMb,
        freeMb: cimMem.freeMb,
        usagePercent: cimMem.totalMb > 0
          ? Math.round(((cimMem.totalMb - cimMem.freeMb) / cimMem.totalMb) * 10000) / 100
          : 0,
      };
      finalSource = 'cim';
    }
    // CIM failure is non-fatal; we continue with os memory

    // ── Layer 3: tasklist for Pi count ──
    let piCount = samplePiCount();
    if (piCount < 0) {
      piCount = 0;
      overallDegraded = true;
      degradeReasons.push('tasklist_unavailable');
    } else {
      finalSource = 'tasklist';
    }

    if (overallDegraded && finalSource === 'os') {
      finalSource = 'fallback';
    }

    return {
      cpu: { usagePercent: cpu.usagePercent, cores: cpu.cores },
      memory: {
        totalMb: mem.totalMb || 0,
        usedMb: mem.usedMb || 0,
        freeMb: mem.freeMb || 0,
        usagePercent: mem.usagePercent || 0,
      },
      piCount: Math.max(0, piCount),
      source: finalSource,
      degraded: overallDegraded,
      degradeReason: degradeReasons.length > 0 ? degradeReasons.join(';') : undefined,
    };
  }
}

// ══════════════════════════════════════════════════════════════
// FakeResourceSampler (for testing)
// ══════════════════════════════════════════════════════════════

export interface FakeSampleConfig {
  cpuUsagePercent?: number;
  cpuCores?: number;
  memTotalMb?: number;
  memUsedMb?: number;
  piCount?: number;
  degraded?: boolean;
  degradeReason?: string;
  source?: ResourceSample['source'];
}

export class FakeResourceSampler implements ResourceSampler {
  private config: FakeSampleConfig;

  constructor(config: FakeSampleConfig = {}) {
    this.config = config;
  }

  update(config: FakeSampleConfig): void {
    this.config = { ...this.config, ...config };
  }

  async sample(): Promise<ResourceSample> {
    const cpuUsage = this.config.cpuUsagePercent ?? 10;
    const cores = this.config.cpuCores ?? 8;
    const totalMb = this.config.memTotalMb ?? 16384;
    const usedMb = this.config.memUsedMb ?? Math.round(totalMb * cpuUsage / 100);
    const freeMb = totalMb - usedMb;
    const usagePct = totalMb > 0 ? Math.round((usedMb / totalMb) * 10000) / 100 : 0;

    return {
      cpu: { usagePercent: cpuUsage, cores },
      memory: { totalMb, usedMb, freeMb, usagePercent: usagePct },
      piCount: this.config.piCount ?? 0,
      source: this.config.source ?? 'os',
      degraded: this.config.degraded ?? false,
      degradeReason: this.config.degradeReason,
    };
  }
}

// ══════════════════════════════════════════════════════════════
// Portable Noop Sampler (non-Windows / fallback)
// Does not crash, does not fake data.
// ══════════════════════════════════════════════════════════════

export class NoopResourceSampler implements ResourceSampler {
  async sample(): Promise<ResourceSample> {
    return {
      cpu: { usagePercent: 0, cores: 0 },
      memory: { totalMb: 0, usedMb: 0, freeMb: 0, usagePercent: 0 },
      piCount: 0,
      source: 'fallback',
      degraded: true,
      degradeReason: 'resource_sampling_disabled',
    };
  }
}

export class PortableNoopResourceSampler implements ResourceSampler {
  async sample(): Promise<ResourceSample> {
    return {
      cpu: { usagePercent: 0, cores: 0 },
      memory: { totalMb: 0, usedMb: 0, freeMb: 0, usagePercent: 0 },
      piCount: 0,
      source: 'portable_noop',
      degraded: true,
      degradeReason: 'portable_noop: resource sampling not available on this platform',
    };
  }
}

// ══════════════════════════════════════════════════════════════
// Platform sampler factory
// ══════════════════════════════════════════════════════════════

export function createPlatformSampler(): ResourceSampler {
  if (process.platform === 'win32') {
    return new WindowsResourceSampler();
  }
  return new PortableNoopResourceSampler();
}
