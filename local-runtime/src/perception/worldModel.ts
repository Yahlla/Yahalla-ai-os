import type {
  BodyPoseUpdatedData,
  EnvironmentState,
  FaceUpdatedData,
  GazeUpdatedData,
  GestureDetectedData,
  HandUpdatedData,
  HeadPoseUpdatedData,
  HumanState,
  PerceptionEvent,
  PersonDetectedData,
  PersonLeftData,
  SpeechFinalData,
  SpeechPartialData,
  WorldModelSnapshot,
} from './types.js'
import type { PerceptionEventBus } from './eventBus.js'

function emptyHuman(trackId: string): HumanState {
  const now = new Date().toISOString()
  return {
    trackId,
    identity: null,
    face: null,
    gaze: null,
    headPose: null,
    hands: {},
    body: null,
    voice: { speaking: false, lastPartial: null, lastFinal: null, updatedAt: now },
    interactionState: 'idle',
    lastSeen: now,
  }
}

// Lightweight, incremental: applies one event at a time, never re-derives
// state from scratch. Holds no raw camera/audio data -- only the derived
// per-track fields defined in types.ts.
export class WorldModel {
  private humans = new Map<string, HumanState>()
  private environment: EnvironmentState = { visibleObjects: [], application: null, uiElements: [], interactionTarget: null }
  private updatedAt = new Date().toISOString()

  private getOrCreate(trackId: string): HumanState {
    let human = this.humans.get(trackId)
    if (!human) {
      human = emptyHuman(trackId)
      this.humans.set(trackId, human)
    }
    return human
  }

  apply(event: PerceptionEvent): void {
    this.updatedAt = event.timestamp

    switch (event.type) {
      case 'person.detected': {
        const data = event.data as PersonDetectedData
        const human = this.getOrCreate(data.trackId)
        human.lastSeen = event.timestamp
        break
      }
      case 'person.left': {
        const data = event.data as PersonLeftData
        this.humans.delete(data.trackId)
        break
      }
      case 'face.updated': {
        const data = event.data as FaceUpdatedData
        const human = this.getOrCreate(data.trackId)
        human.face = { landmarks: data.landmarks, mouthOpenness: data.mouthOpenness, confidence: event.confidence, updatedAt: event.timestamp }
        human.lastSeen = event.timestamp
        break
      }
      case 'gaze.updated': {
        const data = event.data as GazeUpdatedData
        const human = this.getOrCreate(data.trackId)
        human.gaze = { target: data.target, confidence: event.confidence, updatedAt: event.timestamp }
        if (data.target) this.environment.interactionTarget = data.target
        human.lastSeen = event.timestamp
        break
      }
      case 'head_pose.updated': {
        const data = event.data as HeadPoseUpdatedData
        const human = this.getOrCreate(data.trackId)
        human.headPose = { yaw: data.yaw, pitch: data.pitch, roll: data.roll, confidence: event.confidence, updatedAt: event.timestamp }
        human.lastSeen = event.timestamp
        break
      }
      case 'hand.updated': {
        const data = event.data as HandUpdatedData
        const human = this.getOrCreate(data.trackId)
        human.hands[data.hand] = { landmarks: data.landmarks, confidence: event.confidence, updatedAt: event.timestamp }
        human.interactionState = 'gesturing'
        human.lastSeen = event.timestamp
        break
      }
      case 'gesture.detected': {
        const data = event.data as GestureDetectedData
        const human = this.getOrCreate(data.trackId)
        human.interactionState = 'gesturing'
        human.lastSeen = event.timestamp
        break
      }
      case 'body_pose.updated': {
        const data = event.data as BodyPoseUpdatedData
        const human = this.getOrCreate(data.trackId)
        human.body = { joints: data.joints, confidence: event.confidence, updatedAt: event.timestamp }
        human.lastSeen = event.timestamp
        break
      }
      case 'speech.started': {
        // speech events aren't necessarily tied to a face track yet;
        // update every currently known human's voice state as a
        // conservative default when trackId is absent.
        for (const human of this.humans.values()) {
          human.voice.speaking = true
          human.voice.updatedAt = event.timestamp
          human.interactionState = 'speaking'
        }
        break
      }
      case 'speech.partial': {
        const data = event.data as SpeechPartialData
        for (const human of this.humans.values()) {
          human.voice.lastPartial = data.text
          human.voice.updatedAt = event.timestamp
        }
        break
      }
      case 'speech.final': {
        const data = event.data as SpeechFinalData
        for (const human of this.humans.values()) {
          human.voice.lastFinal = data.text
          human.voice.lastPartial = null
          human.voice.updatedAt = event.timestamp
        }
        break
      }
      case 'speech.stopped': {
        for (const human of this.humans.values()) {
          human.voice.speaking = false
          human.voice.updatedAt = event.timestamp
          human.interactionState = 'idle'
        }
        break
      }
    }
  }

  // Wires itself to every event on the bus -- callers don't need to know
  // which perception provider produced an event, only that it arrived.
  attachTo(bus: PerceptionEventBus): () => void {
    return bus.onEvent((event) => this.apply(event))
  }

  setEnvironment(patch: Partial<EnvironmentState>): void {
    this.environment = { ...this.environment, ...patch }
  }

  getSnapshot(): WorldModelSnapshot {
    return {
      humans: [...this.humans.values()],
      environment: this.environment,
      updatedAt: this.updatedAt,
    }
  }

  clear(): void {
    this.humans.clear()
    this.environment = { visibleObjects: [], application: null, uiElements: [], interactionTarget: null }
  }
}
