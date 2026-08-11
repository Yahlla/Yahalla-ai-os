import { EventEmitter } from 'node:events'
import type { PerceptionEvent } from './types.js'

const DEFAULT_MAX_HISTORY = 200
const DEFAULT_TTL_MS = 5 * 60_000

// In-memory only, bounded, and time-limited by default -- this is the
// privacy-first default the perception layer is built around: no event
// bus history is written to disk unless something downstream (currently
// nothing) explicitly opts in. clear() gives an explicit, immediate way to
// wipe it (the "delete perception history" requirement), and history
// entries older than ttlMs are dropped automatically even if never
// cleared by hand.
export class PerceptionEventBus {
  private emitter = new EventEmitter()
  private history: PerceptionEvent[] = []
  private maxHistory: number
  private ttlMs: number

  constructor(opts: { maxHistory?: number; ttlMs?: number } = {}) {
    this.maxHistory = opts.maxHistory ?? DEFAULT_MAX_HISTORY
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.emitter.setMaxListeners(50)
  }

  publish(event: PerceptionEvent): void {
    this.pruneExpired()
    this.history.push(event)
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory)
    }
    this.emitter.emit('event', event)
    this.emitter.emit(event.type, event)
  }

  onEvent(listener: (event: PerceptionEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }

  onType(type: PerceptionEvent['type'], listener: (event: PerceptionEvent) => void): () => void {
    this.emitter.on(type, listener)
    return () => this.emitter.off(type, listener)
  }

  private pruneExpired(): void {
    const cutoff = Date.now() - this.ttlMs
    this.history = this.history.filter((e) => new Date(e.timestamp).getTime() >= cutoff)
  }

  getHistory(): PerceptionEvent[] {
    this.pruneExpired()
    return [...this.history]
  }

  clear(): void {
    this.history = []
  }
}
