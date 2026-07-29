// ── Privacy Crypto: AES-256-GCM encryption for sensitive data ──────────
// Encrypts fields that must be retained for resume/reconcile but must NOT
// be stored in plaintext. The encryption key is NEVER written to SQLite,
// logs, or project files.
//
// Key source priority:
//   1. BRAINCTL_ENCRYPTION_KEY env var (hex-encoded 256-bit key)
//   2. External secret provider interface (future)
//   3. Fail-closed: no key → no encryption → minimal redacted mode only

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits
const KEY_LENGTH = 32; // 256 bits

export interface EncryptedPayload {
  /** Version of the encryption format (for future migration) */
  version: 1;
  /** Key identifier (SHA-256 of the key used, for key rotation detection) */
  keyId: string;
  /** Base64-encoded IV (nonce) */
  iv: string;
  /** Base64-encoded ciphertext */
  ciphertext: string;
  /** Base64-encoded authentication tag */
  authTag: string;
}

export interface CryptoService {
  /** Whether encryption is available (key is configured) */
  isAvailable(): boolean;
  /** Encrypt plaintext. Throws if no key available. */
  encrypt(plaintext: string): EncryptedPayload;
  /** Decrypt payload. Returns null if key mismatch or tampering detected. */
  decrypt(payload: EncryptedPayload): string | null;
  /** Get the key identifier (hash of the key, safe to expose) */
  getKeyId(): string | null;
}

/**
 * Default CryptoService implementation.
 * Reads key from BRAINCTL_ENCRYPTION_KEY environment variable.
 * 
 * The env var should be a hex-encoded 32-byte key, e.g.:
 *   openssl rand -hex 32
 * 
 * The key identifier is SHA-256 of the key bytes; it is safe to store.
 */
export class Aes256GcmService implements CryptoService {
  private key: Buffer | null;
  private keyId: string | null;

  constructor(key?: string) {
    const source = key ?? process.env.BRAINCTL_ENCRYPTION_KEY;
    if (source && /^[0-9a-fA-F]{64}$/.test(source)) {
      this.key = Buffer.from(source, 'hex');
      this.keyId = createHash('sha256').update(this.key).digest('hex');
    } else {
      this.key = null;
      this.keyId = null;
    }
  }

  isAvailable(): boolean {
    return this.key !== null;
  }

  getKeyId(): string | null {
    return this.keyId;
  }

  encrypt(plaintext: string): EncryptedPayload {
    if (!this.key) {
      throw new Error('Encryption not available: BRAINCTL_ENCRYPTION_KEY not set');
    }

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    
    let ciphertext: Buffer;
    let authTag: Buffer;
    
    try {
      ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf-8'),
        cipher.final(),
      ]);
      authTag = cipher.getAuthTag();
    } catch (err) {
      throw new Error(`Encryption failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      version: 1,
      keyId: this.keyId!,
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: authTag.toString('base64'),
    };
  }

  decrypt(payload: EncryptedPayload): string | null {
    if (!this.key) return null;

    // Version check
    if (payload.version !== 1) return null;

    // Key rotation check
    if (payload.keyId !== this.keyId) return null;

    try {
      const iv = Buffer.from(payload.iv, 'base64');
      const ciphertext = Buffer.from(payload.ciphertext, 'base64');
      const authTag = Buffer.from(payload.authTag, 'base64');

      if (iv.length !== IV_LENGTH) return null;
      if (authTag.length !== AUTH_TAG_LENGTH) return null;

      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);

      return decrypted.toString('utf-8');
    } catch {
      // Tampering or wrong key detected
      return null;
    }
  }

  /**
   * Test that encryption ↔ decryption round-trip works.
   */
  static testRoundTrip(): boolean {
    const testKey = randomBytes(KEY_LENGTH).toString('hex');
    const svc = new Aes256GcmService(testKey);
    const plaintext = 'test-message-' + Date.now();
    const encrypted = svc.encrypt(plaintext);
    const decrypted = svc.decrypt(encrypted);
    return decrypted === plaintext;
  }

  /**
   * Test that decryption fails with wrong key.
   */
  static testWrongKeyFails(): boolean {
    const key1 = randomBytes(KEY_LENGTH).toString('hex');
    const key2 = randomBytes(KEY_LENGTH).toString('hex');
    const svc1 = new Aes256GcmService(key1);
    const svc2 = new Aes256GcmService(key2);
    const plaintext = 'test-message-' + Date.now();
    const encrypted = svc1.encrypt(plaintext);
    return svc2.decrypt(encrypted) === null;
  }

  /**
   * Test that tampered ciphertext fails.
   */
  static testTamperingFails(): boolean {
    const key = randomBytes(KEY_LENGTH).toString('hex');
    const svc = new Aes256GcmService(key);
    const plaintext = 'test-message-' + Date.now();
    const encrypted = svc.encrypt(plaintext);
    // Tamper with ciphertext
    const tampered = {
      ...encrypted,
      ciphertext: encrypted.ciphertext.replace(/./, (c) => c === 'A' ? 'B' : 'A'),
    };
    return svc.decrypt(tampered) === null;
  }
}
