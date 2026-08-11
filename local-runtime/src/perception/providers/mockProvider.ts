import { randomUUID } from 'node:crypto'
import type { PerceptionEventBus } from '../eventBus.js'
import type { PerceptionEvent, PerceptionEventType } from '../types.js'
import type { PerceptionProvider, ProviderCapabilities } from './types.js'

// A deterministic, camera-free stand-in for a real local vision/speech
// pipeline (e.g. a future MediaPipe or platform-native provider). It
// exists so the perception pipeline -- bus, world model, agent
// integration, live UI -- can be built and genuinely tested end to end in
// any environment, including one with no camera/microphone/GPU at all,
// without ever reaching for a cloud vision API. Swapping this for a real
// provider later requires no change anywhere else, since both implement
// the same PerceptionProvider interface.
const SCRIPT: { type: PerceptionEventType; data: Record<string, unknown>; confidence: number }[] = [
  { type: 'person.detected', data: { trackId: 'mock-1', boundingBox: [10, 10, 200, 300] }, confidence: 0.97 },
  { type: 'face.updated', data: { trackId: 'mock-1', landmarks: [[100, 120]], mouthOpenness: 0.1 }, confidence: 0.93 },
  { type: 'gaze.updated', data: { trackId: 'mock-1', target: 'screen_element', direction: [0, 0, -1] }, confidence: 0.85 },
  { type: 'head_pose.updated', data: { trackId: 'mock-1', yaw: 2, pitch: -1, roll: 0 }, confidence: 0.88 },
  { type: 'hand.updated', data: { trackId: 'mock-1', hand: 'right', landmarks: [[150, 200, 0]] }, confidence: 0.8 },
  { type: 'gesture.detected', data: { trackId: 'mock-1', gesture: 'point' }, confidence: 0.7 },
  { type: 'speech.started', data: { trackId: 'mock-1' }, confidence: 0.9 },
  { type: 'speech.partial', data: { text: 'open the' }, confidence: 0.6 },
  { type: 'speech.final', data: { text: 'open the file' }, confidence: 0.9 },
  { type: 'speech.stopped', data: { durationMs: 1200 }, confidence: 0.9 },
]

export class MockPerceptionProvider implements PerceptionProvider {
  private running = false
  private bus: PerceptionEventBus | undefined
  private sessionId = ''
  private index = 0
  private timer: NodeJS.Timeout | undefined

  capabilities(): ProviderCapabilities {
    return {
      id: 'mock',
      label: 'Mock perception provider (synthetic events, no camera/microphone used)',
      modalities: ['camera', 'microphone'],
      emits: [...new Set(SCRIPT.map((s) => s.type))],
    }
  }

  isRunning(): boolean {
    return this.running
  }

  async start(bus: PerceptionEventBus, sessionId: string): Promise<void> {
    this.bus = bus
    this.sessionId = sessionId
    this.index = 0
    this.running = true
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.bus = undefined
  }

  // Emits exactly one scripted event and advances -- called by
  // startAutoTick()'s interval in real runtime use, and called directly
  // (with real, deterministic assertions) by tests instead of waiting on
  // wall-clock timers.
  tick(): PerceptionEvent | null {
    if (!this.running || !this.bus) return null
    const step = SCRIPT[this.index % SCRIPT.length]!
    this.index += 1

    const event: PerceptionEvent = {
      type: step.type,
      timestamp: new Date().toISOString(),
      source: 'mock',
      confidence: step.confidence,
      privacyScope: 'ephemeral',
      sessionId: this.sessionId,
      data: step.data,
    }
    this.bus.publish(event)
    return event
  }

  startAutoTick(intervalMs = 1500): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), intervalMs)
    this.timer.unref?.()
  }
}

export function randomSessionId(): string {
  return randomUUID()
}
