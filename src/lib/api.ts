import { supabase } from './supabase'
import type {
  Agent,
  Tool,
  Task,
  Server,
  Model,
  Permission,
  Profile,
  Conversation,
  ConversationMessage,
  Project,
  Approval,
  AuditLog,
  ChatResponse,
  Device,
  PairDeviceResponse,
} from './types'

const YAHALLA_AI_FUNCTION = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/yahalla-ai`

export async function getSession() {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  return data.session
}

export async function getProfile(): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', (await supabase.auth.getUser()).data.user?.id ?? '')
    .maybeSingle()
  if (error) throw error
  return data as Profile | null
}

export async function getAgents(): Promise<Agent[]> {
  const { data, error } = await supabase
    .from('agents')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as Agent[]
}

export async function getTools(): Promise<Tool[]> {
  const { data, error } = await supabase
    .from('tools')
    .select('*')
    .order('key', { ascending: true })
  if (error) throw error
  return (data ?? []) as Tool[]
}

export async function getTasks(limit = 50): Promise<Task[]> {
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as Task[]
}

export async function getServers(): Promise<Server[]> {
  const { data, error } = await supabase
    .from('servers')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as Server[]
}

export async function getModels(): Promise<Model[]> {
  const { data, error } = await supabase
    .from('models')
    .select('*')
    .order('priority', { ascending: false })
  if (error) throw error
  return (data ?? []) as Model[]
}

export async function getPermissions(): Promise<Permission[]> {
  const { data, error } = await supabase
    .from('permissions')
    .select('*')
    .order('key', { ascending: true })
  if (error) throw error
  return (data ?? []) as Permission[]
}

export async function getProfiles(): Promise<Profile[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as Profile[]
}

export async function getConversations(): Promise<Conversation[]> {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .order('updated_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as Conversation[]
}

export async function getConversationMessages(conversationId: string): Promise<ConversationMessage[]> {
  const { data, error } = await supabase
    .from('conversation_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as ConversationMessage[]
}

export async function getProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as Project[]
}

export async function getApprovals(): Promise<Approval[]> {
  const { data, error } = await supabase
    .from('approvals')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return (data ?? []) as Approval[]
}

export async function getAuditLogs(limit = 100): Promise<AuditLog[]> {
  const { data, error } = await supabase
    .from('audit_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as AuditLog[]
}

export async function sendChatMessage(params: {
  message: string
  conversation_id?: string
  project_id?: string
  agent_key?: string
  model_id?: string
}): Promise<ChatResponse> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) {
    throw new Error('No active authentication session.')
  }

  const response = await fetch(YAHALLA_AI_FUNCTION, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  })

  const result = await response.json()

  if (!response.ok) {
    throw new Error(result?.error || `Yahalla AI returned HTTP ${response.status}`)
  }

  return result as ChatResponse
}

export async function approveToolExecution(
  toolExecutionId: string,
  action: 'approve' | 'reject',
  decisionNote?: string,
): Promise<ChatResponse> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) {
    throw new Error('No active authentication session.')
  }

  const response = await fetch(YAHALLA_AI_FUNCTION, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      approval_action: action,
      tool_execution_id: toolExecutionId,
      decision_note: decisionNote,
    }),
  })

  const result = await response.json()

  if (!response.ok) {
    throw new Error(result?.error || `Approval failed with HTTP ${response.status}`)
  }

  return result as ChatResponse
}

export async function getDevices(): Promise<Device[]> {
  const { data, error } = await supabase
    .from('devices')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as Device[]
}

export async function pairDevice(deviceName?: string): Promise<PairDeviceResponse> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) {
    throw new Error('No active authentication session.')
  }

  const response = await fetch(YAHALLA_AI_FUNCTION, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ device_action: 'pair_device', device_name: deviceName }),
  })

  const result = await response.json()

  if (!response.ok) {
    throw new Error(result?.error || `Pairing failed with HTTP ${response.status}`)
  }

  return result as PairDeviceResponse
}

export async function revokeDevice(id: string): Promise<void> {
  const { error } = await supabase
    .from('devices')
    .update({ status: 'revoked', revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export async function updateServer(id: string, updates: Partial<Server>): Promise<void> {
  const { error } = await supabase
    .from('servers')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export async function createServer(server: Partial<Server>): Promise<Server> {
  const { data, error } = await supabase.from('servers').insert(server).select('*').single()
  if (error) throw error
  return data as Server
}

// "Connect this VPS" -- the self-hosted control plane (platform-api,
// fronted by Caddy at its own domain) exposes an unauthenticated /health
// endpoint for exactly this: a one-click reachability check from the admin
// panel, no terminal/SSH involved. baseUrl is stored in capabilities so
// later status refreshes (see refreshServerHealth) know where to ping.
export async function connectServer(baseUrl: string, name: string): Promise<Server> {
  const url = new URL(baseUrl)
  const health = await fetch(new URL('/health', url)).then((r) => r.json()).catch(() => null)
  const online = health?.status === 'ok'

  return createServer({
    name,
    type: 'remote',
    hostname: url.hostname,
    port: url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80),
    status: online ? 'online' : 'offline',
    capabilities: { self_hosted: true, base_url: url.origin },
    last_heartbeat: online ? new Date().toISOString() : null,
  })
}

export async function refreshServerHealth(server: Server): Promise<void> {
  const baseUrl = server.capabilities?.base_url
  if (typeof baseUrl !== 'string') return

  const health = await fetch(new URL('/health', baseUrl)).then((r) => r.json()).catch(() => null)
  const online = health?.status === 'ok'
  await updateServer(server.id, {
    status: online ? 'online' : 'offline',
    last_heartbeat: online ? new Date().toISOString() : server.last_heartbeat,
  })
}

export async function updateModel(id: string, updates: Partial<Model>): Promise<void> {
  const { error } = await supabase
    .from('models')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export async function createModel(model: Partial<Model>): Promise<void> {
  const { error } = await supabase.from('models').insert(model)
  if (error) throw error
}

export async function updateAgent(id: string, updates: Partial<Agent>): Promise<void> {
  const { error } = await supabase
    .from('agents')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export async function updateProfileRole(id: string, role: string): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .update({ role, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export async function createProject(name: string, description: string): Promise<Project> {
  const { data, error } = await supabase
    .from('projects')
    .insert({ name, description })
    .select('*')
    .single()
  if (error) throw error
  return data as Project
}

export async function updateConversationTitle(id: string, title: string): Promise<void> {
  const { error } = await supabase
    .from('conversations')
    .update({ title, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export async function deleteConversation(id: string): Promise<void> {
  const { error } = await supabase.from('conversations').delete().eq('id', id)
  if (error) throw error
}
