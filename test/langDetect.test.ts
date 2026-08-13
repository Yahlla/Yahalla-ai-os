import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectLanguage, speechLangTag } from '../src/lib/langDetect.ts'

test('Arabic script is detected', () => {
  assert.equal(detectLanguage('مرحباً، كيف يمكنني مساعدتك اليوم؟').code, 'ar')
})

test('English is detected via marker words', () => {
  assert.equal(detectLanguage('Hello, I have a question about my delivery and where it is right now.').code, 'en')
})

test('Chinese script is detected', () => {
  assert.equal(detectLanguage('你好,我想查询一下我的订单在哪里.').code, 'zh')
})

test('French is detected via marker words', () => {
  assert.equal(detectLanguage('Bonjour, je voudrais savoir où est ma commande, ce n\'est pas encore arrivé.').code, 'fr')
})

test('Spanish is detected via marker words', () => {
  assert.equal(detectLanguage('Hola, mi pedido está retrasado y también quiero saber por qué, gracias.').code, 'es')
})

test('German is detected via marker words', () => {
  assert.equal(detectLanguage('Hallo, meine Bestellung ist nicht angekommen und ich bin sehr besorgt.').code, 'de')
})

test('Russian (Cyrillic) is detected', () => {
  assert.equal(detectLanguage('Здравствуйте, где сейчас находится моя посылка?').code, 'ru')
})

test('Hindi (Devanagari) is detected', () => {
  assert.equal(detectLanguage('नमस्ते, मेरा ऑर्डर अभी तक नहीं पहुंचा है।').code, 'hi')
})

test('Japanese (with kana) is detected, not misread as Chinese', () => {
  assert.equal(detectLanguage('こんにちは、荷物はいつ届きますか？').code, 'ja')
})

test('Korean (Hangul) is detected', () => {
  assert.equal(detectLanguage('안녕하세요, 제 주문은 어디에 있나요?').code, 'ko')
})

test('Portuguese is detected via marker words, not confused with Spanish', () => {
  assert.equal(detectLanguage('Olá, meu pedido não chegou e você não me respondeu ainda.').code, 'pt')
})

test('a short numeric-only message with no letters falls back to the caller default', () => {
  assert.equal(detectLanguage('12345 #67890').code, 'ar')
})

test('empty input falls back to the caller default', () => {
  assert.equal(detectLanguage('   ').code, 'ar')
})

test('a caller-supplied fallback overrides the built-in default', () => {
  assert.equal(detectLanguage('123', { code: 'en', name: 'English', confidence: 0 }).code, 'en')
})

test('an Arabic sentence with an embedded order number is still detected as Arabic', () => {
  assert.equal(detectLanguage('طلبي رقم 48213 لم يصل بعد، متى سيصل؟').code, 'ar')
})

test('unrecognized Latin-script text with no marker words falls back to English', () => {
  const result = detectLanguage('xyzabc qwerty foobar')
  assert.equal(result.code, 'en')
})

test('speechLangTag maps every detectLanguage code to a real BCP-47 tag', () => {
  assert.equal(speechLangTag('ar'), 'ar-SA')
  assert.equal(speechLangTag('en'), 'en-US')
  assert.equal(speechLangTag('fr'), 'fr-FR')
  assert.equal(speechLangTag('zh'), 'zh-CN')
  assert.equal(speechLangTag('ja'), 'ja-JP')
})

test('speechLangTag falls back to en-US for an unmapped code, not undefined/crash', () => {
  assert.equal(speechLangTag('xx'), 'en-US')
})

test('detectLanguage + speechLangTag chain end to end for a real voice-mode transcript', () => {
  const detected = detectLanguage('Bonjour, où est ma commande ?')
  assert.equal(speechLangTag(detected.code), 'fr-FR')
})
