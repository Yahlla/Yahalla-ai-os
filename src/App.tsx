import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Activity, Bot, Check, ChevronRight, Circle as CircleHelp, Code2, Copy, Cpu, Download, FileText, FolderKanban, GitBranch, Laptop, LogOut, Menu, MessageSquare, Monitor, Paperclip, Plus, Search, Send, Server, Settings, Shield, ShieldCheck, Sparkles, Terminal, Users, Wrench, X, Zap } from 'lucide-react'
import './App.css'
import { supabase } from './lib/supabase'
import { signIn, signOut, signUp } from './lib/auth'
import * as api from './lib/api'
import * as localRuntime from './lib/localRuntime'
import * as browserRuntime from './lib/browserRuntime'
import * as platformApi from './lib/platformApi'
import type { BrowserChatMessage } from './lib/browserLLM'
import type {
  Agent,
  Approval,
  AuditLog,
  ChatResponse,
  Device,
  DeploymentProposal,
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
  | 'Devices'
  | 'Approvals'
  | 'Deployments'
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

    // onAuthStateChange in the parent App component will pick up the
    // new session and load the profile automatically.
    setLoading(false)
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
    status === 'online' || status === 'active' || status === 'completed' || status === 'approved' || status === 'deployed'
      ? 'badge-success'
      : status === 'running' || status === 'pending' || status === 'queued' || status === 'deploying'
        ? 'badge-running'
        : status === 'waiting_approval' || status === 'waiting_device'
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
  const [connecting, setConnecting] = useState(false)
  const [connectName, setConnectName] = useState('')
  const [connectUrl, setConnectUrl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  function load() {
    setLoading(true)
    api.getServers().then(setServers).finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  async function handleConnect(event: FormEvent) {
    event.preventDefault()
    setError('')
    setBusy('connect')
    try {
      const server = await api.connectServer(connectUrl.trim(), connectName.trim() || connectUrl.trim())
      setServers((prev) => [server, ...prev])
      setConnecting(false)
      setConnectName('')
      setConnectUrl('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach that server. Check the URL and try again.')
    } finally {
      setBusy(null)
    }
  }

  async function handleRefresh(server: ServerType) {
    setBusy(server.id)
    try {
      await api.refreshServerHealth(server)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Health check failed.')
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <div className="loading-text">Loading servers…</div>

  return (
    <div className="admin-section">
      <div className="section-header">
        <h2>Servers</h2>
        <p>{servers.length} execution nodes registered</p>
      </div>

      <div className="data-card-actions" style={{ marginBottom: 20 }}>
        <button className="mini-button approve" onClick={() => setConnecting((v) => !v)}>
          <Server size={14} /> Connect a Server (VPS)
        </button>
      </div>

      {error && <p className="data-card-desc" style={{ color: '#fca5a5' }}>{error}</p>}

      {connecting && (
        <form className="data-card" style={{ marginBottom: 20 }} onSubmit={handleConnect}>
          <div className="data-card-header">
            <div className="data-card-icon"><Server size={18} /></div>
            <div className="data-card-title">
              <div className="data-card-name">Connect a self-hosted control plane</div>
              <div className="data-card-sub">Its public URL, from `sh scripts/setup-strato.sh` -- one click, no terminal</div>
            </div>
          </div>
          <input
            className="text-input"
            placeholder="Name (e.g. Strato Production)"
            value={connectName}
            onChange={(e) => setConnectName(e.target.value)}
            style={{ marginBottom: 8, width: '100%' }}
          />
          <input
            className="text-input"
            placeholder="https://your-domain.example.com"
            value={connectUrl}
            onChange={(e) => setConnectUrl(e.target.value)}
            required
            style={{ width: '100%' }}
          />
          <div className="data-card-actions">
            <button className="mini-button approve" type="submit" disabled={busy === 'connect'}>
              <Check size={14} /> {busy === 'connect' ? 'Checking…' : 'Connect'}
            </button>
            <button className="mini-button reject" type="button" onClick={() => setConnecting(false)}>
              <X size={14} /> Cancel
            </button>
          </div>
        </form>
      )}

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
            {server.capabilities?.self_hosted === true && (
              <div className="data-card-actions">
                <button className="mini-button" disabled={busy === server.id} onClick={() => handleRefresh(server)}>
                  <Activity size={14} /> {busy === server.id ? 'Checking…' : 'Check status'}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function isDeviceOnline(device: Device): boolean {
  if (device.status !== 'online' || !device.last_heartbeat_at) return false
  return Date.now() - new Date(device.last_heartbeat_at).getTime() < 60_000
}

function DevicesSection() {
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null)
  const [pairingBusy, setPairingBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)

  function load() {
    setLoading(true)
    api.getDevices().then(setDevices).catch((err) => setError(err.message)).finally(() => setLoading(false))
  }

  useEffect(() => {
    load()

    const channel = supabase
      .channel('devices-section')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, () => load())
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  async function connectDevice() {
    setPairingBusy(true)
    setError('')
    setCopied(false)
    try {
      const result = await api.pairDevice()
      if (!result.pairing_code || !result.expires_at) {
        throw new Error(result.error || 'Failed to create a pairing code.')
      }
      setPairing({ code: result.pairing_code, expiresAt: result.expires_at })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create a pairing code.')
    } finally {
      setPairingBusy(false)
    }
  }

  async function handleRevoke(device: Device) {
    setRevoking(device.id)
    try {
      await api.revokeDevice(device.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke device.')
    } finally {
      setRevoking(null)
    }
  }

  function copyCode() {
    if (!pairing) return
    navigator.clipboard?.writeText(pairing.code)
    setCopied(true)
  }

  if (loading) return <div className="loading-text">Loading devices…</div>

  return (
    <div className="admin-section">
      <div className="section-header">
        <h2>Devices</h2>
        <p>{devices.length} paired · runs project filesystem/git/command tools locally, no VPS</p>
      </div>

      <div className="data-card-actions" style={{ marginBottom: 20 }}>
        <button className="mini-button approve" disabled={pairingBusy} onClick={connectDevice}>
          <Laptop size={14} /> Connect this device
        </button>
      </div>

      {error && <p className="data-card-desc" style={{ color: '#fca5a5' }}>{error}</p>}

      {pairing && (
        <div className="data-card" style={{ marginBottom: 20 }}>
          <div className="data-card-header">
            <div className="data-card-icon"><Laptop size={18} /></div>
            <div className="data-card-title">
              <div className="data-card-name">Pairing code</div>
              <div className="data-card-sub">expires {new Date(pairing.expiresAt).toLocaleTimeString()}</div>
            </div>
          </div>
          <div className="pairing-code">
            {pairing.code}
            <button className="mini-button" onClick={copyCode} title="Copy">
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          <p className="data-card-desc">
            On the machine where the project lives, run once:
            <br />
            <code>cd device-agent &amp;&amp; npm run pair {pairing.code}</code>
            <br />
            Then <code>npm run build &amp;&amp; sh scripts/install-macos-autostart.sh</code> (macOS) so it starts
            automatically -- no Terminal after that. See device-agent/README.md.
          </p>
        </div>
      )}

      <div className="card-grid">
        {devices.map((device) => {
          const online = isDeviceOnline(device)
          return (
            <div key={device.id} className="data-card">
              <div className="data-card-header">
                <div className="data-card-icon"><Laptop size={18} /></div>
                <div className="data-card-title">
                  <div className="data-card-name">{device.name}</div>
                  <div className="data-card-sub">{device.platform}</div>
                </div>
                <StatusBadge status={device.status === 'revoked' ? 'revoked' : online ? 'online' : 'offline'} />
              </div>
              <div className="info-row">
                <span className="info-label">Heartbeat</span>
                <span className="info-value">
                  {device.last_heartbeat_at ? new Date(device.last_heartbeat_at).toLocaleString() : 'Never'}
                </span>
              </div>
              <div className="info-row">
                <span className="info-label">Paired</span>
                <span className="info-value">
                  {device.paired_at ? new Date(device.paired_at).toLocaleString() : '—'}
                </span>
              </div>
              {device.status !== 'revoked' && (
                <div className="data-card-actions">
                  <button
                    className="mini-button reject"
                    disabled={revoking === device.id}
                    onClick={() => handleRevoke(device)}
                  >
                    <X size={14} /> Revoke
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {devices.length === 0 && (
        <p className="loading-text">
          No devices paired yet. Tools that touch your local project (files, git, commands) need a paired
          device to run on.
        </p>
      )}
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

// Renders a unified diff with additions in green and removals in red --
// the entire point of this page is that an admin can judge a proposed
// change and click one button, never open a terminal.
function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n')
  return (
    <pre className="diff-view">
      {lines.map((line, i) => {
        let cls = 'diff-line-context'
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'diff-line-add'
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'diff-line-remove'
        else if (line.startsWith('@@')) cls = 'diff-line-hunk'
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}

function DeploymentsSection({ profile }: { profile: Profile }) {
  const [deployments, setDeployments] = useState<DeploymentProposal[]>([])
  const [loading, setLoading] = useState(true)
  const [processing, setProcessing] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    api.getDeploymentProposals().then(setDeployments).finally(() => setLoading(false))
  }, [])

  async function handleAction(deployment: DeploymentProposal, action: 'approve' | 'reject') {
    setProcessing(deployment.id)
    try {
      await api.decideDeploymentProposal(deployment.id, action, profile.id)
      setDeployments((prev) =>
        prev.map((d) =>
          d.id === deployment.id ? { ...d, status: action === 'approve' ? 'approved' : 'rejected' } : d,
        ),
      )
    } catch (err) {
      console.error(err)
    } finally {
      setProcessing(null)
    }
  }

  if (loading) return <div className="loading-text">Loading deployments…</div>

  const pendingCount = deployments.filter((d) => d.status === 'pending').length

  return (
    <div className="admin-section">
      <div className="section-header">
        <h2>Deployments</h2>
        <p>{pendingCount} awaiting review · agent-proposed changes ship only after one-click approval, no terminal required</p>
      </div>
      <div className="card-grid deployments-grid">
        {deployments.length === 0 && <p className="empty-state">No deployment proposals yet.</p>}
        {deployments.map((deployment) => (
          <div key={deployment.id} className="data-card deployment-card">
            <div className="data-card-header">
              <div className="data-card-icon">
                <GitBranch size={18} />
              </div>
              <div className="data-card-title">
                <div className="data-card-name">{deployment.title}</div>
                <div className="data-card-sub">
                  {deployment.proposed_by_agent ? `${deployment.proposed_by_agent} · ` : ''}
                  {deployment.git_ref} → {deployment.base_ref} · {new Date(deployment.created_at).toLocaleString()}
                </div>
              </div>
              <StatusBadge status={deployment.status} />
            </div>
            {deployment.description && <p className="data-card-desc">{deployment.description}</p>}
            <button
              className="mini-button"
              onClick={() => setExpanded(expanded === deployment.id ? null : deployment.id)}
            >
              {expanded === deployment.id ? 'Hide diff' : 'View diff'}
            </button>
            {expanded === deployment.id && <DiffView diff={deployment.diff} />}
            {deployment.deploy_log && (
              <details className="deploy-log">
                <summary>Deploy log</summary>
                <pre>{deployment.deploy_log}</pre>
              </details>
            )}
            {deployment.status === 'pending' && (
              <div className="data-card-actions">
                <button
                  className="mini-button approve"
                  disabled={processing === deployment.id}
                  onClick={() => handleAction(deployment, 'approve')}
                >
                  <Check size={14} /> Approve & Ship
                </button>
                <button
                  className="mini-button reject"
                  disabled={processing === deployment.id}
                  onClick={() => handleAction(deployment, 'reject')}
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
  const [pinging, setPinging] = useState<string | null>(null)

  function load() {
    return Promise.all([api.getServers(), api.getModels()]).then(([s, m]) => {
      setServers(s)
      setModels(m)
    })
  }

  useEffect(() => {
    load().finally(() => setLoading(false))
  }, [])

  async function pingControlPlane(server: ServerType) {
    setPinging(server.id)
    try {
      await api.refreshServerHealth(server)
      await load()
    } finally {
      setPinging(null)
    }
  }

  if (loading) return <div className="loading-text">Loading health data…</div>

  const controlPlanes = servers.filter((s) => s.capabilities?.self_hosted === true)

  return (
    <div className="admin-section">
      <div className="section-header">
        <h2>Health</h2>
        <p>Runtime and infrastructure health</p>
      </div>

      {controlPlanes.length > 0 && (
        <div className="health-group">
          <h3>Self-hosted control plane</h3>
          {controlPlanes.map((server) => (
            <div key={server.id} className="health-row">
              <Activity size={16} />
              <span className="health-label">{server.name}</span>
              <span className="health-host">{server.hostname}</span>
              <StatusBadge status={server.status} />
              <button
                className="mini-button"
                disabled={pinging === server.id}
                onClick={() => pingControlPlane(server)}
              >
                {pinging === server.id ? 'Pinging…' : 'Ping now'}
              </button>
            </div>
          ))}
        </div>
      )}

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

// =============================================================
// Artifacts (side panel for HTML/code/documents/charts, separate from
// the chat transcript -- matching Claude's own Artifacts UX)
// =============================================================

type Artifact = {
  id: string
  title: string
  language: string
  kind: 'html' | 'svg' | 'markdown' | 'code'
  content: string
}

function detectArtifactKind(language: string): Artifact['kind'] {
  const lang = language.toLowerCase()
  if (lang === 'html' || lang === 'htm') return 'html'
  if (lang === 'svg') return 'svg'
  if (lang === 'markdown' || lang === 'md') return 'markdown'
  return 'code'
}

const ARTIFACT_EXTENSIONS: Record<string, string> = {
  html: 'html', htm: 'html', svg: 'svg', markdown: 'md', md: 'md',
  javascript: 'js', typescript: 'ts', jsx: 'jsx', tsx: 'tsx', python: 'py',
  json: 'json', css: 'css', sh: 'sh', bash: 'sh', sql: 'sql', yaml: 'yaml', yml: 'yaml',
}

function artifactTitle(language: string, index: number): string {
  const lang = language.toLowerCase()
  const suffix = ARTIFACT_EXTENSIONS[lang] || lang || 'txt'
  return `artifact-${index + 1}.${suffix}`
}

// Fenced code blocks earn their own side-panel view instead of crowding
// the chat transcript -- the same heuristic Claude's own Artifacts feature
// uses: substantial or inherently visual content (HTML/SVG/documents) goes
// to the panel, trivial one-line snippets stay inline in the bubble.
function extractArtifacts(messageId: string, content: string): Artifact[] {
  const artifacts: Artifact[] = []
  const regex = /```(\w+)?\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  let index = 0
  while ((match = regex.exec(content))) {
    const language = match[1] || 'text'
    const body = (match[2] ?? '').trim()
    if (!body) continue
    const kind = detectArtifactKind(language)
    if (kind === 'code' && body.split('\n').length < 4) continue
    artifacts.push({ id: `${messageId}-${index}`, title: artifactTitle(language, index), language, kind, content: body })
    index++
  }
  return artifacts
}

// Tiny, dependency-free Markdown renderer -- headings, bold/italic/code
// spans, and unordered lists. Enough to render a generated document
// legibly in the panel without pulling in a Markdown library.
function renderMarkdownLite(text: string) {
  const inline = (s: string, keyBase: string) => {
    const parts: React.ReactNode[] = []
    const tokenRegex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g
    let last = 0
    let m: RegExpExecArray | null
    let key = 0
    while ((m = tokenRegex.exec(s))) {
      if (m.index > last) parts.push(s.slice(last, m.index))
      const token = m[0]
      if (token.startsWith('**')) parts.push(<strong key={`${keyBase}-${key++}`}>{token.slice(2, -2)}</strong>)
      else if (token.startsWith('`')) parts.push(<code key={`${keyBase}-${key++}`}>{token.slice(1, -1)}</code>)
      else parts.push(<em key={`${keyBase}-${key++}`}>{token.slice(1, -1)}</em>)
      last = tokenRegex.lastIndex
    }
    if (last < s.length) parts.push(s.slice(last))
    return parts
  }

  const blocks: React.ReactNode[] = []
  let listItems: string[] = []
  const flushList = () => {
    if (listItems.length) {
      blocks.push(<ul key={blocks.length}>{listItems.map((li, i) => <li key={i}>{inline(li, `${blocks.length}-${i}`)}</li>)}</ul>)
      listItems = []
    }
  }

  for (const line of text.split('\n')) {
    const heading = line.match(/^(#{1,3})\s+(.*)/)
    if (heading) {
      flushList()
      const level = heading[1]!.length
      const rendered = inline(heading[2]!, `h${blocks.length}`)
      blocks.push(level === 1 ? <h1 key={blocks.length}>{rendered}</h1> : level === 2 ? <h2 key={blocks.length}>{rendered}</h2> : <h3 key={blocks.length}>{rendered}</h3>)
      continue
    }
    const listItem = line.match(/^[-*]\s+(.*)/)
    if (listItem) {
      listItems.push(listItem[1]!)
      continue
    }
    flushList()
    if (line.trim() === '') continue
    blocks.push(<p key={blocks.length}>{inline(line, `p${blocks.length}`)}</p>)
  }
  flushList()
  return blocks
}

function downloadArtifact(artifact: Artifact): void {
  const blob = new Blob([artifact.content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = artifact.title
  link.click()
  URL.revokeObjectURL(url)
}

function ArtifactsPanel({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const canPreview = artifact.kind === 'html' || artifact.kind === 'svg'
  const [view, setView] = useState<'preview' | 'source'>(canPreview ? 'preview' : 'source')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setView(canPreview ? 'preview' : 'source')
    setCopied(false)
  }, [artifact.id, canPreview])

  function copy() {
    navigator.clipboard?.writeText(artifact.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const previewDoc =
    artifact.kind === 'html'
      ? artifact.content
      : `<!doctype html><html><body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fff">${artifact.content}</body></html>`

  return (
    <div className="artifacts-panel">
      <div className="artifacts-panel-header">
        <div className="artifacts-panel-title">
          <Code2 size={15} />
          <span>{artifact.title}</span>
        </div>
        <div className="artifacts-panel-actions">
          {canPreview && (
            <div className="artifacts-view-toggle">
              <button className={view === 'preview' ? 'active' : ''} onClick={() => setView('preview')}>Preview</button>
              <button className={view === 'source' ? 'active' : ''} onClick={() => setView('source')}>Code</button>
            </div>
          )}
          <button className="icon-button" onClick={copy} title="Copy">
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
          <button className="icon-button" onClick={() => downloadArtifact(artifact)} title="Download">
            <Download size={15} />
          </button>
          <button className="icon-button" onClick={onClose} title="Close">
            <X size={15} />
          </button>
        </div>
      </div>
      <div className="artifacts-panel-body">
        {canPreview && view === 'preview' ? (
          <iframe className="artifact-frame" sandbox="allow-scripts" srcDoc={previewDoc} title={artifact.title} />
        ) : artifact.kind === 'markdown' ? (
          <div className="artifact-markdown">{renderMarkdownLite(artifact.content)}</div>
        ) : (
          <pre className="artifact-code"><code>{artifact.content}</code></pre>
        )}
      </div>
    </div>
  )
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
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [conversationId, setConversationId] = useState<string | null>(null)
  // Separate from conversationId above (which tracks the legacy Supabase
  // cloud-routed conversation, a different database entirely) -- this is
  // the Strato-hosted conversation this chat's history is actually being
  // persisted to, independent of which of the three tiers is answering
  // any given message.
  const [platformConversationId, setPlatformConversationId] = useState<string | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [selectedAgent, setSelectedAgent] = useState('yahalla-core')
  const [selectedModel, setSelectedModel] = useState('')
  const [showTechnical, setShowTechnical] = useState(false)
  const [lastResult, setLastResult] = useState<ChatResponse | null>(null)
  const [liveStatus, setLiveStatus] = useState<{ state: string; summary: string | null } | null>(null)
  const [modelLoadProgress, setModelLoadProgress] = useState<{ progress: number; text: string } | null>(null)
  const [modelLoadStalled, setModelLoadStalled] = useState(false)
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null)
  const [runtimeTier, setRuntimeTier] = useState<'local' | 'browser' | 'cloud' | null>(null)
  const browserHistoryRef = useRef<BrowserChatMessage[]>([])

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Fenced code blocks in assistant messages become artifacts, rendered in
  // the side panel instead of inline -- recomputed only when the
  // transcript actually changes, not on every keystroke/render.
  const messageArtifacts = useMemo(() => {
    const map = new Map<string, Artifact[]>()
    for (const message of messages) {
      if (message.role === 'assistant') map.set(message.id, extractArtifacts(message.id, message.content))
    }
    return map
  }, [messages])

  const activeArtifact = useMemo(() => {
    if (!activeArtifactId) return null
    for (const artifacts of messageArtifacts.values()) {
      const found = artifacts.find((a) => a.id === activeArtifactId)
      if (found) return found
    }
    return null
  }, [activeArtifactId, messageArtifacts])

  useEffect(() => {
    // Live "what is Yahalla doing right now" indicator -- concise
    // action/status summaries only, never raw model reasoning. Silently
    // no-ops if no local runtime is reachable (e.g. legacy cloud-routed
    // fallback is active instead).
    let unsubscribe: (() => void) | undefined
    localRuntime
      .subscribeLiveStatus((update) => {
        if (update.kind === 'embodiment') {
          setLiveStatus({ state: update.state, summary: update.summary })
        }
      })
      .then((unsub) => {
        unsubscribe = unsub
      })
      .catch(() => {
        // no local runtime reachable from this window -- nothing to show
      })
    return () => unsubscribe?.()
  }, [])

  useEffect(() => {
    api.getAgents().then((a) => setAgents(a.filter((x) => x.status === 'active')))
    api.getModels().then((m) => setModels(m.filter((x) => x.enabled)))
  }, [])

  // Conversation history persists on Strato (platformApi), independent of
  // which inference tier answers any given message -- reload it once on
  // mount so it survives a page refresh or signing in from another
  // device, instead of only ever living in this tab's React state. A
  // no-op (falls straight through to the default welcome message) when
  // VITE_PLATFORM_API_URL isn't configured.
  useEffect(() => {
    let cancelled = false
    async function loadHistory() {
      if (!platformApi.isPlatformApiConfigured()) return
      const conversations = await platformApi.listConversations()
      const latest = conversations[0]
      if (!latest) return
      const persisted = await platformApi.getConversationMessages(latest.id)
      if (cancelled || persisted.length === 0) return
      setMessages(
        persisted
          .filter((m): m is typeof m & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: new Date(m.created_at),
            toolActivity: m.tool_activity,
            agent: m.role === 'assistant' ? 'yahalla-core' : undefined,
          })),
      )
      setPlatformConversationId(latest.id)
    }
    loadHistory()
    return () => {
      cancelled = true
    }
  }, [])

  // The one-time browser model download used to only start the moment the
  // user hit send on their first message, blocking that whole first reply
  // on it. Pulled out so it can run silently in the background as soon as
  // we know this device will need it (see the effect below) -- by the
  // time someone finishes typing their first message, the model is
  // already loaded or well into loading, instead of that cost landing on
  // the very first send. Safe to call more than once concurrently: the
  // concurrency-safe loadingPromise in browserLLM.ts makes every caller
  // (this background warm-up, and sendMessage's own check) join the same
  // in-flight load rather than starting a new one.
  // `visible` controls only whether progress/stall UI state gets updated --
  // the background warm-up call passes false so the very first thing a
  // visitor sees isn't a download banner they never asked to look at
  // ("zero-friction"). If the user actually sends a message before that
  // silent load finishes, sendMessage's own (visible) call to this same
  // function sees the load already in flight and returns immediately
  // without re-attaching progress reporting (WebLLM only invokes the
  // first caller's callback) -- the chat still waits correctly for it via
  // browserChatCompletion's own await, it just shows the ordinary
  // "processing" state instead of a percentage in that specific timing
  // window, rather than nothing at all.
  async function ensureBrowserModelLoading(visible = true) {
    if (browserRuntime.browserModelReady()) return
    if (visible) {
      setLiveStatus({ state: 'THINKING', summary: 'Downloading local model to this device…' })
      setModelLoadStalled(false)
    }

    // A silent progress bar stuck at 0% reads as broken, not slow -- if no
    // progress event arrives for a while, this is almost always the
    // browser failing to reach the model host (a slow, restrictive, or
    // blocking network), not a fast, temporary pause. Say so plainly and
    // point at the real fix (local-runtime needs no such download at all)
    // instead of leaving the user staring at "0%" with no explanation.
    let lastProgressAt = Date.now()
    const stallCheck = visible
      ? setInterval(() => {
          if (Date.now() - lastProgressAt > 15_000) setModelLoadStalled(true)
        }, 3000)
      : undefined

    try {
      await browserRuntime.prepareBrowserModel((p) => {
        if (!visible) return
        lastProgressAt = Date.now()
        setModelLoadStalled(false)
        setModelLoadProgress(p)
        setLiveStatus({ state: 'THINKING', summary: p.text || `Downloading local model… ${Math.round(p.progress * 100)}%` })
      })
    } finally {
      if (stallCheck) clearInterval(stallCheck)
    }
    if (visible) {
      setModelLoadProgress(null)
      setModelLoadStalled(false)
    }
  }

  // Which tier will actually answer the next message -- shown to the user
  // so "why is this slow / downloading" has an answer before they even
  // send anything, and so local-runtime (the fast, no-download path) gets
  // surfaced as the thing to install rather than staying invisible
  // plumbing only power users know about.
  useEffect(() => {
    let cancelled = false
    async function detectTier() {
      const health = await localRuntime.checkRuntimeHealth()
      if (health?.llm_reachable) {
        if (!cancelled) setRuntimeTier('local')
        return
      }
      if (await browserRuntime.checkBrowserRuntimeAvailable()) {
        if (!cancelled) setRuntimeTier('browser')
        // Zero-friction: start the one-time download now, in the
        // background, rather than waiting for the user to hit send.
        // Errors here are silently swallowed -- sendMessage's own call
        // to the same function will surface them normally if the
        // background attempt didn't already succeed.
        ensureBrowserModelLoading(false).catch(() => {})
        return
      }
      if (!cancelled) setRuntimeTier('cloud')
    }
    detectTier()
    return () => {
      cancelled = true
    }
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
      // Three-tier local-first fallback, in order of preference:
      // 1. A local Agent Runtime process on this device (desktop app /
      //    dev setup) -- full tool execution, memory, permissions.
      // 2. No runtime process reachable? Run the model directly in this
      //    browser tab via WebGPU -- still entirely on-device, works
      //    identically on a phone or a laptop just by opening the page,
      //    no install, no terminal. No file/tool access in this mode
      //    (a browser tab structurally cannot have that).
      // 3. Only if neither local path is available at all, fall back to
      //    the legacy Supabase-routed path so an existing dev/cloud setup
      //    keeps working rather than breaking outright.
      // A local-runtime process can be up (port reachable) while its LLM
      // backend isn't -- llama-server not installed yet, or no model
      // downloaded/activated. Routing to it anyway doesn't hang (the
      // agent loop's own LLM call times out and returns an error), but it
      // does mean showing a confusing "local LLM unreachable" failure
      // instead of quietly using a path that actually works. Gating on
      // llm_reachable (not just "the process responded at all") is what
      // makes the three-tier fallback behave the way it's meant to.
      const runtimeHealth = await localRuntime.checkRuntimeHealth()
      let result: ChatResponse
      // Set only for the browser path: a placeholder assistant message is
      // inserted up front and filled in token-by-token as the model
      // generates, the same live-typing behavior ChatGPT has, instead of
      // a static "processing" state that only updates once at the very
      // end. The other two tiers are plain non-streaming REST calls and
      // still append their message the old way, after the fact.
      let streamingMessageId: string | null = null

      if (runtimeHealth?.llm_reachable) {
        setRuntimeTier('local')
        result = await localRuntime.sendChatMessage({ message, conversation_id: conversationId ?? undefined })
      } else if (await browserRuntime.checkBrowserRuntimeAvailable()) {
        setRuntimeTier('browser')
        // Usually already loaded or loading by now -- the background
        // warm-up effect kicked this off as soon as the page determined
        // this device would need it, not on this first send.
        await ensureBrowserModelLoading()

        streamingMessageId = crypto.randomUUID()
        const idForClosure = streamingMessageId
        setMessages((prev) => [
          ...prev,
          { id: idForClosure, role: 'assistant', content: '', createdAt: new Date(), agent: 'yahalla-core' },
        ])

        setStreamingMessageId(idForClosure)
        try {
          const browserResult = await browserRuntime.sendChatMessage(browserHistoryRef.current, message, (delta) => {
            setMessages((prev) => prev.map((m) => (m.id === idForClosure ? { ...m, content: m.content + delta } : m)))
          })
          browserHistoryRef.current = browserResult.updatedHistory
          result = browserResult
        } finally {
          setStreamingMessageId(null)
        }
      } else {
        setRuntimeTier('cloud')
        result = await api.sendChatMessage({
          message,
          conversation_id: conversationId ?? undefined,
          agent_key: selectedAgent,
          model_id: selectedModel || undefined,
        })
      }

      setLastResult(result)

      if (result.conversation_id) {
        setConversationId(result.conversation_id)
      }

      const assistantContent =
        result.answer ||
        result.error ||
        'Yahalla AI Core did not return an answer.'

      const finalMessageId = streamingMessageId ?? crypto.randomUUID()

      if (streamingMessageId) {
        // Already streamed in incrementally -- just reconcile the final
        // metadata (error flag, task id) onto the same message rather
        // than appending a second one.
        setMessages((prev) =>
          prev.map((m) =>
            m.id === streamingMessageId
              ? { ...m, content: assistantContent, taskId: result.task_id, agent: result.agent?.key, error: !result.success }
              : m,
          ),
        )
      } else {
        const assistantMessage: ChatMessage = {
          id: finalMessageId,
          role: 'assistant',
          content: assistantContent,
          createdAt: new Date(),
          taskId: result.task_id,
          agent: result.agent?.key,
          toolActivity: result.executed_tools as { tool: string; result: Record<string, unknown> }[],
          error: !result.success,
        }
        setMessages((prev) => [...prev, assistantMessage])
      }

      const newArtifacts = extractArtifacts(finalMessageId, assistantContent)
      if (newArtifacts.length > 0) setActiveArtifactId(newArtifacts[newArtifacts.length - 1]!.id)

      // Persisted on Strato independently of which tier answered --
      // deliberately not awaited: persistence latency must never be what
      // a "send" is waiting on, and a failure here (platform-api
      // unreachable, not configured, ...) shouldn't surface as a chat
      // error since the reply the user actually asked for already
      // succeeded.
      if (platformApi.isPlatformApiConfigured()) {
        void (async () => {
          let convId = platformConversationId
          if (!convId) {
            const created = await platformApi.createConversation(message.slice(0, 60))
            if (!created) return
            convId = created.id
            setPlatformConversationId(created.id)
          }
          await platformApi.appendMessage(convId, { role: 'user', content: message })
          await platformApi.appendMessage(convId, {
            role: 'assistant',
            content: assistantContent,
            tool_activity: result.executed_tools as { tool: string; result: Record<string, unknown> }[] | undefined,
          })
        })()
      }
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
      setModelLoadProgress(null)
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
    setPlatformConversationId(null)
    setLastResult(null)
    setError('')
    setInput('')
    setActiveArtifactId(null)
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
              {runtimeTier === 'local' && 'Local Runtime · Full speed on this device'}
              {runtimeTier === 'browser' && 'Browser Mode (WebGPU) · one-time download'}
              {runtimeTier === 'cloud' && 'Cloud fallback'}
              {runtimeTier === null && 'AI Orchestrator · Online'}
            </div>
          </div>
          {runtimeTier && runtimeTier !== 'local' && (
            <a
              className="runtime-tier-cta"
              href="https://github.com/Yahlla/Yahalla-ai-os/blob/main/scripts/setup-local.sh"
              target="_blank"
              rel="noreferrer"
              title="Run once on your device for instant, no-download responses"
            >
              <Zap size={12} /> Get full speed
            </a>
          )}
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
      <div className="chat-main">
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
                  <div className={`message-bubble ${message.error ? 'message-error' : ''} ${message.id === streamingMessageId ? 'streaming' : ''}`}>
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
                  {(messageArtifacts.get(message.id) ?? []).map((artifact) => (
                    <button
                      key={artifact.id}
                      className={`artifact-chip ${activeArtifactId === artifact.id ? 'active' : ''}`}
                      onClick={() => setActiveArtifactId(artifact.id)}
                    >
                      <Code2 size={12} />
                      {artifact.title}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            {sending && !streamingMessageId && (
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
                    <em>{liveStatus?.summary || 'Processing request…'}</em>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="composer-area">
          {error && <div className="composer-error">{error}</div>}

          {/* No progress bar/percentage in the normal case -- the background
              warm-up (started as soon as the page loads, see
              ensureBrowserModelLoading) means the model is usually already
              ready by the time a message is sent, and the generic
              "processing" bubble already covers the rare case it isn't.
              A visible download banner only earns its place once something
              is actually wrong: see the stall warning below. */}
          {modelLoadProgress && modelLoadStalled && (
            <div className="composer-error">
              التحميل بطيء جداً أو محجوب من شبكتك الحالية ({Math.round(modelLoadProgress.progress * 100)}% فقط منذ فترة).
              للحصول على سرعة وقوة فورية بدون أي تحميل، شغّل local-runtime على جهازك مرة واحدة:{' '}
              <code>sh scripts/setup-local.sh</code>
            </div>
          )}

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
      {activeArtifact && <ArtifactsPanel artifact={activeArtifact} onClose={() => setActiveArtifactId(null)} />}
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
  { label: 'Devices', icon: Laptop, adminOnly: true },
  { label: 'Approvals', icon: ShieldCheck, adminOnly: true },
  { label: 'Deployments', icon: GitBranch, adminOnly: true },
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
      case 'Devices':
        return <DevicesSection />
      case 'Approvals':
        return <ApprovalsSection />
      case 'Deployments':
        return <DeploymentsSection profile={profile} />
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
    let cancelled = false

    async function loadProfile(userId: string) {
      // The trigger may take a moment to create the profile row;
      // retry a few times before giving up.
      for (let attempt = 0; attempt < 5; attempt++) {
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .maybeSingle()
        if (!error && data) {
          if (!cancelled) setProfile(data as Profile)
          return
        }
        await new Promise((r) => setTimeout(r, 300))
      }
    }

    async function init() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        if (!cancelled) setLoading(false)
        return
      }
      await loadProfile(user.id)
      if (!cancelled) setLoading(false)
    }

    init()

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        loadProfile(session.user.id).then(() => {
          if (!cancelled) setLoading(false)
        })
      } else {
        if (!cancelled) setProfile(null)
      }
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
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
