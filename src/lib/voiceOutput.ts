// Browser-native text-to-speech (Web Speech Synthesis API) -- the output
// half of Voice Call mode, paired with voiceInput.ts's speech-to-text.
// Zero dependency, no model, nothing leaves the device: this is the
// browser's own OS-level TTS engine, same category as SpeechRecognition.

export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

export type SpeechHandle = { cancel: () => void }

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

export async function speak(
  text: string,
  options: { lang?: string; onEnd?: () => void; onError?: (message: string) => void } = {},
): Promise<SpeechHandle> {
  const lang = options.lang ?? 'ar-SA'
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = lang

  const voices = await getVoices()
  const match = voices.find((v) => v.lang === lang) ?? voices.find((v) => v.lang.startsWith(lang.split('-')[0]!))
  if (match) utterance.voice = match

  utterance.onend = () => options.onEnd?.()
  utterance.onerror = (event) => options.onError?.(event.error || 'Speech synthesis failed.')

  window.speechSynthesis.speak(utterance)
  return { cancel: () => window.speechSynthesis.cancel() }
}
