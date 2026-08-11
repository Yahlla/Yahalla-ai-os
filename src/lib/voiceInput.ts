// Browser-native speech-to-text (Web Speech API) -- zero dependency, no
// model, no server call: this is the browser's own OS-level speech
// recognition, the same category of capability as navigator.mediaDevices
// already used in capabilities.ts. Not universally supported (Safari/
// Firefox lag Chrome/Edge here); isSpeechRecognitionSupported() is the
// honest capability check the composer's mic button gates on.

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
