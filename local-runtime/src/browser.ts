import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'

// Real browser automation as an Agent Runtime tool -- not a page the user
// opens themselves. Uses playwright-core (the driver library, no bundled
// browser-download machinery) pointed at whatever real Chromium/Chrome/Edge
// already exists on this machine, so nothing extra is downloaded at
// runtime -- consistent with the rest of this project's "self-hosted
// assets, nothing fetched from a third party at runtime" pattern.

const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:'])
const MAX_TEXT_CHARS = 15_000
const NAVIGATION_TIMEOUT_MS = 20_000
// Deliberately shorter than navigation: a click/type against a selector
// that never appears should fail back to the model quickly so it can
// re-read the page and try a different selector, not stall the whole task
// for a full navigation-length timeout.
const ACTION_TIMEOUT_MS = 8_000
const IDLE_CLOSE_MS = 10 * 60 * 1000

function candidateChromiumPaths(): string[] {
  const candidates: string[] = []
  if (process.env.YAHALLA_CHROMIUM_PATH) candidates.push(process.env.YAHALLA_CHROMIUM_PATH)

  // Pre-provisioned Playwright browser installs (PLAYWRIGHT_BROWSERS_PATH),
  // when present -- e.g. a dev/CI sandbox that already has one, or a
  // desktop build that bundled one via the same self-hosted-assets pattern
  // used elsewhere in this repo (scripts/copy-*-assets.mjs).
  const browsersDir = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (browsersDir && existsSync(browsersDir)) {
    try {
      for (const entry of readdirSync(browsersDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('chromium')) continue
        candidates.push(join(browsersDir, entry.name, 'chrome-linux', 'chrome'))
        candidates.push(join(browsersDir, entry.name, 'chrome-win', 'chrome.exe'))
        candidates.push(join(browsersDir, entry.name, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'))
      }
    } catch {
      // best-effort discovery only
    }
  }

  candidates.push(
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/opt/google/chrome/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  )
  return candidates
}

// Real, verified presence -- never a guess. Returns null (not a throw) so
// callers can surface an honest "browser tool unavailable on this machine"
// message instead of crashing the whole tool-call round.
export function findChromiumExecutable(): string | null {
  for (const candidate of candidateChromiumPaths()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

type Session = { browser: Browser; page: Page; lastUsed: number }
let session: Session | null = null
let idleTimer: ReturnType<typeof setInterval> | null = null

function touchIdleTimer(): void {
  if (idleTimer) return
  idleTimer = setInterval(() => {
    if (session && Date.now() - session.lastUsed > IDLE_CLOSE_MS) {
      void closeBrowserSession()
    }
  }, 60_000)
  idleTimer.unref?.()
}

async function getOrCreateSession(): Promise<{ ok: true; page: Page } | { ok: false; error: string }> {
  if (session) {
    session.lastUsed = Date.now()
    return { ok: true, page: session.page }
  }

  const executablePath = findChromiumExecutable()
  if (!executablePath) {
    return {
      ok: false,
      error:
        'No Chromium/Chrome/Edge browser was found on this machine. The browser tool needs one already installed to automate -- install Google Chrome, Chromium, or Microsoft Edge, or set YAHALLA_CHROMIUM_PATH to a browser executable.',
    }
  }

  // --no-sandbox is required when this process runs as root (common in
  // containers/CI, and true of the environment these tests run in) --
  // Chromium's own sandbox refuses to initialize for a root process
  // regardless of which binary launches it. Harmless for a normal
  // non-root desktop user; Playwright itself defaults to this in many
  // automation contexts for the same reason.
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  page.setDefaultTimeout(ACTION_TIMEOUT_MS)
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
  session = { browser, page, lastUsed: Date.now() }
  touchIdleTimer()
  return { ok: true, page: session.page }
}

export async function closeBrowserSession(): Promise<void> {
  if (idleTimer) {
    clearInterval(idleTimer)
    idleTimer = null
  }
  if (!session) return
  const toClose = session
  session = null
  try {
    await toClose.browser.close()
  } catch {
    // already gone -- nothing to clean up
  }
}

function isAllowedUrl(rawUrl: string): boolean {
  try {
    return ALLOWED_URL_SCHEMES.has(new URL(rawUrl).protocol)
  } catch {
    return false
  }
}

export async function browserOpen(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = String(args.url ?? '')
  if (!isAllowedUrl(url)) {
    return { success: false, error: `Refusing to open "${url}": only http:// and https:// URLs are allowed.` }
  }

  const sessionResult = await getOrCreateSession()
  if (!sessionResult.ok) return { success: false, error: sessionResult.error }

  try {
    await sessionResult.page.goto(url, { waitUntil: 'domcontentloaded' })
    return { success: true, url: sessionResult.page.url(), title: await sessionResult.page.title() }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Navigation failed.' }
  }
}

export async function browserRead(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const selector = typeof args.selector === 'string' && args.selector.length > 0 ? args.selector : null
  const sessionResult = await getOrCreateSession()
  if (!sessionResult.ok) return { success: false, error: sessionResult.error }
  const page = sessionResult.page

  try {
    if (selector) {
      const matches = await page.locator(selector).allTextContents()
      if (matches.length === 0) {
        return { success: false, error: `No elements matched selector "${selector}".` }
      }
      const trimmed = matches.map((t) => t.trim()).filter((t) => t.length > 0)
      return { success: true, url: page.url(), selector, matches: trimmed.slice(0, 50) }
    }

    const text = await page.locator('body').innerText()
    const truncated = text.length > MAX_TEXT_CHARS
    return {
      success: true,
      url: page.url(),
      title: await page.title(),
      text: text.slice(0, MAX_TEXT_CHARS),
      truncated,
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Reading the page failed.' }
  }
}

export async function browserClick(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const selector = String(args.selector ?? '')
  const sessionResult = await getOrCreateSession()
  if (!sessionResult.ok) return { success: false, error: sessionResult.error }
  const page = sessionResult.page

  try {
    await page.locator(selector).first().click()
    // A click can trigger navigation (link, form submit) -- give the page
    // a short, bounded chance to settle before reporting back, but never
    // fail the click itself if nothing navigates (most clicks don't).
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {})
    return { success: true, url: page.url(), title: await page.title() }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : `Clicking "${selector}" failed.` }
  }
}

export async function browserType(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const selector = String(args.selector ?? '')
  const text = String(args.text ?? '')
  const submit = args.submit === true
  const sessionResult = await getOrCreateSession()
  if (!sessionResult.ok) return { success: false, error: sessionResult.error }
  const page = sessionResult.page

  try {
    const locator = page.locator(selector).first()
    await locator.fill(text)
    if (submit) {
      await locator.press('Enter')
      await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {})
    }
    return { success: true, url: page.url(), title: await page.title() }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : `Typing into "${selector}" failed.` }
  }
}

export async function browserClose(): Promise<Record<string, unknown>> {
  await closeBrowserSession()
  return { success: true }
}
