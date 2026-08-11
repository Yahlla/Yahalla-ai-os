import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { resolveProjectPath } from './sandbox.js'

const MAX_READ_BYTES = 1_000_000
const MAX_LIST_ENTRIES = 2000

export type ToolResult = { success: boolean; [key: string]: unknown }

export function readProjectFile(projectRoot: string, args: Record<string, unknown>): ToolResult {
  const path = String(args.path ?? args.file_path ?? '')
  const absolute = resolveProjectPath(projectRoot, path)

  const stat = statSync(absolute)
  if (!stat.isFile()) {
    return { success: false, error: `"${path}" is not a file.` }
  }
  if (stat.size > MAX_READ_BYTES) {
    return { success: false, error: `"${path}" is too large to read (${stat.size} bytes).` }
  }

  const content = readFileSync(absolute, 'utf8')
  return { success: true, path, content }
}

export function listProjectFiles(projectRoot: string, args: Record<string, unknown>): ToolResult {
  const path = String(args.path ?? '.')
  const root = path === '.' || path === '' ? resolve(projectRoot) : resolveProjectPath(projectRoot, path)

  const entries: string[] = []

  function walk(dir: string) {
    if (entries.length >= MAX_LIST_ENTRIES) return

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      entries.push(relative(projectRoot, full) + (entry.isDirectory() ? '/' : ''))
      if (entries.length >= MAX_LIST_ENTRIES) return
      if (entry.isDirectory()) walk(full)
    }
  }

  walk(root)

  return { success: true, path, entries, truncated: entries.length >= MAX_LIST_ENTRIES }
}

export function writeProjectFile(projectRoot: string, args: Record<string, unknown>): ToolResult {
  const path = String(args.path ?? args.file_path ?? '')
  const content = String(args.content ?? '')
  const absolute = resolveProjectPath(projectRoot, path)

  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content, 'utf8')

  return { success: true, path, bytes_written: Buffer.byteLength(content, 'utf8') }
}

/**
 * oldText must be an exact match of the file's current content at the
 * patched location — never invented. If it doesn't match, the caller (the
 * LLM, via the agent loop) must re-read the file and retry with the real
 * text; this tool refuses to guess.
 */
export function patchProjectFile(projectRoot: string, args: Record<string, unknown>): ToolResult {
  const path = String(args.path ?? args.file_path ?? '')
  const oldText = String(args.old_text ?? args.oldText ?? '')
  const newText = String(args.new_text ?? args.newText ?? '')
  const absolute = resolveProjectPath(projectRoot, path)

  const current = readFileSync(absolute, 'utf8')
  const index = current.indexOf(oldText)

  if (index === -1) {
    return {
      success: false,
      error: 'old_text was not found in the current file content. Re-read the file and retry with the exact text.',
      path,
    }
  }

  const nextIndex = current.indexOf(oldText, index + 1)
  if (nextIndex !== -1) {
    return {
      success: false,
      error: 'old_text matches more than one location in the file. Provide more surrounding context so the match is unique.',
      path,
    }
  }

  const patched = current.slice(0, index) + newText + current.slice(index + oldText.length)
  writeFileSync(absolute, patched, 'utf8')

  return { success: true, path }
}
