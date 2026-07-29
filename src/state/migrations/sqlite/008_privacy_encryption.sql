-- 008_privacy_encryption: encrypted sensitive field storage
-- Adds encrypted_worker_result_json column as alternative to worker_result_json.
-- Migrated data is NOT automatically encrypted; only new writes use encryption.
-- Version 1 encryption uses AES-256-GCM; keyId identifies the key used.

-- ══════════════════════════════════════════════════════════════
-- task_attempts: add encrypted blob column
-- ══════════════════════════════════════════════════════════════
ALTER TABLE task_attempts ADD COLUMN encrypted_worker_result_json TEXT;   -- JSON: { version, keyId, iv, ciphertext, authTag }

-- ══════════════════════════════════════════════════════════════
-- runs: add encrypted request_text column (optional)
-- ══════════════════════════════════════════════════════════════
ALTER TABLE runs ADD COLUMN encrypted_request_text TEXT;                  -- JSON: { version, keyId, iv, ciphertext, authTag }

-- ══════════════════════════════════════════════════════════════
-- events: mark events created under privacy profile
-- ══════════════════════════════════════════════════════════════
ALTER TABLE events ADD COLUMN privacy_profile TEXT DEFAULT 'minimal';     -- 'minimal' | 'debug'

-- ══════════════════════════════════════════════════════════════
-- Rollback (manual only, never auto-applied):
--
-- ALTER TABLE task_attempts DROP COLUMN encrypted_worker_result_json;
-- ALTER TABLE runs DROP COLUMN encrypted_request_text;
-- ALTER TABLE events DROP COLUMN privacy_profile;
