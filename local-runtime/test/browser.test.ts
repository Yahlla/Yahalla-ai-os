import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer } from 'node:http'
import { after, before, test } from 'node:test'
import {
  browserClick,
  browserClose,
  browserOpen,
  browserRead,
  browserType,
  closeBrowserSession,
  findChromiumExecutable,
} from '../src/browser.js'

// findChromiumExecutable: real filesystem checks, no mocking.

test('findChromiumExecutable honors YAHALLA_CHROMIUM_PATH when it really exists', () => {
  const previous = process.env.YAHALLA_CHROMIUM_PATH
  try {
    process.env.YAHALLA_CHROMIUM_PATH = process.execPath // node itself definitely exists
    assert.equal(findChromiumExecutable(), process.execPath)
  } finally {
    if (previous === undefined) delete process.env.YAHALLA_CHROMIUM_PATH
    else process.env.YAHALLA_CHROMIUM_PATH = previous
  }
})

test('findChromiumExecutable ignores YAHALLA_CHROMIUM_PATH when it does not exist, falls through to other candidates', () => {
  const previous = process.env.YAHALLA_CHROMIUM_PATH
  try {
    process.env.YAHALLA_CHROMIUM_PATH = '/definitely/not/a/real/browser/binary'
    // Whatever this returns (a real system browser or null) must not be
    // the bogus path itself.
    assert.notEqual(findChromiumExecutable(), '/definitely/not/a/real/browser/binary')
  } finally {
    if (previous === undefined) delete process.env.YAHALLA_CHROMIUM_PATH
    else process.env.YAHALLA_CHROMIUM_PATH = previous
  }
})

// browserOpen's URL-scheme guard runs before any browser session is
// created, so this is real and deterministic regardless of whether a
// browser is actually installed in the environment running the tests.
test('browserOpen refuses non-http(s) URLs without ever launching a browser', async () => {
  const result = await browserOpen({ url: 'file:///etc/passwd' })
  assert.equal(result.success, false)
  assert.match(String(result.error), /only http:\/\/ and https:\/\/ URLs/)
})

test('browserOpen refuses an unparsable URL', async () => {
  const result = await browserOpen({ url: 'not a url at all' })
  assert.equal(result.success, false)
})

// Everything below drives a real headless Chromium against a real local
// HTTP fixture server -- skipped only if this environment genuinely has no
// browser to automate (findChromiumExecutable() returns null), which is
// an honest hardware/installation-dependent limitation, not something to
// fake around.
const hasBrowser = findChromiumExecutable() !== null

function startFixtureServer(port: number) {
  const server = createFakeHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    res.setHeader('Content-Type', 'text/html')

    if (url.pathname === '/') {
      res.end(`<!doctype html><html><head><title>Fixture Home</title></head><body>
        <p>Welcome to the fixture site.</p>
        <a href="/page2" id="go">Go to page 2</a>
        <form action="/search" method="get">
          <input name="q" id="q" />
        </form>
      </body></html>`)
      return
    }
    if (url.pathname === '/page2') {
      res.end(`<!doctype html><html><head><title>Page Two</title></head><body><h1>Page Two</h1><p>Hello world</p></body></html>`)
      return
    }
    if (url.pathname === '/search') {
      const q = url.searchParams.get('q') ?? ''
      res.end(`<!doctype html><html><head><title>Search Results</title></head><body><p id="result">You searched for: ${q}</p></body></html>`)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  return new Promise<import('node:http').Server>((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

let fixtureServer: import('node:http').Server
let baseUrl: string

before(async () => {
  fixtureServer = await startFixtureServer(18408)
  baseUrl = 'http://127.0.0.1:18408'
})

after(async () => {
  await closeBrowserSession()
  fixtureServer.close()
})

test('browserOpen navigates to a real local page and reports its real title', { skip: !hasBrowser }, async () => {
  const result = await browserOpen({ url: `${baseUrl}/` })
  assert.equal(result.success, true)
  assert.equal(result.title, 'Fixture Home')
  assert.equal(result.url, `${baseUrl}/`)
})

test('browserRead with no selector returns real visible page text', { skip: !hasBrowser }, async () => {
  const result = await browserRead({})
  assert.equal(result.success, true)
  assert.match(String(result.text), /Welcome to the fixture site/)
})

test('browserRead with a selector extracts only matching elements', { skip: !hasBrowser }, async () => {
  const result = await browserRead({ selector: '#go' })
  assert.equal(result.success, true)
  assert.deepEqual(result.matches, ['Go to page 2'])
})

test('browserRead with a selector matching nothing returns a clear error', { skip: !hasBrowser }, async () => {
  const result = await browserRead({ selector: '#does-not-exist' })
  assert.equal(result.success, false)
  assert.match(String(result.error), /No elements matched/)
})

test('browserClick follows a real link and the session reflects the new real page', { skip: !hasBrowser }, async () => {
  const result = await browserClick({ selector: '#go' })
  assert.equal(result.success, true)
  assert.equal(result.title, 'Page Two')
  assert.equal(result.url, `${baseUrl}/page2`)

  const read = await browserRead({ selector: 'h1' })
  assert.deepEqual(read.matches, ['Page Two'])
})

test('browserType fills a real input and submit=true actually submits the form', { skip: !hasBrowser }, async () => {
  await browserOpen({ url: `${baseUrl}/` })
  const result = await browserType({ selector: '#q', text: 'yahalla', submit: true })
  assert.equal(result.success, true)
  assert.match(String(result.url), /\/search\?q=yahalla/)
  assert.equal(result.title, 'Search Results')

  const read = await browserRead({ selector: '#result' })
  assert.deepEqual(read.matches, ['You searched for: yahalla'])
})

test('browserClick against a selector that matches nothing returns a clear error, not a crash', { skip: !hasBrowser }, async () => {
  const result = await browserClick({ selector: '#totally-missing' })
  assert.equal(result.success, false)
  assert.ok(result.error)
})

test('browserClose actually tears down the session, and a subsequent open starts a fresh one', { skip: !hasBrowser }, async () => {
  const closeResult = await browserClose()
  assert.equal(closeResult.success, true)

  const reopened = await browserOpen({ url: `${baseUrl}/page2` })
  assert.equal(reopened.success, true)
  assert.equal(reopened.title, 'Page Two')
})
