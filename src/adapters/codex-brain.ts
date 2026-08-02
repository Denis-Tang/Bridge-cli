/**
 * Codex Brain Adapter — an M1-era stub that never gained a real implementation.
 *
 * NOT A PRODUCTION PATH. The real brain is `CodexCliBrain`
 * (src/adapters/codex-cli-brain.ts), which is what `brainctl` actually calls.
 * This stub survives only as the base class the fakes in
 * `tests/e2e/smoke.test.ts` extend, alongside the equally non-production
 * `Orchestrator`. Do not build on it.
 */
export class CodexBrainAdapter {
  constructor() {
    // Stub
  }

  async planJob(): Promise<void> {
    console.log('[CodexBrain] Not yet connected to real Codex SDK.');
  }

  async reviewDiff(): Promise<void> {
    console.log('[CodexBrain] Review not yet implemented.');
  }
}
