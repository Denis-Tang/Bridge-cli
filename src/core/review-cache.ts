// ── Review Cache — Hash-keyed review result cache ───────────────────────
// In-process LRU cache to avoid repeated Codex review calls for identical
// inputs. Stores only hashes and results, never raw prompts or diffs.

import { createHash } from 'node:crypto';
import type { ReviewResult } from '../types/protocol.js';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface ReviewCacheKeyParts {
  baseCommit: string;
  diffHash: string;
  qualityGateConfigHash: string;
  reviewerModel: string;
  reviewerVersion: string;
  riskPolicyHash: string;
}

export class ReviewCacheKey {
  readonly baseCommit: string;
  readonly diffHash: string;
  readonly qualityGateConfigHash: string;
  readonly reviewerModel: string;
  readonly reviewerVersion: string;
  readonly riskPolicyHash: string;

  constructor(parts: ReviewCacheKeyParts) {
    this.baseCommit = parts.baseCommit;
    this.diffHash = parts.diffHash;
    this.qualityGateConfigHash = parts.qualityGateConfigHash;
    this.reviewerModel = parts.reviewerModel;
    this.reviewerVersion = parts.reviewerVersion;
    this.riskPolicyHash = parts.riskPolicyHash;
  }

  /** Serialize to string for map key usage. */
  toString(): string {
    return sha256([
      this.baseCommit,
      this.diffHash,
      this.qualityGateConfigHash,
      this.reviewerModel,
      this.reviewerVersion,
      this.riskPolicyHash,
    ].join('|'));
  }
}

export interface CacheEntry {
  result: ReviewResult;
  createdAt: string;
}

export interface ReviewCacheConfig {
  maxEntries: number;
  ttlMs: number;
  enabled: boolean;
}

const DEFAULT_CACHE_CONFIG: ReviewCacheConfig = {
  maxEntries: 100,
  ttlMs: 3600_000, // 1 hour
  enabled: true,
};

/**
 * In-process LRU review cache.
 * Only caches 'approved' results. Keyed by composite hash.
 * No raw prompts, diffs, or paths stored — only hashes and structured results.
 */
export class ReviewResultCache {
  private cache = new Map<string, CacheEntry>();
  private config: ReviewCacheConfig;

  constructor(config?: Partial<ReviewCacheConfig>) {
    this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
  }

  get isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Look up a cached review result by key.
   * Returns null if not found, expired, or result is not 'approved'.
   */
  get(key: ReviewCacheKey): ReviewResult | null {
    if (!this.config.enabled) return null;

    const keyStr = key.toString();
    const entry = this.cache.get(keyStr);
    if (!entry) return null;

    // Check TTL
    const age = Date.now() - new Date(entry.createdAt).getTime();
    if (age > this.config.ttlMs) {
      this.cache.delete(keyStr);
      return null;
    }

    // Only cache approved results
    if (entry.result.status !== 'approved' || !entry.result.mergeAllowed) {
      return null;
    }

    return entry.result;
  }

  /**
   * Store a review result. Only stores 'approved' results.
   */
  set(key: ReviewCacheKey, result: ReviewResult): void {
    if (!this.config.enabled) return;
    if (result.status !== 'approved' || !result.mergeAllowed) return;

    const keyStr = key.toString();

    // Evict oldest if at capacity
    if (this.cache.size >= this.config.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }

    this.cache.set(keyStr, {
      result,
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Check if a cache entry exists and is valid for the given key.
   */
  has(key: ReviewCacheKey): boolean {
    return this.get(key) !== null;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Number of cached entries.
   */
  get size(): number {
    return this.cache.size;
  }
}

/**
 * Compute a cache key from review parameters.
 * Only uses hashes — no raw file content.
 */
export function computeReviewCacheKey(params: {
  baseCommit: string;
  diff: string;
  qualityGateConfig: object;
  reviewerModel?: string;
  reviewerVersion?: string;
  riskPolicy?: object;
}): ReviewCacheKey {
  return new ReviewCacheKey({
    baseCommit: params.baseCommit,
    diffHash: sha256(params.diff || ''),
    qualityGateConfigHash: sha256(JSON.stringify(params.qualityGateConfig || {})),
    reviewerModel: params.reviewerModel || 'codex-cli',
    reviewerVersion: params.reviewerVersion || 'default',
    riskPolicyHash: sha256(JSON.stringify(params.riskPolicy || {})),
  });
}
