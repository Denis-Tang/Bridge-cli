/**
 * Codex Brain Adapter - communicates with Codex Desktop via SDK.
 * M1: This is a minimal stub — no real Codex SDK integration.
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
