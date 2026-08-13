// Deliberately duplicated from src/lib/langDetect.ts rather than shared
// via a workspace package: this is a small (~100 line), pure,
// dependency-free module with zero DOM/browser API surface, and
// local-runtime (a separate Node package, no bundler) has no existing
// path to import frontend-only TypeScript. Keep any behavioral change
// mirrored in both files -- see src/lib/langDetect.ts for the full
// rationale comment.

export type LanguageMatch = { code: string; name: string; confidence: number }

export const DEFAULT_LANGUAGE_MATCH: LanguageMatch = { code: 'ar', name: 'Arabic', confidence: 0 }

type ScriptRule = { code: string; name: string; pattern: string }

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

const SCRIPT_FRACTION_THRESHOLD = 0.25

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

export function languageInstructionLine(match: LanguageMatch): string {
  return `Always reply in ${match.name} (the language the user's most recent message is written in). Never mix words from an unrelated language into a sentence -- if you don't know a term, say it in the reply's own language instead of substituting a foreign word.`
}
