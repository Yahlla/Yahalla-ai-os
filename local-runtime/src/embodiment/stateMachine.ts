import { EventEmitter } from 'node:events'

export type AvatarState =
  | 'IDLE'
  | 'LISTENING'
  | 'THINKING'
  | 'SPEAKING'
  | 'ACTING'
  | 'WAITING'
  | 'ERROR'
  | 'SUCCESS'
  | 'NEEDS_PERMISSION'
  | 'NEEDS_CLARIFICATION'

export type StatusUpdate = {
  state: AvatarState
  summary: string | null
  timestamp: string
}

// A small, explicit state machine -- not a free-form string -- so the
// avatar/UI layer (built later) and the current text UI (built now) both
// have one unambiguous source of truth for "what is Yahalla doing right
// now", and so transitions stay predictable instead of ad hoc.
const ALLOWED_TRANSITIONS: Record<AvatarState, AvatarState[]> = {
  IDLE: ['LISTENING', 'THINKING', 'NEEDS_PERMISSION'],
  LISTENING: ['THINKING', 'IDLE', 'NEEDS_PERMISSION'],
  THINKING: ['ACTING', 'SPEAKING', 'WAITING', 'ERROR', 'SUCCESS', 'NEEDS_CLARIFICATION'],
  ACTING: ['THINKING', 'WAITING', 'ERROR', 'SUCCESS', 'NEEDS_PERMISSION'],
  WAITING: ['THINKING', 'ACTING', 'IDLE', 'ERROR'],
  SPEAKING: ['IDLE', 'LISTENING', 'THINKING'],
  ERROR: ['IDLE', 'THINKING'],
  SUCCESS: ['IDLE', 'THINKING'],
  NEEDS_PERMISSION: ['IDLE', 'THINKING'],
  NEEDS_CLARIFICATION: ['IDLE', 'LISTENING', 'THINKING'],
}

export class EmbodimentStateMachine {
  private emitter = new EventEmitter()
  private current: AvatarState = 'IDLE'
  private lastSummary: string | null = null

  constructor() {
    this.emitter.setMaxListeners(50)
  }

  getState(): StatusUpdate {
    return { state: this.current, summary: this.lastSummary, timestamp: new Date().toISOString() }
  }

  // Concise, human-readable action/status summaries only -- e.g. "Reading
  // pricing engine", "Running tests" -- never raw model reasoning/chain of
  // thought. transition() is deliberately forgiving about invalid target
  // states (falls back to just updating the summary) rather than throwing,
  // since a live status stream should never crash the agent loop it's
  // reporting on.
  transition(next: AvatarState, summary?: string): StatusUpdate {
    const allowed = ALLOWED_TRANSITIONS[this.current]?.includes(next) ?? false
    if (allowed || next === this.current) {
      this.current = next
    }
    if (summary !== undefined) this.lastSummary = summary
    const update = this.getState()
    this.emitter.emit('update', update)
    return update
  }

  onUpdate(listener: (update: StatusUpdate) => void): () => void {
    this.emitter.on('update', listener)
    return () => this.emitter.off('update', listener)
  }
}
