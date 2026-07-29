// ── Privacy Doctor Hook ─────────────────────────────────────────────────
// Called by brainctl doctor to report privacy posture without printing
// actual key values. Only reports presence/absence.

import { getEnvDiagnostics } from './env-allowlist.js';
import type { CryptoService } from './crypto.js';

export interface PrivacyDiagnostic {
  encryptionAvailable: boolean;
  encryptionKeyId: string | null;
  providerEnvVars: Record<string, 'present' | 'not_set'>;
  profileMode: string;
}

/**
 * Run privacy diagnostics. Returns safe metadata only — NEVER values.
 */
export function logPrivacyDiagnostics(crypto?: CryptoService | null): PrivacyDiagnostic {
  const envDiags = getEnvDiagnostics();

  const diag: PrivacyDiagnostic = {
    encryptionAvailable: crypto?.isAvailable() ?? false,
    encryptionKeyId: crypto?.getKeyId() ?? null,
    providerEnvVars: envDiags,
    profileMode: process.env.BRAINCTL_PRIVACY_PROFILE || 'minimal',
  };

  return diag;
}
