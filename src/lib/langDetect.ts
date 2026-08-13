// Fast, dependency-free language identification for "respond in the same
// language the user just wrote in." Two layers: (1) Unicode script
// detection, which is unambiguous and near-instant for the scripts below
// that map to one practical default language; (2) for the shared Latin
// script (English/French/Spanish/German/...), a small marker-word scorer,
// since script alone can't tell those apart. No model weights, no
// network, no async -- this runs in well under 5ms on any device,
// including the weakest phone, which is what makes it usable as the
// "instant" step ahead of the LLM call itself, not just an instruction
// hoped the model would follow.
//
// This is intentionally not a full langid/franc-class classifier: it is
// tuned for "which language should the reply be in," not linguistic
// research. Known, accepted limitations: Arabic-script text is always
// reported as Arabic (not distinguished from Persian/Urdu), and
// Cyrillic-script text is always reported as Russian (not distinguished
// from Ukrainian/Bulgarian/Serbian). A script that can't be confidently
// placed, or genuinely empty input, falls back to the caller-supplied
// default.

export type LanguageMatch = { code: string; name: string; confidence: number }

export const DEFAULT_LANGUAGE_MATCH: LanguageMatch = { code: 'ar', name: 'Arabic', confidence: 0 }

type ScriptRule = { code: string; name: string; pattern: string }

// Checked in this exact order -- scripts that can co-occur with a more
// specific one (Japanese text contains CJK ideographs too, e.g.) are
// ordered so the more specific script wins.
const SCRIPT_RULES: ScriptRule[] = [
  { code: 'ko', name: 'Korean', pattern: '[\\uAC00-\\uD7A3\\u1100-\\u11FF\\u3130-\\u318F]' },
  { code: 'ja', name: 'Japanese', pattern: '[\\u3040-\\u30FF\\u31F0-\\u31FF]' },
  { code: 'th', name: 'Thai', pattern: '[\\u0E00-\\u0E7F]' },
  { code: 'hi', name: 'Hindi', pattern: '[\\u0900-\\u097F]' },
  { code: 'ar', name: 'Arabic', pattern: '[\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF]' },
  { code: 'he', name: 'Hebrew', pattern: '[\\u0590-\\u05FF]' },
  { code: 'ru', name: 'Russian', pattern: '[\\u0400-\\u04FF]' },
  { code: 'el', name: 'Greek', pattern: '[\\u0370-\\u03FF]' },
  { code: 'zh', name: 'Chinese', pattern: '[\\u4E00-\\u9FFF\\u3400-\\u4DBF]' },
]

// A script fraction below this is treated as "a few loanwords/numbers in
// an otherwise different-script sentence," not the sentence's language.
const SCRIPT_FRACTION_THRESHOLD = 0.25

// Latin-script disambiguation: short function words per language,
// weighted by how unambiguous they are. Accented/unique forms ("não",
// "değil", "için") can't be mistaken for another language's word and are
// weighted higher ("strong"); plain unaccented forms ("de", "la", "el")
// are shared across several languages and only useful in aggregate
// ("weak").
const LATIN_MARKERS: Record<string, { name: string; strong: string[]; weak: string[] }> = {
  en: { name: 'English', strong: ['the', 'you', 'that', 'with', 'have', 'this', 'are', 'was', 'but', 'what'], weak: ['and', 'for', 'not'] },
  fr: { name: 'French', strong: ['être', 'vous', 'était', 'nous', 'très', 'avec'], weak: ['le', 'la', 'les', 'des', 'est', 'et', 'pas', 'une', 'un', 'dans', 'pour'] },
  es: { name: 'Spanish', strong: ['está', 'son', 'pero', 'más', 'también', 'porque'], weak: ['el', 'la', 'los', 'las', 'que', 'de', 'para', 'con', 'una', 'un'] },
  de: { name: 'German', strong: ['nicht', 'für', 'sind', 'auch', 'wird'], weak: ['der', 'die', 'das', 'und', 'mit', 'ein', 'eine', 'ist'] },
  it: { name: 'Italian', strong: ['sono', 'questo', 'anche', 'perché', 'però'], weak: ['il', 'la', 'che', 'di', 'non', 'per', 'con', 'una'] },
  pt: { name: 'Portuguese', strong: ['não', 'está', 'você', 'também', 'então'], weak: ['o', 'a', 'os', 'as', 'que', 'de', 'para', 'com', 'uma', 'um'] },
  nl: { name: 'Dutch', strong: ['niet', 'zijn', 'deze', 'heeft'], weak: ['de', 'het', 'een', 'van', 'is', 'en', 'voor', 'met', 'dat'] },
  tr: { name: 'Turkish', strong: ['değil', 'için', 'çok', 'şey'], weak: ['ve', 'bir', 'bu', 'ile', 'ben', 'sen'] },
  id: { name: 'Indonesian', strong: ['tidak', 'dengan', 'yang', 'untuk'], weak: ['dan', 'di', 'ini', 'saya'] },
  vi: { name: 'Vietnamese', strong: ['không', 'của', 'này', 'với'], weak: ['là', 'và', 'có', 'cho'] },
  sw: { name: 'Swahili', strong: ['kwa', 'hii', 'sana', 'lakini'], weak: ['na', 'ya', 'wa', 'ni', 'si'] },
}

function scoreLatin(text: string): LanguageMatch | null {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? []
  if (words.length === 0) return null
  const wordSet = new Set(words)

  let best: { code: string; name: string; score: number } | null = null
  for (const [code, markers] of Object.entries(LATIN_MARKERS)) {
    let score = 0
    for (const w of markers.strong) if (wordSet.has(w)) score += 3
    for (const w of markers.weak) if (wordSet.has(w)) score += 1
    if (score > 0 && (!best || score > best.score)) best = { code, name: markers.name, score }
  }
  if (!best) return null
  return { code: best.code, name: best.name, confidence: Math.min(1, best.score / (words.length * 2)) }
}

export function detectLanguage(text: string, fallback: LanguageMatch = DEFAULT_LANGUAGE_MATCH): LanguageMatch {
  const trimmed = text.trim()
  const letters = trimmed.match(/\p{L}/gu) ?? []
  if (letters.length === 0) return fallback

  for (const rule of SCRIPT_RULES) {
    const scriptChars = trimmed.match(new RegExp(rule.pattern, 'gu')) ?? []
    const fraction = scriptChars.length / letters.length
    if (fraction >= SCRIPT_FRACTION_THRESHOLD) {
      return { code: rule.code, name: rule.name, confidence: Math.min(1, fraction) }
    }
  }

  const latinChars = trimmed.match(/[A-Za-zÀ-ɏ]/gu) ?? []
  if (latinChars.length / letters.length >= 0.5) {
    return scoreLatin(trimmed) ?? { code: 'en', name: 'English', confidence: 0.1 }
  }

  return fallback
}

// Matches CLOUD_BOOST_SYSTEM_PROMPT's exact phrasing (App.tsx) so all
// three inference tiers (cloud, local-runtime, browser-WebGPU) give the
// model the identical instruction, worded identically -- the only
// difference is that this line is now built from a real per-message
// detection instead of a static "respond in the user's language" hope.
export function languageInstructionLine(match: LanguageMatch): string {
  return `Always reply in ${match.name} (the language the user's most recent message is written in). Never mix words from an unrelated language into a sentence -- if you don't know a term, say it in the reply's own language instead of substituting a foreign word.`
}
