import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectLanguage } from '../src/langDetect.js'

// Mirrors test/langDetect.test.ts at the repo root (the frontend copy) --
// this is the same duplicated-by-design module (see langDetect.ts's
// header comment), so both copies get the same coverage.

test('Arabic script is detected', () => {
  assert.equal(detectLanguage('مرحباً، كيف يمكنني مساعدتك اليوم؟').code, 'ar')
})

test('English is detected via marker words', () => {
  assert.equal(detectLanguage('Hello, I have a question about my delivery and where it is right now.').code, 'en')
})

test('Chinese script is detected', () => {
  assert.equal(detectLanguage('你好,我想查询一下我的订单在哪里.').code, 'zh')
})

test('Japanese (with kana) is detected, not misread as Chinese', () => {
  assert.equal(detectLanguage('こんにちは、荷物はいつ届きますか？').code, 'ja')
})

test('Russian (Cyrillic) is detected', () => {
  assert.equal(detectLanguage('Здравствуйте, где сейчас находится моя посылка?').code, 'ru')
})

test('a caller-supplied fallback overrides the built-in default', () => {
  assert.equal(detectLanguage('123', { code: 'en', name: 'English', confidence: 0 }).code, 'en')
})

test('an Arabic sentence with an embedded order number is still detected as Arabic', () => {
  assert.equal(detectLanguage('طلبي رقم 48213 لم يصل بعد، متى سيصل؟').code, 'ar')
})
