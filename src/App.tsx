import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Activity, Bot, Check, ChevronRight, Circle as CircleHelp, Cpu, FileText, FolderKanban, LogOut, Menu, MessageSquare, Monitor, Paperclip, Plus, Search, Send, Server, Settings, Shield, ShieldCheck, Sparkles, Terminal, Users, Wrench, X, Zap } from 'lucide-react'
import './App.css'
import { supabase } from './lib/supabase'
import { signIn, signOut, signUp } from './lib/auth'
import * as api from './lib/api'
import type {
  Agent,
  Approval,
  AuditLog,
  ChatResponse,
  Model,
  Permission,
  Profile,
  Project,
  Server as ServerType,
  Task,
  Tool,
} from './lib/types'

type Page =
  | 'Chat'
  | 'Overview'
  | 'Projects'
  | 'Tasks'
  | 'Agents'
  | 'Tools'
  | 'Models'
  | 'Servers'
  | 'Approvals'
  | 'Permissions'
  | 'Users'
  | 'Logs'
  | 'Health'
  | 'Settings'

// =============================================================
// Login
// =============================================================

function Login() {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError('')

    const { error } = mode === 'login'
      ? await signIn(email, password)
      : await signUp(email, password)

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    if (mode === 'signup') {
      setError('Account created. You can now sign in.')
      setMode('login')
      setLoading(false)
      return
    }

    window.location.reload()
  }

  return (
    <main className="login-shell">
      <div className="login-glow glow-one" />
      <div className="login-glow glow-two" />

      <div className="login-card">
        <div className="brand-mark">
          <Sparkles size={20} />
        </div>

        <div className="eyebrow">YAHALLA ARTIFICIAL INTELLIGENCE</div>

        <h1>{mode === 'login' ? 'Welcome back' : 'Create account'}</h1>

        <p>
          {mode === 'login'
            ? 'Anmeldung beim Yahalla AI Control Center'
            : 'Neues Konto für Yahalla AI erstellen'}
        </p>

        <form onSubmit={handleSubmit}>
          <label>E-Mail</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="name@example.com"
          />

          <label>Passwort</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            placeholder="••••••••"
          />

          {error && <div className="error-box">{error}</div>}

          <button className="primary-button login-button" disabled={loading}>
            {loading
              ? 'Bitte warten…'
              : mode === 'login'
                ? 'Anmelden'
                : 'Konto erstellen'}
          </button>
        </form>

        <button
          className="login-toggle"
          onClick={() => {
            setMode(mode === 'login' ? 'signup' : 'login')
            setError('')
          }}
        >
          {mode === 'login'
            ? 'No account? Sign up'
            : 'Already have an account? Sign in'}
        </button>

        <div className="login-footer">
          <span>العربية</span>
          <span>•</span>
          <span>Deutsch</span>
        </div>
      </div>
    </main>
  )
}

// =============================================================
// Status badge
// =============================================================

function StatusBadge({ status }: { status: string }) {
  const colorClass =
    status === 'online' || status === 'active' || status === 'completed' || status === 'approved'
      ? 'badge-success'
      : status === 'running' || status === 'pending' || status === 'queued'
        ? 'badge-running'
        : status === 'waiting_approval'
          ? 'badge-warning'
          : status === 'offline' || status === 'failed' || status === 'rejected' || status === 'disabled'
            ? 'badge-error'
            : 'badge-unknown'

  return <span className={`status-badge ${colorClass}`}>{status}</span>
}

// =============================================================
// Admin sections
// =============================================================

function OverviewSection({ profile }: { profile: Profile }) {
  const [stats, setStats] = useState({
    agents: 0,
    tools: 0,
    tasks: 0,
    models: 0,
    servers: 0,
    pendingApprovals: 0,
  })

  useEffect(() => {
    async function load() {
      try {
        const [agents, tools, tasks, models, servers, approvals] = await Promise.all([
          api.getAgents(),
          api.getTools(),
          api.getTasks(200),
          api.getModels(),
          api.getServers(),
          api.getApprovals(),
        ])
        setStats({
          agents: agents.length,
          tools: tools.length,
          tasks: tasks.filter((t) => t.status === 'running' || t.status === 'pending' || t.status === 'queued').length,
          models: models.length,
          servers: servers.length,
          pendingApprovals: approvals.filter((a) => a.status === 'pending').length,
        })
      } catch {
        // ignore
      }
    }
    load()
  }, [])

  const cards = [
    { label: 'Agents', value: stats.agents, icon: Bot, color: '#a5b4fc' },
    { label: 'Tools', value: stats.tools, icon: Wrench, color: '#67e8f9' },
    { label: 'Active Tasks', value: stats.tasks, icon: FileText, color: '#fcd34d' },
    { label: 'Models', value: stats.models, icon: Cpu, color: '#86efac' },
    { label: 'Servers', value: stats.servers, icon: Server, color: '#f9a8d4' },
    { label: 'Pending Approvals', value: stats.pendingApprovals, icon: ShieldCheck, color: '#fca5a5' },
  ]

  return (
    <div className="admin-section">
      <div className="section-header">
        <h2>Overview</h2>
        <p>Platform status at a glance</p>
      </div>

      <div className="stats-grid">
        {cards.map((card) => {
          const Icon = card.icon
          return (
            <div key={card.label} className="stat-card">
              <div className="stat-icon" style={{ color: card.color }}>
                <Icon size={22} />
              </div>
              <div className="stat-value">{card.value}</div>
              <div className="stat-label">{card.label}</div>
            </div>
          )
        })}
      </div>

      <div className="info-panel">
        <div className="info-panel-header">
          <Users size={18} />
          <span>Your Account</span>
        </div>
        <div className="info-panel-body">
          <div className="info-row">
            <span className="info-label">Email</span>
            <span className="info-value">{profile.email}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Role</span>
            <span className="info-value role-badge">{profile.role}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Name</span>
            <span className="info-value">{profile.full_name || '—'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function AgentsSection() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getAgents().then(setAgents).finally(() => setLoading(false))
  }, [])

  async function toggleStatus(agent: Agent) {
    const newStatus = agent.status === 'active' ? 'paused' : 'active'
    await api.updateAgent(agent.id, { status: newStatus })
    setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, status: newStatus } : a)))
  }

  if (loading) return <div className="loading-text">Loading agents…</div>

  return (
    <div className="admin-section">
      <div className="section-header">
        <h2>Agents</h2>
        <p>{agents.length} agents registered</p>
      </div>
      <div className="card-grid">
        {agents.map((agent) => (
          <div key={agent.id} className="data-card">
            <div className="data-card-header">
              <div className="data-card-icon">
                <Bot size={18} />
              </div>
              <div className="data-card-title">
                <div className="data-card-name">{agent.name_de}</div>
                <div className="data-card-sub">{agent.key} · {agent.role}</div>
              </div>
              <StatusBadge status={agent.status} />
            </div>
            <p className="data-card-desc">{agent.description || 'No description'}</p>
            <div className="data-card-actions">
              <button
                className="mini-button"
                onClick={() => toggleStatus(agent)}
              >
                {agent.status === 'active' ? 'Pause' : 'Activate'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ToolsSection() {
  const [tools, setTools] = useState<Tool[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getTools().then(setTools).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="loading-text">Loading tools…</div>

  return (
    <div className="admin-section">
      <div className="section-header">
        <h2>Tools</h2>
        <p>{tools.length} tools registered</p>
      </div>
      <div className="card-grid">
        {tools.map((tool) => (
          <div key={tool.id} className="data-card">
            <div className="data-card-header">
              <div className="data-card-icon">
                <Wrench size={18} />
              </div>
              <div className="data-card-title">
                <div className="data-card-name">{tool.name_de}</div>
                <div className="data-card-sub">{tool.key} · {tool.category}</div>
              </div>
              <StatusBadge status={tool.status} />
            </div>
            <p className="data-card-desc">{tool.description || 'No description'}</p>
            {tool.requires_approval && (
              <div className="approval-tag">
                <ShieldCheck size={12} />
                Requires approval
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function ModelsSection() {
  const [models, setModels] = useState<Model[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getModels().then(setModels).finally(() => setLoading(false))
  }, [])

  async function toggleEnabled(model: Model) {
    await api.updateModel(model.id, { enabled: !model.enabled })
    setModels((prev) => prev.map((m) => (m.id === model.id ? { ...m, enabled: !m.enabled } : m)))
  }

  if (loading) return <div className="loading-text">Loading models…</div>

  return (
    <div className="admin-section">
      <div className="section-header">
        <h2>Models</h2>
        <p>{models.length} models registered</p>
      </div>
      <div className="card-grid">
        {models.map((model) => (
          <div key={model.id} className="data-card">
            <div className="data-card-header">
              <div className="data-card-icon">
                <Cpu size={18} />
              </div>
              <div className="data-card-title">
                <div className="data-card-name">{model.name}</div>
                <div className="data-card-sub">{model.key} · {model.type}</div>
              </div>
              <StatusBadge status={model.status} />
            </div>
            <div className="model-features">
              {model.tool_calling_support && <span className="feature-chip">Tools</span>}
              {model.reasoning_support && <span className="feature-chip">Reasoning</span>}
              {model.coding_capability && <span className="feature-chip">Coding</span>}
              {model.vision_support && <span className="feature-chip">Vision</span>}
              {model.embedding_capability && <span className="feature-chip">Embedding</span>}
            </div>
            <div className="data-card-sub" style={{ marginTop: '8px' }}>
              {model.is_local ? 'Local' : 'Remote'} · Priority {model.priority} · {model.context_length} ctx
            </div>
            <div className="data-card-actions">
              <button className="mini-button" onClick={() => toggleEnabled(model)}>
                {model.enabled ? 'Disable' : 'Enable'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ServersSection() {
  const [servers, setServers] = useState<ServerType[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getServers().then(setServers).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="loading-text">Loading servers…</div>

  return (
    <div className="admin-section">
      <div className="section-header">
        <h2>Servers</h2>
        <p>{servers.length} execution nodes registered</p>
      </div>
      <div className="card-grid">
        {servers.map((server) => (
          <div key={server.id} className="data-card">
            <div className="data-card-header">
              <div className="data-card-icon">
                <Server size={18} />
              </div>
              <div className="data-card-title">
                <div className="data-card-name">{server.name}</div>
                <div className="data-card-sub">{server.hostname}:{server.port} · {server.type}</div>
              </div>
              <StatusBadge status={server.status} />
            </div>
            <div className="info-row">
              <span className="info-label">Runtime</span>
              <span className="info-value">{server.runtime_version || '—'}</span>
            </div>
            <div className="info-row">
              <span className="info-label">Heartbeat</span>
              <span className="info-value">
                {server.last_heartbeat
                  ? new Date(server.last_heartbeat).toLocaleString()
                  : 'Never'}
              </span>
            </div>
            <div className="info-row">
              <span className="info-label">Capabilities</span>
              <span className="info-value">
                {Object.keys(server.capabilities || {}).join(', ') || '—'}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function TasksSection() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getTasks(100).then(setTasks).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="loading-text">Loading tasks…</div>

  return (
    <div className="admin-section">
      <div className="section-header">
        <h2>Tasks</h2>
        <p>{tasks.length} tasks</p>
      </div>
      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Progress</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id}>
                <td className="cell-title">{task.title}</td>
                <td><StatusBadge status={task.status} /></td>
                <td>{task.priority}</td>
                <td>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${task.progress}%` }} />
                  </div>
                </td>
                <td className="cell-time">{new Date(task.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ApprovalsSection() {
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [loading, setLoading] = useState(true)
  const [processing, setProcessing] = useState<string | null>(null)

  useEffect(() => {
    api.getApprovals().then(setApprovals).finally(() => setLoading(false))
  }, [])

  async function handleAction(approval: Approval, action: 'approve' | 'reject') {
    setProcessing(approval.id)
    try {
      await api.approveToolExecution(approval.tool_execution_id!, action)
      setApprovals((prev) =>
        prev.map((a) =>
          a.id === approval.id ? { ...a, status: action === 'approve' ? 'approved' : 'rejected' } : a,
        ),
      )
    } catch (err) {
      console.error(err)
    } finally {
      setProcessing(null)
    }
  }

  if (loading) return <div className="loading-text">Loading approvals…</div>

  return (
    <div className="admin-section">
      <div className="section-header">
        <h2>Approvals</h2>
        <p>{approvals.filter((a) => a.status === 'pending').length} pending</p>
      </div>
      <div className="card-grid">
        {approvals.map((approval) => (
          <div key={approval.id} className="data-card">
            <div className="data-card-header">
              <div className="data-card-icon">
                <ShieldCheck size={18} />
              </div>
              <div className="data-card-title">
                <div className="data-card-name">Approval Request</div>
                <div className="data-card-sub">
                  {new Date(approval.created_at).toLocaleString()}
                </div>
              </div>
              <StatusBadge status={approval.status} />
            </div>
            <p className="data-card-desc">{approval.reason || 'No reason provided'}</p>
            {approval.status === 'pending' && (
              <div className="data-card-actions">
                <button
                  className="mini-button approve"
                  disabled={processing === approval.id}
                  onClick={() => handleAction(approval, 'approve')}
                >
                  <Check size={14} /> Approve
                </button>
                <button
                  className="mini-button reject"
                  disabled={processing === approval.id}
                  onClick={() => handleAction(approval, 'reject')}
                >
                  <X size={14} /> Reject
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function PermissionsSection() {
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getPermissions().then(setPermissions).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="loading-text">Loading permissions…</div>

  return (
    <div className="admin-section">
      <div className="section-header">
        <h2>Permissions</h2>
        <p>{permissions.length} permissions defined</p>
      </div>
      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Name (AR)</th>
              <th>Name (DE)</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {permissions.map((perm) => (
              <tr key={perm.id}>
                <td className="cell-mono">{perm.key}</td>
                <td>{perm.name_ar}</td>
                <td>{perm.name_de}</td>
                <td>{perm.description || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function UsersSection({ profile }: { profile: Profile }) {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getProfiles().then(setProfiles).finally(() => setLoading(false))
  }, [])

  async function changeRole(p: Profile, role: string) {
    await api.updateProfileRole(p.id, role)
    setProfiles((prev) => prev.map((x) => (x.id === p.id ? { ...x, role } as Profile : x)))
  }

  if (loading) return <div className="loading-text">Loading users…</div>

  return (
    <div className="admin-section">
      <div className="section-header">
        <h2>Users</h2>
        <p>{profiles.length} users</p>
      </div>
      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Role</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.id}>
                <td>{p.email || '—'}</td>
                <td>{p.full_name || '—'}</td>
                <td>
                  {p.id === profile.id ? (
                    <span className="role-badge">{p.role}</span>
                  ) : (
                    <select
                      className="role-select"
                      value={p.role}
                      onChange={(e) => changeRole(p, e.target.value)}
                    >
                      <option value="owner">owner</option>
                      <option value="admin">admin</option>
                      <option value="developer">developer</option>
                      <option value="operator">operator</option>
                      <option value="user">user</option>
                      <option value="viewer">viewer</option>
                    </select>
                  )}
                </td>
                <td className="cell-time">{new Date(p.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function LogsSection() {
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getAuditLogs(100).then(setLogs).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="loading-text">Loading logs…</div>

  return (
    <div className="admin-section">
      <div className="section-header">
        <h2>Audit Logs</h2>
        <p>{logs.length} recent entries</p>
      </div>
      <div className="log-list">
        {logs.map((log) => (
          <div key={log.id} className="log-entry">
            <div className="log-time">{new Date(log.created_at).toLocaleString()}</div>
            <div className="log-action">{log.action}</div>
            <div className="log-details">
              {log.resource_type || '—'} · {log.resource_id?.slice(0, 8) || '—'}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function HealthSection() {
  const [servers, setServers] = useState<ServerType[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([api.getServers(), api.getModels()])
      .then(([s, m]) => {
        setServers(s)
        setModels(m)
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="loading-text">Loading health data…</div>

  return (
    <div className="admin-section">
      <div className="section-header">
        <h2>Health</h2>
        <p>Runtime and infrastructure health</p>
      </div>

      <div className="health-group">
        <h3>Servers</h3>
        {servers.map((server) => (
          <div key={server.id} className="health-row">
            <Monitor size={16} />
            <span className="health-label">{server.name}</span>
            <span className="health-host">{server.hostname}:{server.port}</span>
            <StatusBadge status={server.status} />
          </div>
        ))}
      </div>

      <div className="health-group">
        <h3>Models</h3>
        {models.map((model) => (
          <div key={model.id} className="health-row">
            <Cpu size={16} />
            <span className="health-label">{model.name}</span>
            <span className="health-host">{model.type}</span>
            <StatusBadge status={model.status} />
          </div>
        ))}
      </div>
    </div>
  )
}

function SettingsSection() {
  return (
    <div className="admin-section">
      <div className="section-header">
        <h2>Settings</h2>
        <p>Platform configuration</p>
      </div>
      <div className="info-panel">
        <div className="info-panel-header">
          <Settings size={18} />
          <span>System Configuration</span>
        </div>
        <div className="info-panel-body">
          <div className="info-row">
            <span className="info-label">Platform</span>
            <span className="info-value">Yahalla AI OS</span>
          </div>
          <div className="info-row">
            <span className="info-label">Version</span>
            <span className="info-value">0.1.0</span>
          </div>
          <div className="info-row">
            <span className="info-label">Runtime</span>
            <span className="info-value">Supabase Edge Functions</span>
          </div>
          <div className="info-row">
            <span className="info-label">Database</span>
            <span className="info-value">PostgreSQL (Supabase)</span>
          </div>
          <div className="info-row">
            <span className="info-label">Authentication</span>
            <span className="info-value">Supabase Auth (Email/Password)</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function ProjectsSection() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')

  useEffect(() => {
    api.getProjects().then(setProjects).finally(() => setLoading(false))
  }, [])

  async function handleCreate() {
    if (!newName.trim()) return
    const project = await api.createProject(newName, newDesc)
    setProjects((prev) => [project, ...prev])
    setNewName('')
    setNewDesc('')
    setShowCreate(false)
  }

  if (loading) return <div className="loading-text">Loading projects…</div>

  return (
    <div className="admin-section">
      <div className="section-header">
        <h2>Projects</h2>
        <button className="mini-button" onClick={() => setShowCreate(!showCreate)}>
          <Plus size={14} /> New Project
        </button>
      </div>

      {showCreate && (
        <div className="create-form">
          <input
            type="text"
            placeholder="Project name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            type="text"
            placeholder="Description (optional)"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
          />
          <button className="primary-button" onClick={handleCreate}>Create</button>
        </div>
      )}

      <div className="card-grid">
        {projects.map((project) => (
          <div key={project.id} className="data-card">
            <div className="data-card-header">
              <div className="data-card-icon">
                <FolderKanban size={18} />
              </div>
              <div className="data-card-title">
                <div className="data-card-name">{project.name}</div>
                <div className="data-card-sub">{project.status}</div>
              </div>
              <StatusBadge status={project.status} />
            </div>
            <p className="data-card-desc">{project.description || 'No description'}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// =============================================================
// Chat
// =============================================================

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: Date
  taskId?: string
  agent?: string
  toolActivity?: { tool: string; result: Record<string, unknown> }[]
  error?: boolean
}

function ChatSection() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content:
        'مرحباً بك في Yahalla AI Core. أنا جاهز لاستقبال الأوامر والمهام الخاصة بمنظومة Yahalla.',
      createdAt: new Date(),
      agent: 'yahalla-core',
    },
  ])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [selectedAgent, setSelectedAgent] = useState('yahalla-core')
  const [selectedModel, setSelectedModel] = useState('')
  const [showTechnical, setShowTechnical] = useState(false)
  const [lastResult, setLastResult] = useState<ChatResponse | null>(null)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.getAgents().then((a) => setAgents(a.filter((x) => x.status === 'active')))
    api.getModels().then((m) => setModels(m.filter((x) => x.enabled)))
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault()
    const message = input.trim()
    if (!message || sending) return

    setInput('')
    setError('')

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: message,
      createdAt: new Date(),
    }

    setMessages((prev) => [...prev, userMessage])
    setSending(true)

    try {
      const result = await api.sendChatMessage({
        message,
        conversation_id: conversationId ?? undefined,
        agent_key: selectedAgent,
        model_id: selectedModel || undefined,
      })

      setLastResult(result)

      if (result.conversation_id) {
        setConversationId(result.conversation_id)
      }

      const assistantContent =
        result.answer ||
        result.error ||
        'Yahalla AI Core did not return an answer.'

      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: assistantContent,
        createdAt: new Date(),
        taskId: result.task_id,
        agent: result.agent?.key,
        toolActivity: result.executed_tools as { tool: string; result: Record<string, unknown> }[],
        error: !result.success,
      }

      setMessages((prev) => [...prev, assistantMessage])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      setError(msg)
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `حدث خطأ أثناء تنفيذ الطلب: ${msg}`,
          createdAt: new Date(),
          error: true,
        },
      ])
    } finally {
      setSending(false)
      setTimeout(() => textareaRef.current?.focus(), 50)
    }
  }

  function newChat() {
    setMessages([
      {
        id: 'welcome-' + Date.now(),
        role: 'assistant',
        content: 'محادثة جديدة جاهزة. ماذا تريد من Yahalla AI أن يفعل؟',
        createdAt: new Date(),
        agent: 'yahalla-core',
      },
    ])
    setConversationId(null)
    setLastResult(null)
    setError('')
    setInput('')
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      sendMessage()
    }
  }

  return (
    <div className="chat-page">
      <div className="chat-header">
        <div className="chat-agent">
          <div className="agent-avatar">
            <Cpu size={20} />
            <span className="agent-live" />
          </div>
          <div>
            <div className="chat-agent-name">Yahalla Core</div>
            <div className="chat-agent-status">
              <span />
              AI Orchestrator · Online
            </div>
          </div>
        </div>

        <div className="chat-controls">
          <select
            className="chat-select"
            value={selectedAgent}
            onChange={(e) => setSelectedAgent(e.target.value)}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.key}>{a.name_de}</option>
            ))}
          </select>

          <select
            className="chat-select"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
          >
            <option value="">Auto-route</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>

          <button className="secondary-button" onClick={newChat}>
            <Plus size={16} /> New
          </button>

          <button
            className="icon-button"
            onClick={() => setShowTechnical((v) => !v)}
            title="Technical info"
          >
            <Terminal size={17} />
          </button>
        </div>
      </div>

      <div className="chat-body">
        <div className="conversation">
          <div className="conversation-intro">
            <div className="intro-orb">
              <Sparkles size={27} />
            </div>
            <div className="eyebrow">YAHALLA AI CORE</div>
            <h1>
              What can I build<br />
              <span>for Yahalla?</span>
            </h1>
            <p>Describe a task, ask a question, or give the Core an instruction.</p>
            <div className="suggestion-grid">
              {[
                'Analysiere mein aktuelles System',
                'Zeige mir offene Aufgaben',
                'Prüfe die Yahalla Architektur',
                'Was soll ich als Nächstes bauen?',
              ].map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setInput(s)
                    textareaRef.current?.focus()
                  }}
                  className="suggestion-card"
                >
                  <span>{s}</span>
                  <ChevronRight size={15} />
                </button>
              ))}
            </div>
          </div>

          <div className="message-list">
            {messages.map((message) => (
              <div key={message.id} className={`message-row ${message.role}`}>
                {message.role === 'assistant' && (
                  <div className="message-avatar">
                    <Sparkles size={16} />
                  </div>
                )}
                <div className="message-content">
                  <div className="message-meta">
                    {message.role === 'user' ? 'You' : 'Yahalla Core'}
                    <span>
                      {message.createdAt.toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <div className={`message-bubble ${message.error ? 'message-error' : ''}`}>
                    {message.content}
                  </div>
                  {message.taskId && (
                    <div className="task-chip">
                      <Zap size={12} />
                      Task {message.taskId.slice(0, 8)}
                    </div>
                  )}
                  {message.toolActivity && message.toolActivity.length > 0 && (
                    <div className="tool-activity">
                      {message.toolActivity.map((ta, i) => (
                        <div key={i} className="tool-activity-item">
                          <Wrench size={11} />
                          {ta.tool}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {sending && (
              <div className="message-row assistant">
                <div className="message-avatar">
                  <Sparkles size={16} />
                </div>
                <div className="message-content">
                  <div className="message-meta">
                    Yahalla Core <span>processing</span>
                  </div>
                  <div className="message-bubble typing">
                    <span />
                    <span />
                    <span />
                    <em>Processing request…</em>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="composer-area">
          {error && <div className="composer-error">{error}</div>}

          {showTechnical && lastResult && (
            <details open className="technical-panel">
              <summary>
                <Terminal size={14} />
                Technical response
              </summary>
              <pre>{JSON.stringify(lastResult, null, 2)}</pre>
            </details>
          )}

          <form className="composer" onSubmit={sendMessage}>
            <button type="button" className="composer-icon">
              <Paperclip size={18} />
            </button>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message Yahalla Core…"
              rows={1}
            />
            <div className="composer-bottom">
              <div className="composer-hint">
                <span>Enter to send</span>
                <span>•</span>
                <span>Shift + Enter for new line</span>
              </div>
              <button
                type="submit"
                className="send-button"
                disabled={sending || !input.trim()}
              >
                <Send size={17} />
              </button>
            </div>
          </form>

          <div className="composer-disclaimer">
            Yahalla AI may make mistakes. Review important actions before execution.
          </div>
        </div>
      </div>
    </div>
  )
}

// =============================================================
// Navigation config
// =============================================================

type NavItem = { label: Page; icon: typeof MessageSquare; adminOnly?: boolean }

const userNav: NavItem[] = [
  { label: 'Chat', icon: MessageSquare },
  { label: 'Projects', icon: FolderKanban },
  { label: 'Tasks', icon: FileText },
]

const adminNav: NavItem[] = [
  { label: 'Overview', icon: Activity, adminOnly: true },
  { label: 'Agents', icon: Bot, adminOnly: true },
  { label: 'Tools', icon: Wrench, adminOnly: true },
  { label: 'Models', icon: Cpu, adminOnly: true },
  { label: 'Servers', icon: Server, adminOnly: true },
  { label: 'Approvals', icon: ShieldCheck, adminOnly: true },
  { label: 'Permissions', icon: Shield, adminOnly: true },
  { label: 'Users', icon: Users, adminOnly: true },
  { label: 'Logs', icon: Activity, adminOnly: true },
  { label: 'Health', icon: Monitor, adminOnly: true },
  { label: 'Settings', icon: Settings, adminOnly: true },
]

// =============================================================
// Main control center
// =============================================================

function ControlCenter({
  profile,
  onLogout,
}: {
  profile: Profile
  onLogout: () => void
}) {
  const [active, setActive] = useState<Page>('Chat')
  const [mobileOpen, setMobileOpen] = useState(false)

  const isAdminUser = profile.role === 'owner' || profile.role === 'admin'
  const navItems = isAdminUser ? [...userNav, ...adminNav] : userNav

  function renderPage() {
    switch (active) {
      case 'Chat':
        return <ChatSection />
      case 'Overview':
        return <OverviewSection profile={profile} />
      case 'Projects':
        return <ProjectsSection />
      case 'Tasks':
        return <TasksSection />
      case 'Agents':
        return <AgentsSection />
      case 'Tools':
        return <ToolsSection />
      case 'Models':
        return <ModelsSection />
      case 'Servers':
        return <ServersSection />
      case 'Approvals':
        return <ApprovalsSection />
      case 'Permissions':
        return <PermissionsSection />
      case 'Users':
        return <UsersSection profile={profile} />
      case 'Logs':
        return <LogsSection />
      case 'Health':
        return <HealthSection />
      case 'Settings':
        return <SettingsSection />
      default:
        return <ChatSection />
    }
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? 'mobile-visible' : ''}`}>
        <div className="sidebar-brand">
          <div className="brand-symbol">
            <Sparkles size={18} />
          </div>
          <div>
            <div className="brand-title">Yahalla AI</div>
            <div className="brand-subtitle">Intelligence OS</div>
          </div>
          <button className="mobile-close" onClick={() => setMobileOpen(false)}>
            <X size={18} />
          </button>
        </div>

        <button className="new-chat-button" onClick={() => { setActive('Chat'); setMobileOpen(false) }}>
          <Plus size={17} />
          <span>New conversation</span>
        </button>

        <div className="nav-label">{isAdminUser ? 'CONTROL CENTER' : 'WORKSPACE'}</div>

        <nav className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon
            const selected = active === item.label
            return (
              <button
                key={item.label}
                onClick={() => {
                  setActive(item.label)
                  setMobileOpen(false)
                }}
                className={`nav-item ${selected ? 'active' : ''}`}
              >
                <Icon size={17} />
                <span>{item.label}</span>
                {selected && <ChevronRight size={15} className="nav-arrow" />}
              </button>
            )
          })}
        </nav>

        <div className="sidebar-spacer" />

        <div className="core-status">
          <div className="status-dot" />
          <div>
            <div className="status-title">Yahalla Core</div>
            <div className="status-text">{isAdminUser ? 'Admin Mode' : 'Workspace'}</div>
          </div>
        </div>

        <div className="sidebar-user">
          <div className="avatar">{(profile.email || '?').slice(0, 1).toUpperCase()}</div>
          <div className="user-info">
            <div className="user-name">{profile.full_name || profile.role}</div>
            <div className="user-email">{profile.email}</div>
          </div>
          <button onClick={onLogout} className="logout-button" title="Abmelden">
            <LogOut size={16} />
          </button>
        </div>
      </aside>

      {mobileOpen && <div className="mobile-overlay" onClick={() => setMobileOpen(false)} />}

      <main className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            <button className="mobile-menu" onClick={() => setMobileOpen(true)}>
              <Menu size={20} />
            </button>
            <div>
              <div className="page-title">{active}</div>
              <div className="breadcrumb">
                Yahalla AI <ChevronRight size={12} /> {isAdminUser ? 'Control Center' : 'Workspace'}
              </div>
            </div>
          </div>
          <div className="topbar-right">
            <div className="system-pill">
              <span className="status-dot" />
              All systems operational
            </div>
            <button className="icon-button"><Search size={18} /></button>
            <button className="icon-button"><CircleHelp size={18} /></button>
          </div>
        </header>

        {active === 'Chat' ? (
          renderPage()
        ) : (
          <section className="content-area">
            {renderPage()}
          </section>
        )}
      </main>
    </div>
  )
}

// =============================================================
// App root
// =============================================================

function App() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function init() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        setLoading(false)
        return
      }

      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .maybeSingle()

      if (!error && data) {
        setProfile(data as Profile)
      }
      setLoading(false)
    }

    init()

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session?.user) {
        setProfile(null)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function handleLogout() {
    await signOut()
    setProfile(null)
  }

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-orb">
          <Sparkles size={22} />
        </div>
        <div>
          <strong>Yahalla AI</strong>
          <span>Initializing Intelligence OS…</span>
        </div>
      </div>
    )
  }

  if (!profile) {
    return <Login />
  }

  return <ControlCenter profile={profile} onLogout={handleLogout} />
}

export default App
