// Perception is treated strictly as probabilistic signals, never as a
// claim about emotion, intention, or thought. Every event carries a
// confidence value and the caller decides what to do with low-confidence
// signals -- nothing here asserts certainty it doesn't have.

export type PrivacyScope = 'ephemeral' | 'session' | 'retained'

export type PerceptionEventType =
  | 'person.detected'
  | 'person.left'
  | 'face.updated'
  | 'gaze.updated'
  | 'head_pose.updated'
  | 'hand.updated'
  | 'gesture.detected'
  | 'body_pose.updated'
  | 'speech.started'
  | 'speech.partial'
  | 'speech.final'
  | 'speech.stopped'

export type PerceptionEvent<T extends Record<string, unknown> = Record<string, unknown>> = {
  type: PerceptionEventType
  timestamp: string
  source: string
  confidence: number
  privacyScope: PrivacyScope
  sessionId: string
  data: T
}

// --- Per-event data shapes -------------------------------------------------
// Deliberately minimal: positions/directions/labels only, never raw pixels
// or audio samples. A provider that wants to reason about raw frames does
// so internally and only ever emits derived signals like these.

export type PersonDetectedData = { trackId: string; boundingBox?: [number, number, number, number] }
export type PersonLeftData = { trackId: string }
export type FaceUpdatedData = { trackId: string; landmarks?: Array<[number, number]>; mouthOpenness?: number }
export type GazeUpdatedData = { trackId: string; target: string | null; direction?: [number, number, number] }
export type HeadPoseUpdatedData = { trackId: string; yaw: number; pitch: number; roll: number }
export type HandUpdatedData = {
  trackId: string
  hand: 'left' | 'right'
  landmarks?: Array<[number, number, number]>
}
export type GestureDetectedData = { trackId: string; gesture: string }
export type BodyPoseUpdatedData = { trackId: string; joints?: Record<string, [number, number, number]> }
export type SpeechStartedData = { trackId: string | null }
export type SpeechPartialData = { text: string }
export type SpeechFinalData = { text: string }
export type SpeechStoppedData = { durationMs: number }

// --- World Model -------------------------------------------------------

export type InteractionState = 'idle' | 'engaged' | 'speaking' | 'gesturing'

export type HumanState = {
  trackId: string
  identity: { verified: boolean; label: string | null } | null // null unless identification is explicitly permitted
  face: { landmarks?: Array<[number, number]>; mouthOpenness?: number; confidence: number; updatedAt: string } | null
  gaze: { target: string | null; confidence: number; updatedAt: string } | null
  headPose: { yaw: number; pitch: number; roll: number; confidence: number; updatedAt: string } | null
  hands: Partial<Record<'left' | 'right', { landmarks?: Array<[number, number, number]>; confidence: number; updatedAt: string }>>
  body: { joints?: Record<string, [number, number, number]>; confidence: number; updatedAt: string } | null
  voice: { speaking: boolean; lastPartial: string | null; lastFinal: string | null; updatedAt: string }
  interactionState: InteractionState
  lastSeen: string
}

export type EnvironmentState = {
  visibleObjects: string[]
  application: string | null
  uiElements: string[]
  interactionTarget: string | null
}

export type WorldModelSnapshot = {
  humans: HumanState[]
  environment: EnvironmentState
  updatedAt: string
}
