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
}
