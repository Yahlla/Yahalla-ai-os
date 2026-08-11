import type { PerceptionEventBus } from '../eventBus.js'

export type PerceptionModality = 'camera' | 'microphone'

export type ProviderCapabilities = {
  id: string
  label: string
  modalities: PerceptionModality[]
  // What this provider can actually emit -- a provider that only does
  // face landmarks should not claim body pose support, so downstream
  // code (and the UI) can be honest about what's really running.
  emits: string[]
}

// Anything that can turn raw camera/microphone input into PerceptionEvents
// implements this -- a synthetic mock (this file's sibling), a future
// MediaPipe-in-renderer bridge fed through the HTTP ingestion endpoint, or
// a future native macOS/Windows/Linux/iOS/Android implementation. The
// runtime never talks to a camera/microphone directly; it only ever talks
// to this interface, so swapping the real implementation in later requires
// no change to the event bus, world model, or agent integration.
export interface PerceptionProvider {
  capabilities(): ProviderCapabilities
  start(bus: PerceptionEventBus, sessionId: string): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
}
