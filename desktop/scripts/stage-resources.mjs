#!/usr/bin/env node
// Assembles everything the packaged desktop app needs into desktop/resources/,
// in a layout Node's module resolution can actually walk at runtime -- this
// is the piece that's easy to get wrong: local-runtime's own real npm
// dependencies (pg, playwright-core, and whatever those pull in) live only
// in local-runtime/node_modules, and its "@yahalla/agent-tools" import
// resolves through a symlink npm created there (file:../packages/agent-tools
// in local-runtime/package.json) -- a packaged app is a separate directory
// tree with none of that, so both need to actually be copied in, not just
// the compiled dist/ output. This was verified missing by actually running
// a packaged-shaped Electron app (audit fix): it crash-looped on
// `Cannot find package 'pg'` even after dist/ was staged correctly, because
// this script previously copied dist/ and recreated only the
// @yahalla/agent-tools entry, never the rest of local-runtime's real
// dependencies.
//
// Pure file copying, no Electron/network involved -- safe to run and
// verify anywhere, including sandboxes that can't fetch Electron's binary.

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const desktopDir = join(__dirname, '..')
const resourcesDir = join(desktopDir, 'resources')

function requireBuilt(distPath, buildHint) {
  if (!existsSync(distPath)) {
    console.error(`[stage-resources] Missing build output: ${distPath}`)
    console.error(`[stage-resources] Run: ${buildHint}`)
    process.exit(1)
  }
}

const localRuntimeDist = join(repoRoot, 'local-runtime', 'dist')
const localRuntimeNodeModules = join(repoRoot, 'local-runtime', 'node_modules')
const agentToolsDist = join(repoRoot, 'packages', 'agent-tools', 'dist')
const frontendDist = join(repoRoot, 'dist')

requireBuilt(localRuntimeDist, '(cd local-runtime && npm run build)')
requireBuilt(localRuntimeNodeModules, '(cd local-runtime && npm install)')
requireBuilt(agentToolsDist, '(cd packages/agent-tools && npm run build)')
requireBuilt(frontendDist, 'npm run build')

rmSync(resourcesDir, { recursive: true, force: true })
mkdirSync(resourcesDir, { recursive: true })

// local-runtime: compiled output, its real npm dependencies (pg,
// playwright-core, ...), and @yahalla/agent-tools resolvable exactly where
// its compiled import statements expect to find it. node_modules is copied
// wholesale first (dereference: true so the @yahalla/agent-tools symlink
// npm created there becomes a real directory, not a dangling symlink to a
// path that won't exist in the packaged app), then the agent-tools entry is
// overwritten with a fresh copy of the just-built dist output, so staging
// never depends on local-runtime's node_modules symlink already being
// up to date with the latest agent-tools build.
const runtimeOut = join(resourcesDir, 'local-runtime')
mkdirSync(runtimeOut, { recursive: true })
cpSync(localRuntimeDist, join(runtimeOut, 'dist'), { recursive: true })
cpSync(join(repoRoot, 'local-runtime', 'package.json'), join(runtimeOut, 'package.json'))
cpSync(localRuntimeNodeModules, join(runtimeOut, 'node_modules'), { recursive: true, dereference: true })

const agentToolsOut = join(runtimeOut, 'node_modules', '@yahalla', 'agent-tools')
rmSync(agentToolsOut, { recursive: true, force: true })
mkdirSync(agentToolsOut, { recursive: true })
cpSync(agentToolsDist, join(agentToolsOut, 'dist'), { recursive: true })
cpSync(join(repoRoot, 'packages', 'agent-tools', 'package.json'), join(agentToolsOut, 'package.json'))

// The built Control Center frontend, loaded by the Electron window.
cpSync(frontendDist, join(resourcesDir, 'app-dist'), { recursive: true })

console.log(`[stage-resources] Staged local-runtime + agent-tools + frontend into ${resourcesDir}`)
