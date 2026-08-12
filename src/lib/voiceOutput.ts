// Browser-native text-to-speech (Web Speech Synthesis API) -- the output
// half of Voice Call mode, paired with voiceInput.ts's speech-to-text.
// Zero dependency, no model, nothing leaves the device: this is the
// browser's own OS-level TTS engine, same category as SpeechRecognition.

export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

export type SpeechHandle = { cancel: () => void }

// iOS Safari (and some other WebKit builds) only lets speechSynthesis
// actually produce audio the first time speak() runs synchronously inside
// a real user-gesture event handler (a click). Every later speak() call
// from inside an async callback -- which is exactly how the call loop
// naturally speaks each reply, after an awaited network response -- gets
// silently swallowed unless the engine was already "unlocked" this way
// once. Call this directly inside the triggering button's onClick,
// before any `await`, not from anywhere async.
export function unlock(): void {
  if (!isSpeechSynthesisSupported()) return
  const utterance = new SpeechSynthesisUtterance(' ')
  utterance.volume = 0
  window.speechSynthesis.speak(utterance)
}

// Voice lists load asynchronously in some browsers (Chrome fires
// `voiceschanged` once populated) -- this waits for that once, briefly,
// rather than silently speaking with the browser's bare default voice
// every single time just because voices hadn't loaded yet on this call.
function getVoices(): Promise<SpeechSynthesisVoice[]> {
  const existing = window.speechSynthesis.getVoices()
  if (existing.length > 0) return Promise.resolve(existing)
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(window.speechSynthesis.getVoices()), 500)
    window.speechSynthesis.onvoiceschanged = () => {
      clearTimeout(timeout)
      resolve(window.speechSynthesis.getVoices())
    }
  })
}

// The Web Speech API has no "gender" field on a voice -- exposing the
// real, device-provided voice list (names like "Maged"/"Tarik" on iOS,
// "Microsoft Naayf"/"Zeina" on Windows, etc.) and letting the user pick
// one directly is the only honest way to offer a choice here, rather than
// guessing gender from a name pattern that varies by OS/browser vendor.
export async function listVoicesForLang(langPrefix: string): Promise<SpeechSynthesisVoice[]> {
  const voices = await getVoices()
  return voices.filter((v) => v.lang.toLowerCase().startsWith(langPrefix.toLowerCase()))
}

export async function speak(
  text: string,
  options: { lang?: string; voiceURI?: string; onEnd?: () => void; onError?: (message: string) => void } = {},
): Promise<SpeechHandle> {
  const lang = options.lang ?? 'ar-SA'
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = lang

  const voices = await getVoices()
  const match =
    (options.voiceURI ? voices.find((v) => v.voiceURI === options.voiceURI) : undefined) ??
    voices.find((v) => v.lang === lang) ??
    voices.find((v) => v.lang.startsWith(lang.split('-')[0]!))
  if (match) utterance.voice = match

  utterance.onend = () => options.onEnd?.()
  utterance.onerror = (event) => options.onError?.(event.error || 'Speech synthesis failed.')

  window.speechSynthesis.speak(utterance)
  return { cancel: () => window.speechSynthesis.cancel() }
}
