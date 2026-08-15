import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { executeDeviceTool } from '@yahalla/agent-tools'
import { TOOLS, buildOpenAITools, getTool } from '../src/tools.js'
import { isToolAllowedForRole } from '../src/roles.js'

// Full tool-registry audit (audit Phase 5/7): for every real tool in the
// registry, not a sample -- schema shape, permission scope, role gating,
// and "is this tool actually reachable at runtime or just a name in an
// array." Iterates the real TOOLS export rather than a hand-maintained
// list of keys, so a future tool added to tools.ts without matching role/
// dispatch wiring fails this test automatically instead of silently
// shipping unusable or unintentionally-ungated.

test('every tool has a syntactically valid OpenAI function-calling schema', () => {
  for (const tool of TOOLS) {
    assert.equal(tool.parameters.type, 'object', `${tool.key}: parameters.type must be "object"`)
    assert.equal(tool.parameters.additionalProperties, false, `${tool.key}: additionalProperties must be false (no silent extra fields)`)
    const properties = tool.parameters.properties as Record<string, unknown> | undefined
    assert.ok(properties && typeof properties === 'object', `${tool.key}: properties must be an object`)
    const required = (tool.parameters.required as string[] | undefined) ?? []
    for (const req of required) {
      assert.ok(req in (properties as object), `${tool.key}: required field "${req}" is not declared in properties`)
    }
    assert.ok(tool.description.length > 10, `${tool.key}: description is too short to be useful to the model`)
  }
})

test('every tool key is unique -- no accidental duplicate registration', () => {
  const keys = TOOLS.map((t) => t.key)
  assert.equal(new Set(keys).size, keys.length)
})

test('buildOpenAITools() exposes exactly the real registry, one entry per tool, no extras and nothing missing', () => {
  const exposed = buildOpenAITools().map((t) => t.function.name).sort()
  const real = TOOLS.map((t) => t.key).sort()
  assert.deepEqual(exposed, real)
})

test('getTool resolves every real key and returns undefined for an unknown one', () => {
  for (const tool of TOOLS) {
    assert.equal(getTool(tool.key)?.key, tool.key)
  }
  assert.equal(getTool('not_a_real_tool'), undefined)
})

// "Registered but not actually usable": every files/system-category tool
// is dispatched through @yahalla/agent-tools' executeDeviceTool by key
// name (see agentLoop.ts's executeToolNow fallthrough) -- proves each one
// resolves to a real executor, not the registry's generic "No local
// executor registered for tool" fallback, which would silently mean a
// tool the model is told about can never actually run.
test('every files/system tool key has a real, reachable executor in @yahalla/agent-tools (not a dead registration)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yahalla-tool-registry-test-'))
  try {
    const deviceDispatchedTools = TOOLS.filter((t) => (t.category === 'files' || t.category === 'system') && t.key !== 'get_project_overview')
    assert.ok(deviceDispatchedTools.length > 0, 'sanity: there should be several files/system tools to check')
    for (const tool of deviceDispatchedTools) {
      const result = await executeDeviceTool(tool.key, dir, {}, { allowlist: ['npm test'] })
      assert.notEqual(
        result.error,
        `No local executor registered for tool "${tool.key}".`,
        `${tool.key}: is declared in tools.ts but has no executor registered in @yahalla/agent-tools -- a real dead tool`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Role-gating exhaustiveness: every single tool, not a hand-picked subset.
// The expected allowlist below is deliberately hardcoded to the small,
// genuinely-read-only set (mirrors roles.ts's own NORMAL_ROLE_ALLOWED_TOOL_KEYS,
// which is not exported) so this test independently catches a future tool
// added to TOOLS without a matching, deliberate role decision -- it defaults
// to "must be blocked for normal" unless explicitly added to this list.
const EXPECTED_NORMAL_ROLE_ALLOWED = new Set([
  'read_project_file',
  'list_project_files',
  'get_project_overview',
  'git_status',
  'git_diff',
  'github.read',
  'db_list_connections',
  'db_query',
])

test('role gating covers every real tool -- nothing new can slip through ungated', () => {
  for (const tool of TOOLS) {
    const expected = EXPECTED_NORMAL_ROLE_ALLOWED.has(tool.key)
    assert.equal(
      isToolAllowedForRole('normal', tool.key),
      expected,
      `${tool.key}: expected normal-role allowed=${expected}, got ${isToolAllowedForRole('normal', tool.key)}`,
    )
    // owner/trainer must always have access to every real tool -- the role
    // gate only ever restricts the "normal" tier.
    assert.equal(isToolAllowedForRole('owner', tool.key), true, `${tool.key}: owner must always be allowed`)
    assert.equal(isToolAllowedForRole('trainer', tool.key), true, `${tool.key}: trainer must always be allowed`)
  }
})

// Every write/mutating-shaped tool (permission.access === 'write' or
// 'execute') must be blocked for the normal role -- a structural check
// independent of the hardcoded key list above, catching the case where a
// new tool's *permission* correctly marks it as mutating but its *role*
// gating was forgotten.
test('every write/execute-permission tool is blocked for the normal role, by construction', () => {
  for (const tool of TOOLS) {
    if (tool.permission.access === 'write' || tool.permission.access === 'execute') {
      assert.equal(
        isToolAllowedForRole('normal', tool.key),
        false,
        `${tool.key}: requires "${tool.permission.access}" access but is allowed for the read-only "normal" role`,
      )
    }
  }
})

// requiresApproval consistency: today exactly github.write and db_execute
// are approval-gated (both real mutating actions against external
// systems this device does not fully control). This is not a law of
// nature, but a real, deliberate design decision from the audit's Phase 5 --
// this test makes a change to that set visible and intentional rather than
// silent.
test('requiresApproval is set on exactly the tools expected to need it', () => {
  const approvalGated = TOOLS.filter((t) => t.requiresApproval).map((t) => t.key).sort()
  assert.deepEqual(approvalGated, ['db_execute', 'github.write'])
})
