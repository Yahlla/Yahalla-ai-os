import { randomUUID } from 'node:crypto'
import type { Db } from '../db.js'
import { checkAccess } from '../permissions.js'
import { PerceptionEventBus } from './eventBus.js'
import { MockPerceptionProvider } from './providers/mockProvider.js'
import type { PerceptionModality, PerceptionProvider } from './providers/types.js'
import type { PerceptionEvent } from './types.js'
import { WorldModel } from './worldModel.js'

export class PermissionRequiredError extends Error {
  constructor(public modality: PerceptionModality) {
    super(`"${modality}" permission has not been granted. Grant it explicitly before starting perception.`)
  }
}

// Coordinates provider lifecycle, permission checks, the event bus, and
// the world model behind one object so server.ts's routes stay thin. Only
// one provider session runs at a time by design -- starting a new one
// implicitly stops the previous one.
export class PerceptionManager {
  readonly bus = new PerceptionEventBus()
  readonly worldModel = new WorldModel()

  private providers = new Map<string, PerceptionProvider>([['mock', new MockPerceptionProvider()]])
  private activeProvider: PerceptionProvider | null = null
  private activeSessionId: string | null = null

  constructor(private db: Db) {
    this.worldModel.attachTo(this.bus)
  }

  registerProvider(provider: PerceptionProvider): void {
    this.providers.set(provider.capabilities().id, provider)
  }

  listProviders() {
    return [...this.providers.values()].map((p) => p.capabilities())
  }

  getProvider(id: string): PerceptionProvider | undefined {
    return this.providers.get(id)
  }

  async start(providerId: string): Promise<{ sessionId: string }> {
    const provider = this.providers.get(providerId)
    if (!provider) throw new Error(`Unknown perception provider "${providerId}".`)

    for (const modality of provider.capabilities().modalities) {
      if (!checkAccess(this.db, modality, '*', 'read')) {
        throw new PermissionRequiredError(modality)
      }
    }

    if (this.activeProvider) {
      await this.activeProvider.stop()
    }

    const sessionId = randomUUID()
    await provider.start(this.bus, sessionId)
    if (provider instanceof MockPerceptionProvider) {
      provider.startAutoTick()
    }
    this.activeProvider = provider
    this.activeSessionId = sessionId
    return { sessionId }
  }

  async stop(): Promise<void> {
    if (this.activeProvider) {
      await this.activeProvider.stop()
    }
    this.activeProvider = null
    this.activeSessionId = null
  }

  status() {
    return {
      active: this.activeProvider?.isRunning() ?? false,
      provider: this.activeProvider?.capabilities().id ?? null,
      sessionId: this.activeSessionId,
    }
  }

  // For an external capture source (a future browser/native provider)
  // pushing events it derived itself -- the manager still requires an
  // active, permitted session before it will accept anything, and never
  // accepts raw frames/audio through this path, only already-derived
  // PerceptionEvent objects matching the same schema every provider uses.
  ingest(event: PerceptionEvent): void {
    if (!this.activeSessionId || event.sessionId !== this.activeSessionId) {
      throw new Error('No active perception session matches this event. Call /perception/start first.')
    }
    this.bus.publish(event)
  }

  // Clears both the bounded event-history buffer and everything the World
  // Model currently believes about the environment -- "delete perception
  // history" means actually forgetting what was derived, not just the raw
  // log of how it got there.
  clearHistory(): void {
    this.bus.clear()
    this.worldModel.clear()
  }
}
