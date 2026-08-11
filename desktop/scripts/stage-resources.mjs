#!/usr/bin/env node
// Assembles everything the packaged desktop app needs into desktop/resources/,
// in a layout Node's module resolution can actually walk at runtime -- this
// is the piece that's easy to get wrong: in the dev/npm-workspaces layout,
// local-runtime's "@yahalla/agent-tools" import resolves through a symlink
// npm created (local-runtime/node_modules/@yahalla/agent-tools -> ../../
// packages/agent-tools). A packaged app has no npm workspace, so that
// symlink doesn't exist -- this script recreates the same shape with real
// copies instead, so the exact same import statement in the compiled JS
// keeps resolving correctly whether running from the monorepo or from
// inside a shipped .app/.exe/.AppImage.
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
const agentToolsDist = join(repoRoot, 'packages', 'agent-tools', 'dist')
const frontendDist = join(repoRoot, 'dist')

requireBuilt(localRuntimeDist, '(cd local-runtime && npm run build)')
requireBuilt(agentToolsDist, '(cd packages/agent-tools && npm run build)')
requireBuilt(frontendDist, 'npm run build')

rmSync(resourcesDir, { recursive: true, force: true })
mkdirSync(resourcesDir, { recursive: true })

// local-runtime, with @yahalla/agent-tools resolvable exactly where its
// compiled import statements expect to find it.
const runtimeOut = join(resourcesDir, 'local-runtime')
mkdirSync(runtimeOut, { recursive: true })
cpSync(localRuntimeDist, join(runtimeOut, 'dist'), { recursive: true })
cpSync(join(repoRoot, 'local-runtime', 'package.json'), join(runtimeOut, 'package.json'))

const agentToolsOut = join(runtimeOut, 'node_modules', '@yahalla', 'agent-tools')
mkdirSync(agentToolsOut, { recursive: true })
cpSync(agentToolsDist, join(agentToolsOut, 'dist'), { recursive: true })
cpSync(join(repoRoot, 'packages', 'agent-tools', 'package.json'), join(agentToolsOut, 'package.json'))

// The built Control Center frontend, loaded by the Electron window.
cpSync(frontendDist, join(resourcesDir, 'app-dist'), { recursive: true })

console.log(`[stage-resources] Staged local-runtime + agent-tools + frontend into ${resourcesDir}`)
