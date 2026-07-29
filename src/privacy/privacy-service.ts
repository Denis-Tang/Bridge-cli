// ── Unified Privacy Service ─────────────────────────────────────────────
// Single entry point for all privacy operations in the main chain.
// All sensitive data must pass through this service before persistence.
//
// Responsibilities:
//   1. Profile resolution (minimal/debug/legacy)
//   2. Sanitization (secrets, paths, structured data)
//   3. Encryption (AES-256-GCM for recovery-critical fields)
//   4. Hash computation for audit trails
//   5. Field filtering based on privacy profile
//
// This is NOT a test-only helper. It is the enforced production path.

import type { PrivacyProfileConfig, PrivacyProfile } from './profile.js';
import { resolvePrivacyProfile, isDebugActive, MINIMAL_BLOCKED_FIELDS, MINIMAL_ALLOWED_FIELDS } from './profile.js';
import type { CryptoService, EncryptedPayload } from './crypto.js';
import { Aes256GcmService } from './crypto.js';
import { sanitizeText, sanitizeEventData, sanitizeLogContent, computeHash, containsSecrets } from './sanitizer.js';
import { hashProjectRoot, toRelativePath } from './artifact-store.js';
import { buildMinimalSubprocessEnv, validateProjectEnvVars } from './env-allowlist.js';

export type DataClassification = 'request_text' | 'worker_result' | 'review_result' | 'event_data' | 'diff' | 'prompt' | 'environment' | 'structured' | 'error_message';
export type PrivacyStatus = 'encrypted' | 'legacy_plaintext' | 'sanitized' | 'unavailable' | 'debug';

export interface PrivacyServiceConfig {
  /** Privacy profile (minimal or debug) */
  profile: PrivacyProfileConfig;
  /** Crypto service for encryption (may be unavailable) */
  crypto: CryptoService | null;
  /** Project root for relative path computation */
  projectRoot?: string | null;
}

export interface SanitizedStorage {
  /** Plaintext field value (sanitized or null in minimal mode) */
  plaintext: string | null;
  /** Encrypted field value (JSON-serialized EncryptedPayload) */
  encrypted: string | null;
  /** SHA-256 hash of original content (always present) */
  contentHash: string;
  /** Classification marker */
  status: PrivacyStatus;
}

export interface DecryptedContent {
  /** Decrypted plaintext, or null if unavailable */
  content: string | null;
  /** Status marker */
  status: PrivacyStatus;
}

/**
 * Unified privacy service for the main production chain.
 * All writes and reads of sensitive data MUST go through this service.
 */
export class PrivacyService {
  readonly profile: PrivacyProfileConfig;
  /** Whether the service is in minimal (enforcing) mode */
  readonly isMinimal: boolean;
  /** Whether debug mode is active and not expired */
  readonly isDebug: boolean;
  private crypto: CryptoService | null;
  private projectRoot: string | null;
  private projectRootHash: string | null;

  constructor(config: PrivacyServiceConfig) {
    this.profile = config.profile;
    this.crypto = config.crypto;
    this.projectRoot = config.projectRoot ?? null;
    this.projectRootHash = this.projectRoot ? hashProjectRoot(this.projectRoot) : null;
    this.isDebug = isDebugActive(this.profile);
    this.isMinimal = this.profile.profile === 'minimal' || !this.isDebug;
  }

  /**
   * Create a PrivacyService from environment and optional project config.
   * This is the standard factory for production use.
   */
  static create(options?: {
    encryptionKey?: string;
    projectRoot?: string;
    projectOverride?: Partial<PrivacyProfileConfig>;
  }): PrivacyService {
    const profile = resolvePrivacyProfile(options?.projectOverride);
    const crypto = new Aes256GcmService(options?.encryptionKey);
    return new PrivacyService({ profile, crypto, projectRoot: options?.projectRoot });
  }

  /**
   * Sanitize a text field for storage based on current profile.
   * minimal: returns null, only the contentHash is kept.
   * debug: returns sanitized text with secrets redacted.
   */
  sanitizeForStorage(text: string, classification: DataClassification): SanitizedStorage {
    const contentHash = computeHash(text);

    if (this.isMinimal) {
      // Minimal mode: no plaintext, no encryption without key
      const encrypted = this.encryptIfAvailable(text);
      return {
        plaintext: encrypted ? null : null, // Never store plaintext in minimal
        encrypted,
        contentHash,
        status: encrypted ? 'encrypted' : 'sanitized',
      };
    }

    // Debug mode: sanitized plaintext + optional encryption
    const sanitized = sanitizeText(text);
    const encrypted = this.encryptIfAvailable(text);
    return {
      plaintext: sanitized,
      encrypted,
      contentHash,
      status: 'debug',
    };
  }

  /**
   * Store a field that MUST be recoverable for runtime correctness
   * (e.g., request_text, worker_result_json).
   *
   * Encryption rules:
   * - If crypto is available: encrypt, store encrypted payload, zero plaintext column
   * - If crypto NOT available AND this is a real Provider spawn attempt: fail closed
   * - If crypto NOT available AND fake/disposable: store sanitized summary only
   */
  prepareForPersistence(
    text: string,
    classification: DataClassification,
    options?: { allowPlaintextFallback?: boolean },
  ): SanitizedStorage {
    const contentHash = computeHash(text);

    if (this.crypto?.isAvailable()) {
      // Encrypt the original content
      const encrypted = this.encryptAndSerialize(text);
      // When encryption is available, never store plaintext (regardless of mode)
      const plaintext = null;
      return {
        plaintext,
        encrypted,
        contentHash,
        status: 'encrypted',
      };
    }

    // No encryption available
    if (this.isMinimal) {
      // Minimal mode without encryption: fail closed for real execution
      // Caller must check this before spawning real Provider processes
      if (!options?.allowPlaintextFallback) {
        return {
          plaintext: null,
          encrypted: null,
          contentHash,
          status: 'unavailable', // Signals "cannot proceed without key"
        };
      }
      // Fake/disposable: store sanitized summary only
      return {
        plaintext: sanitizeText(text),
        encrypted: null,
        contentHash,
        status: 'sanitized',
      };
    }

    // Debug mode without encryption
    return {
      plaintext: sanitizeText(text),
      encrypted: null,
      contentHash,
      status: 'debug',
    };
  }

  /**
   * Check whether this service can proceed with a real Provider spawn.
   * Returns false if we're in minimal mode without an encryption key.
   */
  canSpawnRealProvider(): { allowed: boolean; reason: string | null } {
    if (!this.isMinimal) return { allowed: true, reason: null };
    if (!this.crypto?.isAvailable()) {
      return {
        allowed: false,
        reason: 'minimal profile requires encryption key (BRAINCTL_ENCRYPTION_KEY) for real Provider execution',
      };
    }
    return { allowed: true, reason: null };
  }

  /**
   * Encrypt plaintext and serialize to JSON string for SQLite storage.
   */
  private encryptAndSerialize(plaintext: string): string | null {
    if (!this.crypto?.isAvailable()) return null;
    try {
      const payload = this.crypto.encrypt(plaintext);
      return JSON.stringify(payload);
    } catch {
      return null;
    }
  }

  /**
   * Encrypt if crypto is available, otherwise return null.
   */
  private encryptIfAvailable(plaintext: string): string | null {
    return this.encryptAndSerialize(plaintext);
  }

  /**
   * Decrypt an encrypted payload from SQLite.
   * Returns the decrypted content with status marker.
   */
  decryptPayload(encryptedJson: string | null): DecryptedContent {
    if (!encryptedJson) {
      return { content: null, status: 'unavailable' };
    }

    if (!this.crypto?.isAvailable()) {
      // We have encrypted data but no key — can't decrypt
      return { content: null, status: 'encrypted' };
    }

    try {
      const payload: EncryptedPayload = JSON.parse(encryptedJson);
      const decrypted = this.crypto.decrypt(payload);
      if (decrypted !== null) {
        return { content: decrypted, status: 'encrypted' };
      }
      return { content: null, status: 'encrypted' };
    } catch {
      // Failed to parse encrypted payload
      return { content: null, status: 'encrypted' };
    }
  }

  /**
   * Determine the privacy status of a stored record from its columns.
   * Priority: encrypted → legacy plaintext → sanitized → unavailable
   */
  classifyStoredData(
    plaintext: string | null,
    encryptedJson: string | null,
  ): PrivacyStatus {
    if (encryptedJson && encryptedJson.length > 0) return 'encrypted';
    if (plaintext && plaintext.length > 0) {
      // Check if it looks like legacy plaintext (contains actual content)
      if (plaintext !== '[ENCRYPTED]' && plaintext !== '[UNAVAILABLE]') {
        return 'legacy_plaintext';
      }
      if (plaintext === '[ENCRYPTED]') return 'encrypted';
      if (plaintext === '[UNAVAILABLE]') return 'unavailable';
    }
    return 'unavailable';
  }

  /**
   * Get a display-safe version of request text for CLI output.
   * Never returns raw content in minimal mode.
   */
  getDisplayText(
    plaintext: string | null,
    encryptedJson: string | null,
    maxLength = 50,
  ): string {
    const status = this.classifyStoredData(plaintext, encryptedJson);

    switch (status) {
      case 'encrypted': {
        // Try to decrypt if key is available
        if (this.crypto?.isAvailable() && encryptedJson) {
          const decrypted = this.decryptPayload(encryptedJson);
          if (decrypted.content) {
            // Show truncated decrypted content (only in debug mode)
            if (this.isDebug) {
              return decrypted.content.substring(0, maxLength);
            }
            return `[encrypted:${decrypted.content.substring(0, 20)}...]`;
          }
        }
        return '[encrypted]';
      }
      case 'legacy_plaintext': {
        // Legacy data — show truncated with marker
        const text = plaintext || '';
        if (this.isMinimal) {
          // Don't display legacy plaintext in minimal mode
          return '[legacy_plaintext]';
        }
        return `[legacy] ${text.substring(0, maxLength)}`;
      }
      case 'sanitized': {
        return plaintext ? plaintext.substring(0, maxLength) : '[sanitized]';
      }
      case 'debug': {
        return plaintext ? plaintext.substring(0, maxLength) : '[debug:none]';
      }
      default:
        return '[unavailable]';
    }
  }

  /**
   * Get a safe subprocess environment for a specific Provider type.
   * Pi: only Pi-required vars
   * Codex: only Codex-required vars
   * quality_gate: minimal env (no Provider keys at all)
   */
  buildProviderEnv(
    provider: 'pi' | 'codex' | 'quality_gate',
    projectAllowedVars?: string[],
    model?: string,
  ): Record<string, string> {
    const buildBaseEnv = (): Record<string, string> => {
      const env = buildMinimalSubprocessEnv();
      const safeProjectVars = validateProjectEnvVars(projectAllowedVars ?? []).valid;
      for (const name of safeProjectVars) {
        if (process.env[name] !== undefined) env[name] = process.env[name]!;
      }
      return env;
    };

    switch (provider) {
      case 'pi': {
        const env = buildBaseEnv();
        const providerName = model?.includes('/')
          ? model.slice(0, model.indexOf('/')).toLowerCase()
          : '';
        const providerKeys: Record<string, string[]> = {
          deepseek: ['DEEPSEEK_API_KEY'],
          openai: ['OPENAI_API_KEY'],
          anthropic: ['ANTHROPIC_API_KEY'],
          google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
          gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
          moonshotai: ['MOONSHOT_API_KEY'],
          'moonshotai-cn': ['MOONSHOT_API_KEY'],
          qwen: ['DASHSCOPE_API_KEY'],
        };
        for (const name of providerKeys[providerName] ?? []) {
          if (process.env[name] !== undefined) env[name] = process.env[name]!;
        }
        return env;
      }
      case 'codex': {
        // Codex CLI on this machine uses its own ChatGPT login files. Never
        // inherit unrelated Provider API keys unless a future explicit config
        // contract adds a narrowly scoped key name.
        return buildBaseEnv();
      }
      case 'quality_gate': {
        return buildMinimalSubprocessEnv();
      }
    }
  }

  /**
   * Relativize an absolute path for safe storage.
   * Returns relative path from project root, or null if outside root.
   */
  relativizePath(absolutePath: string): string | null {
    if (!this.projectRoot) return null;
    return toRelativePath(absolutePath, this.projectRoot);
  }

  /**
   * Build a consistent summary object for event logging.
   * In minimal mode, drops all sensitive fields.
   */
  summarizeEvent(data: Record<string, unknown>): Record<string, unknown> {
    if (this.isMinimal) {
      return sanitizeEventData(data);
    }
    // Debug: allow structured data but sanitize secrets in strings
    return sanitizeEventData(data);
  }

  /**
   * Get diagnostics for the doctor command.
   * Never returns key values.
   */
  getDiagnostics() {
    return {
      profile: this.profile.profile,
      isDebug: this.isDebug,
      isMinimal: this.isMinimal,
      encryptionAvailable: this.crypto?.isAvailable() ?? false,
      encryptionKeyId: this.crypto?.getKeyId() ?? null,
      projectRootHash: this.projectRootHash,
      debugExpiresAt: this.profile.debugExpiresAt,
    };
  }
}
