import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

// Lightweight, local, dependency-free project understanding: a single
// filesystem walk (plus a handful of `git` reads) that gives the agent a
// structural overview -- language mix, detected package(s), config files
// present, top-level layout, git state -- without it having to burn
// several list_project_files/read_project_file round-trips just to get
// oriented on every new task. No embeddings, no network call, nothing
// sent anywhere: this is exactly the kind of local project understanding
// the browser/cloud tiers cannot offer, and read_project_file remains the
// only source of truth for a file's exact content -- this is a summary
// layer on top of it, never a replacement.

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.turbo', '.cache', '.vite'])
const MAX_FILES = 5000
const MAX_PACKAGE_JSON_DEPTH = 4

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript (React)',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript (React)',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.c': 'C',
  '.h': 'C header',
  '.cpp': 'C++',
  '.hpp': 'C++ header',
  '.sql': 'SQL',
  '.sh': 'Shell',
  '.md': 'Markdown',
  '.json': 'JSON',
  '.yml': 'YAML',
  '.yaml': 'YAML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.html': 'HTML',
}

const CONFIG_FILE_NAMES = new Set([
  'package.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'vite.config.ts',
  'vite.config.js',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.cjs',
  'eslint.config.js',
  'eslint.config.mjs',
  'docker-compose.yml',
  'docker-compose.yaml',
  'Dockerfile',
  '.env.example',
  'jest.config.js',
  'vitest.config.ts',
  'webpack.config.js',
  'babel.config.js',
  '.prettierrc',
  'Cargo.toml',
  'go.mod',
  'requirements.txt',
  'pyproject.toml',
  'Gemfile',
  'Makefile',
])

export type PackageInfo = {
  path: string
  name: string | null
  version: string | null
  private: boolean
  scripts: string[]
  dependencies: string[]
  devDependencies: string[]
  mainEntry: string | null
}

export type ProjectIndex = {
  projectRoot: string
  computedAt: string
  fileCount: number
  truncated: boolean
  languages: Record<string, number>
  configFiles: string[]
  packages: PackageInfo[]
  topLevelEntries: string[]
  git: { branch: string | null; latestCommit: string | null; remoteUrl: string | null; isDirty: boolean | null }
}

function languageFor(fileName: string): string | null {
  return LANGUAGE_BY_EXT[extname(fileName)] ?? null
}

function safeGit(projectRoot: string, args: string[]): string | null {
  try {
    const output = execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', timeout: 5000 })
    return output.trim() || null
  } catch {
    return null
  }
}

// Distinct from safeGit above: an empty `git status --porcelain` output is
// meaningful (a clean working tree), not the same as "unknown" -- collapsing
// it to null the way safeGit does for branch/commit/remote (where empty
// really does mean "nothing useful came back") would make a clean repo
// indistinguishable from a failed git call.
function safeGitStatusIsDirty(projectRoot: string): boolean | null {
  try {
    const output = execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8', timeout: 5000 })
    return output.trim().length > 0
  } catch {
    return null
  }
}

function readPackageJson(absPath: string, relDir: string): PackageInfo | null {
  try {
    const pkg = JSON.parse(readFileSync(absPath, 'utf8')) as Record<string, unknown>
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts as Record<string, unknown>) : []
    const dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? Object.keys(pkg.dependencies as Record<string, unknown>) : []
    const devDependencies =
      pkg.devDependencies && typeof pkg.devDependencies === 'object' ? Object.keys(pkg.devDependencies as Record<string, unknown>) : []
    return {
      path: relDir,
      name: typeof pkg.name === 'string' ? pkg.name : null,
      version: typeof pkg.version === 'string' ? pkg.version : null,
      private: pkg.private === true,
      scripts,
      dependencies,
      devDependencies,
      mainEntry: typeof pkg.main === 'string' ? pkg.main : typeof pkg.module === 'string' ? (pkg.module as string) : null,
    }
  } catch {
    return null
  }
}

// A real, single-pass filesystem walk -- computed fresh, not guessed from
// file extensions in a directory listing alone (config files and
// package.json contents are actually parsed).
export function buildProjectIndex(projectRoot: string): ProjectIndex {
  const languages: Record<string, number> = {}
  const configFiles: string[] = []
  const packages: PackageInfo[] = []
  let fileCount = 0
  let truncated = false

  function walk(dir: string, depth: number): void {
    if (fileCount >= MAX_FILES) {
      truncated = true
      return
    }
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (fileCount >= MAX_FILES) {
        truncated = true
        return
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.github')) continue
        walk(join(dir, entry.name), depth + 1)
        continue
      }
      const full = join(dir, entry.name)
      const rel = relative(projectRoot, full)
      fileCount++
      const lang = languageFor(entry.name)
      if (lang) languages[lang] = (languages[lang] ?? 0) + 1
      if (CONFIG_FILE_NAMES.has(entry.name)) configFiles.push(rel)
      if (entry.name === 'package.json' && depth <= MAX_PACKAGE_JSON_DEPTH) {
        const info = readPackageJson(full, relative(projectRoot, dir) || '.')
        if (info) packages.push(info)
      }
    }
  }

  walk(projectRoot, 0)

  let topLevelEntries: string[] = []
  try {
    topLevelEntries = readdirSync(projectRoot, { withFileTypes: true })
      .filter((e) => !IGNORED_DIRS.has(e.name))
      .map((e) => e.name + (e.isDirectory() ? '/' : ''))
      .sort()
  } catch {
    // projectRoot itself unreadable -- report what the walk above already found
  }

  return {
    projectRoot,
    computedAt: new Date().toISOString(),
    fileCount,
    truncated,
    languages,
    configFiles: configFiles.sort(),
    packages,
    topLevelEntries,
    git: {
      branch: safeGit(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
      latestCommit: safeGit(projectRoot, ['log', '-1', '--format=%h %s']),
      remoteUrl: safeGit(projectRoot, ['remote', 'get-url', 'origin']),
      isDirty: safeGitStatusIsDirty(projectRoot),
    },
  }
}

// A full walk is cheap for typical project sizes but still real disk I/O
// -- worth avoiding on every single tool call within one task. Cached
// in-memory per project root with a short TTL; forceRefresh bypasses it
// (e.g. right after the agent itself just wrote several files). Not
// persisted to disk: this is a hot-path performance cache, not a record
// -- correctness never depends on it surviving a process restart.
const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { index: ProjectIndex; expiresAt: number }>()

export function getProjectIndex(projectRoot: string, opts: { forceRefresh?: boolean } = {}): ProjectIndex {
  const cached = cache.get(projectRoot)
  if (!opts.forceRefresh && cached && cached.expiresAt > Date.now()) return cached.index

  const index = buildProjectIndex(projectRoot)
  cache.set(projectRoot, { index, expiresAt: Date.now() + CACHE_TTL_MS })
  return index
}
