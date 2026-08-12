export type Role = 'owner' | 'admin' | 'developer' | 'operator' | 'user' | 'viewer'

export type Profile = {
  id: string
  email: string | null
  full_name: string | null
  role: Role
  created_at: string
  updated_at: string
}

export type AgentStatus = 'active' | 'paused' | 'disabled'

export type Agent = {
  id: string
  key: string
  name_ar: string
  name_de: string
  description: string | null
  status: AgentStatus
  role: string
  configuration: Record<string, unknown>
  model_id: string | null
  fallback_model_id: string | null
  server_id: string | null
  created_at: string
  updated_at: string
}

export type Tool = {
  id: string
  key: string
  name_ar: string
  name_de: string
  description: string | null
  category: string
  status: string
  requires_approval: boolean
  configuration: Record<string, unknown>
  created_at: string
}

export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_device'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type Task = {
  id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: string
  requested_by: string | null
  assigned_agent: string | null
  input: Record<string, unknown>
  output: Record<string, unknown>
  error: Record<string, unknown> | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
  parent_task_id: string | null
  retry_count: number
  current_step: string | null
  progress: number
  project_id: string | null
  conversation_id: string | null
  model_id: string | null
  assigned_device: string | null
  checkpoint: Record<string, unknown>
}

export type ServerType = 'local' | 'lan' | 'remote' | 'cloud'
export type ServerStatus = 'online' | 'degraded' | 'offline' | 'unknown'

export type Server = {
  id: string
  name: string
  type: ServerType
  hostname: string
  port: number
  status: ServerStatus
  runtime_version: string | null
  capabilities: Record<string, unknown>
  resource_usage: Record<string, unknown>
  last_heartbeat: string | null
  created_at: string
  updated_at: string
}

// A Device is a paired Device Agent process running on the owner's own
// Mac/Windows/Linux machine -- distinct from a Server (which hosts an LLM
// model over HTTP). Devices execute project filesystem/git/shell tools.
export type DevicePlatform = 'macos' | 'windows' | 'linux' | 'other'
export type DeviceStatus = 'online' | 'offline' | 'revoked'

export type Device = {
  id: string
  owner_id: string
  auth_user_id: string | null
  name: string
  platform: DevicePlatform
  status: DeviceStatus
  capabilities: Record<string, unknown>
  project_root: string | null
  last_heartbeat_at: string | null
  paired_at: string | null
  revoked_at: string | null
  created_at: string
  updated_at: string
}

export type PairDeviceResponse = {
  success: boolean
  pairing_code?: string
  expires_at?: string
  error?: string
}

export type ModelType = 'general' | 'coding' | 'reasoning' | 'vision' | 'speech' | 'embedding'
export type ModelStatus = 'online' | 'offline' | 'unknown' | 'degraded'

export type Model = {
  id: string
  server_id: string | null
  key: string
  name: string
  provider: string
  type: ModelType
  endpoint: string | null
  capabilities: Record<string, unknown>
  context_length: number
  vision_support: boolean
  tool_calling_support: boolean
  reasoning_support: boolean
  coding_capability: boolean
  embedding_capability: boolean
  speech_capability: boolean
  status: ModelStatus
  priority: number
  enabled: boolean
  is_local: boolean
  configuration: Record<string, unknown>
  last_checked: string | null
  created_at: string
  updated_at: string
}

export type Permission = {
  id: string
  key: string
  name_ar: string
  name_de: string
  description: string | null
}

export type Conversation = {
  id: string
  project_id: string | null
  owner_id: string
  title: string
  assigned_agent_id: string | null
  model_id: string | null
  status: string
  created_at: string
  updated_at: string
}

export type ConversationMessage = {
  id: string
  conversation_id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  agent_id: string | null
  model_id: string | null
  task_id: string | null
  tool_activity: Record<string, unknown>[]
  metadata: Record<string, unknown>
  created_at: string
}

export type Project = {
  id: string
  name: string
  description: string | null
  owner_id: string | null
  status: string
  configuration: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type Approval = {
  id: string
  tool_execution_id: string | null
  task_id: string | null
  requested_by: string | null
  decided_by: string | null
  status: string
  reason: string | null
  decision_note: string | null
  created_at: string
  decided_at: string | null
}

export type DeploymentProposal = {
  id: string
  title: string
  description: string | null
  git_ref: string
  base_ref: string
  diff: string
  status: string
  proposed_by: string | null
  proposed_by_agent: string | null
  decided_by: string | null
  decided_at: string | null
  deployed_at: string | null
  deploy_log: string | null
  created_at: string
  updated_at: string
}

export type AuditLog = {
  id: string
  actor_user_id: string | null
  agent_id: string | null
  task_id: string | null
  action: string
  resource_type: string | null
  resource_id: string | null
  details: Record<string, unknown>
  ip_address: string | null
  user_agent: string | null
  created_at: string
}

export type ChatResponse = {
  success: boolean
  task_id?: string
  conversation_id?: string
  status?: string
  answer?: string
  error?: string
  agent?: {
    id: string
    key: string
    name_ar: string
    name_de: string
    status: string
    role?: string
  }
  model?: {
    id: string
    key: string
    name: string
    type: string
  }
  permissions?: string[]
  device_dispatch?: boolean
  device_name?: string
  tools?: { key: string; category: string; requires_approval: boolean }[]
  executed_tools?: {
    tool: string
    execution_id: string
    arguments: Record<string, unknown>
    result: Record<string, unknown>
  }[]
  memory_count?: number
  approval_required?: boolean
  tool_execution_id?: string
  approval_tool?: string
}
