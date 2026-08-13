import type { Db } from './db.js'
import { getPreference, setPreference } from './memory.js'

// Real, code-enforced permission tiers -- not merely described in a
// system prompt. local-runtime has no login wall (whoever holds the
// per-device bearer token can talk to it at all), so "role" here is a
// single device-wide setting, checked fresh from the database before
// every tool execution, not something the model can be talked into
// ignoring by clever phrasing in chat.
//
// - normal: the safe default for a device someone else set up for you --
//   read-only project/git/GitHub/database access only. No writes, no
//   command execution, no browser automation, no self-development, no
//   sub-agent dispatch. Cannot change its own role.
// - owner: full capability on this device -- everything normal-role
//   allows, plus every write/execute/browser/self-dev/sub-agent tool this
//   runtime has. Can change the device's role.
// - trainer: same functional ceiling as owner today (both are "full
//   capability"), kept as a distinct, real, storable value rather than an
//   alias for owner so a genuinely separate remote-administrative-control
//   feature (an owner/trainer account on a platform-api deployment pushing
//   role/permission changes down to a specific paired device) has
//   somewhere real to plug in later without a schema change. That remote
//   push mechanism is NOT implemented in this pass -- stated plainly
//   rather than implied: today, trainer is only ever set locally, the
//   same as owner/normal.
export type DeviceRole = 'normal' | 'owner' | 'trainer'

const DEVICE_ROLE_PREFERENCE_KEY = 'device_role'

// A brand-new device (no role ever explicitly set) defaults to 'owner' --
// this is what preserves every existing single-user installation's
// current behavior exactly as it was before roles existed at all (the
// normal, personal-AI-on-your-own-laptop case this whole project is
// primarily built for). 'normal' is an explicit, deliberate downgrade an
// owner/trainer applies for a shared/managed/kiosk device, never a
// silent default that would break an existing setup.
const DEFAULT_ROLE: DeviceRole = 'owner'

export function getDeviceRole(db: Db): DeviceRole {
  return getPreference<DeviceRole>(db, DEVICE_ROLE_PREFERENCE_KEY) ?? DEFAULT_ROLE
}

export function setDeviceRole(db: Db, role: DeviceRole): void {
  setPreference(db, DEVICE_ROLE_PREFERENCE_KEY, role)
}

// Only an owner/trainer session can change this device's role -- a
// normal-role session can never promote itself, in code, regardless of
// what it asks for in chat or via this endpoint directly.
export function canChangeRole(currentRole: DeviceRole): boolean {
  return currentRole === 'owner' || currentRole === 'trainer'
}

// The exact, explicit allowlist of tools a 'normal' role may use --
// read-only project/git/GitHub/database inspection only. Everything else
// (file writes, command execution, git mutation, GitHub writes, database
// writes, browser automation, self-development, sub-agent dispatch) is
// owner/trainer-only, matching "project access, code modification,
// command execution, GitHub operations, browser automation, database
// operations, self-development, sub-agent capabilities" -- the exact list
// of capabilities the spec calls out as needing owner/trainer control.
const NORMAL_ROLE_ALLOWED_TOOL_KEYS = new Set([
  'read_project_file',
  'list_project_files',
  'get_project_overview',
  'git_status',
  'git_diff',
  'github.read',
  'db_list_connections',
  'db_query',
])

export function isToolAllowedForRole(role: DeviceRole, toolKey: string): boolean {
  if (role === 'owner' || role === 'trainer') return true
  return NORMAL_ROLE_ALLOWED_TOOL_KEYS.has(toolKey)
}

export function roleDeniedMessage(role: DeviceRole, toolKey: string): string {
  return `"${toolKey}" is not available to the "${role}" role on this device -- this capability is owner/trainer-only. An owner or trainer can enable it by changing this device's role.`
}
