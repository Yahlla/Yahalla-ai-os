// Browser-native speech-to-text (Web Speech API) -- zero dependency, no
// model bundled/downloaded by this app, no server of ours involved. Not
// universally supported (Safari/Firefox lag Chrome/Edge here);
// isSpeechRecognitionSupported() is the honest capability check the
// composer's mic button and call mode gate on.
//
// Known limitation, stated plainly rather than glossed over: in Chrome/
// Edge (the browsers that actually implement this API), the audio is sent
// to the browser vendor's own cloud speech-recognition service -- this is
// how the Web Speech API itself works everywhere it ships, not a choice
// this app makes. It is not routed through any Yahalla/Strato server and
// no chat/agent inference happens there, but it is not on-device
// recognition either, unlike this app's TTS (voiceOutput.ts, genuinely
// local via speechSynthesis) or its text-chat LLM tiers. A fully local
// STT path would mean bundling a real on-device model (e.g. a WASM-
// compiled Whisper build, following the same self-hosted-asset pattern
// already used for OCR/wllama/MediaPipe) -- not implemented here; this
// module is the honest browser-native fallback, not a claim of full
// on-device recognition.

// Not in TypeScript's standard DOM lib (still marked experimental) --
// this is the minimal shape this module actually uses, not a full typing
// of the API.
interface SpeechRecognitionResultLike {
  isFinal: boolean
  0: { transcript: string }
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<SpeechRecognitionResultLike>
}
interface SpeechRecognitionErrorEventLike {
  error: string
}
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function isSpeechRecognitionSupported(): boolean {
  return getRecognitionCtor() !== null
}

export type VoiceRecognizer = { start: () => void; stop: () => void }

export function createVoiceRecognizer(options: {
  lang?: string
  onTranscript: (text: string, isFinal: boolean) => void
  onEnd: () => void
  onError: (message: string) => void
}): VoiceRecognizer | null {
  const Ctor = getRecognitionCtor()
  if (!Ctor) return null

  const recognition = new Ctor()
  recognition.lang = options.lang ?? 'ar-SA'
  recognition.interimResults = true
  recognition.continuous = false

  recognition.onresult = (event) => {
    let finalText = ''
    let interimText = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      if (!result) continue
      if (result.isFinal) finalText += result[0].transcript
      else interimText += result[0].transcript
    }
    if (finalText) options.onTranscript(finalText, true)
    else if (interimText) options.onTranscript(interimText, false)
  }
  recognition.onerror = (event) => options.onError(event.error || 'Speech recognition failed.')
  recognition.onend = () => options.onEnd()

  return { start: () => recognition.start(), stop: () => recognition.stop() }
}
