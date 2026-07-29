import { describe, it, expect } from 'vitest';
import {
  FakeResourceSampler,
  NoopResourceSampler,
} from '../../src/core/resource-sampler.js';
import { computeBudget, deriveHardCap } from '../../src/types/m3-types.js';

describe('M3 Resource Sampler', () => {
  describe('FakeResourceSampler', () => {
    it('returns configured values', async () => {
      const sampler = new FakeResourceSampler({
        cpuUsagePercent: 45,
        cpuCores: 8,
        memTotalMb: 16384,
        memUsedMb: 8192,
        piCount: 3,
      });
      const sample = await sampler.sample();
      expect(sample.cpu.usagePercent).toBe(45);
      expect(sample.cpu.cores).toBe(8);
      expect(sample.memory.totalMb).toBe(16384);
      expect(sample.memory.usedMb).toBe(8192);
      expect(sample.memory.usagePercent).toBe(50);
      expect(sample.piCount).toBe(3);
      expect(sample.degraded).toBe(false);
      expect(sample.source).toBe('os');
    });

    it('defaults to low resource usage', async () => {
      const sampler = new FakeResourceSampler();
      const sample = await sampler.sample();
      expect(sample.cpu.usagePercent).toBe(10);
      expect(sample.cpu.cores).toBe(8);
      expect(sample.memory.usagePercent).toBe(10);
      expect(sample.piCount).toBe(0);
      expect(sample.degraded).toBe(false);
    });

    it('supports degraded mode', async () => {
      const sampler = new FakeResourceSampler({
        degraded: true,
        degradeReason: 'test_degraded',
      });
      const sample = await sampler.sample();
      expect(sample.degraded).toBe(true);
      expect(sample.degradeReason).toBe('test_degraded');
    });

    it('supports update() to change config', async () => {
      const sampler = new FakeResourceSampler({ cpuUsagePercent: 10 });
      expect((await sampler.sample()).cpu.usagePercent).toBe(10);
      sampler.update({ cpuUsagePercent: 95 });
      expect((await sampler.sample()).cpu.usagePercent).toBe(95);
    });
  });

  describe('NoopResourceSampler', () => {
    it('returns degraded sample', async () => {
      const sampler = new NoopResourceSampler();
      const sample = await sampler.sample();
      expect(sample.degraded).toBe(true);
      expect(sample.degradeReason).toBe('resource_sampling_disabled');
      expect(sample.source).toBe('fallback');
    });
  });
});

describe('computeBudget', () => {
  const userMax = 4;
  const hardCap = 4;

  function makeSample(overrides: Partial<{
    cpuPct: number; cores: number;
    memTotal: number; memUsed: number;
    piCount: number; degraded: boolean; degradeReason: string;
  }> = {}): Parameters<typeof computeBudget>[0] {
    const total = overrides.memTotal ?? 16384;
    const used = overrides.memUsed ?? Math.round(total * 0.3);
    return {
      cpu: { usagePercent: overrides.cpuPct ?? 10, cores: overrides.cores ?? 8 },
      memory: { totalMb: total, usedMb: used, freeMb: total - used, usagePercent: Math.round((used / total) * 100) },
      piCount: overrides.piCount ?? 0,
      source: 'os',
      degraded: overrides.degraded ?? false,
      degradeReason: overrides.degradeReason,
    };
  }

  it('returns full budget when resources are low', () => {
    const b = computeBudget(makeSample({ cpuPct: 10 }), userMax, hardCap);
    expect(b.current).toBe(userMax);
    expect(b.dispatchPaused).toBe(false);
  });

  it('scales down on elevated CPU', () => {
    const b = computeBudget(makeSample({ cpuPct: 85 }), userMax, hardCap);
    expect(b.current).toBeLessThan(userMax);
    expect(b.dispatchPaused).toBe(false);
    expect(b.pauseReason).toContain('cpu_elevated');
  });

  it('scales further down on high CPU', () => {
    const b = computeBudget(makeSample({ cpuPct: 93 }), userMax, hardCap);
    expect(b.current).toBeLessThanOrEqual(1);
    expect(b.pauseReason).toContain('cpu_high');
  });

  it('scales down on high memory', () => {
    const b = computeBudget(makeSample({ memTotal: 16384, memUsed: 15000 }), userMax, hardCap);
    expect(b.current).toBeLessThan(userMax);
    expect(b.pauseReason).toContain('mem_high');
  });

  it('pauses dispatch on critical memory', () => {
    const b = computeBudget(makeSample({ memTotal: 16384, memUsed: 15500 }), userMax, hardCap);
    expect(b.dispatchPaused).toBe(true);
    expect(b.pauseReason).toContain('mem_critical');
  });

  it('pauses on pi count at hard cap', () => {
    const b = computeBudget(makeSample({ piCount: 4 }), 4, 4);
    expect(b.dispatchPaused).toBe(true);
    expect(b.pauseReason).toContain('pi_critical');
  });

  it('scales down on high pi count', () => {
    // 4 Pi processes with hardCap=5 → piPressure=0.8 > 0.75
    const b = computeBudget(makeSample({ piCount: 4 }), 5, 5);
    expect(b.current).toBeLessThan(5);
    expect(b.pauseReason).toContain('pi_high');
  });

  it('returns budget=1 when degraded', () => {
    const b = computeBudget(makeSample({ degraded: true, degradeReason: 'test' }), userMax, hardCap);
    expect(b.current).toBe(1);
    expect(b.dispatchPaused).toBe(false);
    expect(b.pauseReason).toContain('degraded');
  });

  it('clamps to userMax', () => {
    // CPU low, should return userMax
    const b = computeBudget(makeSample({ cpuPct: 5, piCount: 0 }), userMax, hardCap);
    expect(b.current).toBeLessThanOrEqual(userMax);
  });

  it('combines multiple pressure factors', () => {
    // Elevated CPU (85%) + high Pi count (4/5 → 0.8 > 0.75)
    const b = computeBudget(makeSample({ cpuPct: 85, piCount: 4 }), 5, 5);
    // cpu 85% > 80% → *0.5; pi 4/5=0.8 > 0.75 → *0.6
    // floor(5 * 0.5 * 0.6) = floor(1.5) = 1
    expect(b.current).toBe(1);
    expect(b.pauseReason).toBeDefined();
  });
});

describe('deriveHardCap', () => {
  it('returns at least 2', () => {
    expect(deriveHardCap(0)).toBe(2);
    expect(deriveHardCap(2)).toBe(2);
  });

  it('returns floor(cores * 0.5)', () => {
    expect(deriveHardCap(8)).toBe(4);
    expect(deriveHardCap(12)).toBe(6);
    expect(deriveHardCap(16)).toBe(8);
  });
});
