# Human Perception & Embodied Interaction Layer

Extends the local-first architecture (see [ARCHITECTURE.md](ARCHITECTURE.md)) with
local perception, a local world model, and a live embodied-agent state machine.
Nothing here changes the core rule: everything runs on the user's own device.
No Cloudflare, no remote vision/speech API, no VPS, no dependency on any other
machine.

```
Camera/Microphone permission (explicit, per-device, off by default)
        │
        ▼
Perception Provider  (local-runtime/src/perception/providers/)
   - mock (implemented, used for tests and this phase's vertical slice)
   - browser/native (integration point, not implemented this phase)
        │  PerceptionEvent { type, timestamp, source, confidence, privacyScope, sessionId, data }
        ▼
Perception Event Bus  (local-runtime/src/perception/eventBus.ts)
   in-memory, bounded (200 events), 5-minute TTL, no disk persistence by default
        │
        ▼
World Model  (local-runtime/src/perception/worldModel.ts)
   Human[] { identity?, face, gaze, hands, body, voice, interactionState }
   Environment { visibleObjects, application, uiElements, interactionTarget }
        │
        ▼
Agent Runtime (local-runtime/src/agentLoop.ts)
   folds a probabilistic, confidence-scored summary of the World Model into
   the system prompt as *weak supporting context* -- never as fact, never
   overriding the user's actual text/voice input
        │
        ▼
Embodiment State Machine (local-runtime/src/embodiment/stateMachine.ts)
   IDLE / LISTENING / THINKING / SPEAKING / ACTING / WAITING / ERROR /
   SUCCESS / NEEDS_PERMISSION / NEEDS_CLARIFICATION
        │  SSE: GET /live/stream
        ▼
Control Center UI (src/App.tsx, src/lib/localRuntime.ts)
   shows live concise status ("Reading pricing engine", "Running tests"),
   never raw chain-of-thought
```

## What perception is -- and is not

Every perception event carries a `confidence` value in `[0, 1]` and a
`privacyScope`. The system never claims to read emotion, intention, or
thought from a face or body. Example, matching the schema exactly as
specified for this phase:

```json
{
  "type": "gaze.updated",
  "timestamp": "2026-08-11T16:00:00.000Z",
  "source": "mock",
  "confidence": 0.85,
  "privacyScope": "ephemeral",
  "sessionId": "…",
  "data": { "trackId": "mock-1", "target": "screen_element" }
}
```

Event types implemented: `person.detected`, `person.left`, `face.updated`,
`gaze.updated`, `head_pose.updated`, `hand.updated`, `gesture.detected`,
`body_pose.updated`, `speech.started`, `speech.partial`, `speech.final`,
`speech.stopped`. Identity (`Human.identity`) is `null` unless the user has
separately, explicitly enabled identification -- there is no code path in
this phase that sets it to anything else.

## Privacy defaults (enforced, not just documented)

- Camera and microphone are **off** by default: `permissions` table entries
  for the `camera`/`microphone` scopes start unset (`checkAccess` returns
  `false`), and `PerceptionManager.start()` refuses to run any provider
  until both are explicitly granted -- verified in
  `local-runtime/test/perception.test.ts` ("perception cannot start without
  an explicit permission grant").
- No raw video/audio frame ever enters the event schema -- only derived,
  numeric/labelled signals (landmark coordinates, a gaze target string, a
  gesture label, transcribed text). There is nothing in this architecture
  that *could* upload a frame even if it wanted to.
- No remote upload: `PerceptionEventBus` and `WorldModel` are in-process,
  in-memory only.
- Bounded retention: the event bus keeps at most 200 events and drops
  anything older than 5 minutes automatically, independent of manual
  deletion.
- `DELETE /perception/history` clears both the event history **and** the
  World Model's current state -- an explicit, immediate "forget everything
  perception currently knows" action.
- `GET /perception/status` reports whether a provider is actively running,
  the basis for a recording/processing indicator in the UI (not yet wired
  into a visible indicator component this phase -- see Known gaps).

## HTTP API (local-runtime, all routes below require the local bearer token except /health)

| Route | Method | Purpose |
|---|---|---|
| `/perception/providers` | GET | List registered providers and what they claim to emit |
| `/perception/start` | POST `{provider}` | Start a provider; 403 + `NEEDS_PERMISSION` if camera/mic not granted |
| `/perception/stop` | POST | Stop the active provider |
| `/perception/status` | GET | `{active, provider, sessionId}` |
| `/perception/world-model` | GET | Current World Model snapshot |
| `/perception/history` | DELETE | Clear event history + World Model |
| `/perception/events` | POST | Ingestion point for an external capture source (see below) |
| `/live/stream` | GET (SSE) | Combined perception + embodiment live stream |

## Provider interface -- the real vs. integration-point boundary

`local-runtime/src/perception/providers/types.ts` defines `PerceptionProvider`
(`capabilities()`, `start(bus, sessionId)`, `stop()`, `isRunning()`). Two
implementations exist:

- **`MockPerceptionProvider`** (implemented, tested): emits a deterministic
  scripted sequence of every event type this phase defines. It exists
  specifically so the full pipeline -- permission gating, bus, world model,
  agent context, live SSE -- is provably correct without a camera, GPU, or
  vision model, in any environment including a headless CI/sandbox.
- **A real vision/speech provider** (integration point, not implemented):
  the interface is what a future MediaPipe-in-renderer bridge, or a native
  macOS/Windows/Linux/iOS/Android module, would implement. Two integration
  paths are already wired for it:
  1. Run as an in-process `PerceptionProvider` if the runtime process itself
     can reach the camera/mic (native module case).
  2. Push already-derived events to `POST /perception/events` from wherever
     capture actually happens (e.g. a browser tab using
     `getUserMedia` + an in-browser WASM model) -- the manager only accepts
     ingested events for an active, permitted session, and only ever
     receives derived signals matching the same `PerceptionEvent` schema,
     never raw frames.

No cloud vision/speech API was introduced anywhere in this phase.

## Embodiment state machine

A explicit 10-state machine (`local-runtime/src/embodiment/stateMachine.ts`),
not a free-form string, with a defined transition table. The agent loop
(`agentLoop.ts`) drives it for real during every chat turn: `THINKING` while
calling the local LLM, `ACTING` with a concise summary while running a tool
(`"Reading package.json"`, `"Running npm test"`, `"Command completed
successfully"`), `WAITING` while paused for approval, `SPEAKING` when it has
an answer, `SUCCESS`/`ERROR` at the end, `NEEDS_PERMISSION` when perception
was requested without a grant. This is the same status vocabulary the UI
requirement asked for -- concise summaries, never raw chain-of-thought.

## Platform capability matrix

Honest, per platform, as of this phase:

| Platform | Camera/mic capture | Local perception model | Status |
|---|---|---|---|
| Browser (Electron renderer, any OS) | `navigator.mediaDevices` (real, `src/lib/capabilities.ts`) | none wired yet (e.g. MediaPipe Tasks Vision WASM) | Capability detection implemented; capture+model integration is next phase |
| macOS native | AVFoundation | none | Integration point only |
| Windows native | Media Foundation | none | Integration point only |
| Linux native | V4L2 / PipeWire | none | Integration point only |
| iOS/iPadOS | AVFoundation (native app required) | none | Integration point only, needs a native app shell |
| Android | CameraX (native app required) | none | Integration point only, needs a native app shell |
| Mock (any platform, no camera needed) | N/A | scripted synthetic events | **Fully implemented and tested** |

`local-runtime`'s `/hardware` endpoint is explicit about what it cannot
determine itself (camera/mic/GPU/NPU presence) rather than guessing --
`perception.cameraDetectable`/`microphoneDetectable`/`gpuDetectable`/
`npuDetectable` are always `false` with a `detectVia` pointer to where real
detection actually happens (the browser/Electron renderer, via
`navigator.mediaDevices`/`navigator.gpu`, or a future native module).

## What's real vs. what remains an integration point

**Real and tested this phase** (`local-runtime/test/perception.test.ts`, 8
tests): permission-gated provider start (blocked without grant, works after
granting camera+microphone), the mock provider's full scripted event
sequence flowing through the bus into the World Model (person → face → gaze
→ head pose → hand → gesture → speech start/partial/final/stop), gaze
target and voice transcript correctly reflected in the World Model snapshot,
history deletion clearing both the bus and the World Model, and the
embodiment state machine's transitions/subscriptions. The existing chat
integration tests also still pass with perception inactive, confirming nothing
here changed the baseline behavior or silently activates anything.

**Integration points, explicitly not implemented this phase:**
- No real camera/microphone capture code (browser `getUserMedia` wiring, or
  any native platform module).
- No real local vision model (face/hand/pose landmark detection) or speech
  model (VAD/STT/TTS) is bundled or invoked -- `local_speech_to_text`/
  `local_text_to_speech` integration points are defined by the event schema
  (`speech.*` events, provider interface) but have no real engine behind
  them yet.
- No avatar rendering (2D/3D) -- only the state machine it would be driven
  by.
- No visible recording/processing indicator component in the UI yet
  (`/perception/status` exists and is enough to build one from).
- No embedding/vector-based "is this gaze target semantically the file the
  user is talking about" reasoning -- the World Model → system-prompt link
  is a plain, honest text summary today.
