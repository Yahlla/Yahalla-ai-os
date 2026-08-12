import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Activity, Bot, Camera, Check, ChevronRight, Circle as CircleHelp, Code2, Copy, Cpu, Download, FileText, FolderKanban, GitBranch, Laptop, LogOut, Menu, MessageSquare, Mic, MicOff, Monitor, Paperclip, Phone, PhoneOff, Plus, RotateCcw, Search, Send, Server, Settings, Shield, ShieldCheck, Sparkles, Terminal, Users, Wrench, X, Zap } from 'lucide-react'
import './App.css'
import { supabase } from './lib/supabase'
import { signIn, signOut, signUp } from './lib/auth'
import * as api from './lib/api'
import * as localRuntime from './lib/localRuntime'
import * as browserRuntime from './lib/browserRuntime'
import * as platformApi from './lib/platformApi'
import { requestMediaPermission } from './lib/capabilities'
import { createVoiceRecognizer, isSpeechRecognitionSupported, type VoiceRecognizer } from './lib/voiceInput'
import * as voiceOutput from './lib/voiceOutput'
import { createBlinkDetector, isGestureControlSupported, type BlinkDetector } from './lib/gestureControl'
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

// One-click, zero-terminal pairing: gets a pairing code from platform-api
// (POST /pair_device, using this browser's own Supabase session) and feeds
// it straight into this same machine's local Agent Runtime (POST
// /device/pair on 127.0.0.1) in the same click -- no code to copy, no
// terminal, ever. Only works from a browser tab open on the machine that
// should become remotely commandable; on a phone or a machine with no
// local-runtime running, it fails with a clear "not reachable" message
// instead of silently doing nothing.
function RemoteAccessCard() {
  const [status, setStatus] = useState<localRuntime.RuntimeDeviceStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function refresh() {
    setChecking(true)
    localRuntime.getRuntimeDeviceStatus().then(setStatus).finally(() => setChecking(false))
  }

  useEffect(() => {
    refresh()
  }, [])

  if (!platformApi.isPlatformApiConfigured()) return null

  async function enable() {
    setBusy(true)
    setError('')
    try {
      const codeResult = await platformApi.requestDevicePairingCode('This Computer')
      if (!codeResult.ok) throw new Error(codeResult.error)
      const platformApiUrl = platformApi.getPlatformApiUrl()
      if (!platformApiUrl) throw new Error('Platform server is not configured.')
      const pairResult = await localRuntime.pairThisRuntime(platformApiUrl, codeResult.code, 'This Computer')
      if (!pairResult.ok) throw new Error(pairResult.error)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not enable remote access.')
    } finally {
      setBusy(false)
    }
  }

  async function disable() {
    setBusy(true)
    setError('')
    try {
      await localRuntime.unpairThisRuntime()
      refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="data-card" style={{ marginBottom: 20 }}>
      <div className="data-card-header">
        <div className="data-card-icon"><Zap size={18} /></div>
        <div className="data-card-title">
          <div className="data-card-name">Remote access to this computer</div>
          <div className="data-card-sub">
            Lets you command this machine's real file/git/GitHub tools from any other browser or phone, once
            paired here
          </div>
        </div>
        {!checking && <StatusBadge status={status?.paired ? 'online' : 'offline'} />}
      </div>
      {error && <p className="data-card-desc" style={{ color: '#fca5a5' }}>{error}</p>}
      <div className="data-card-actions">
        {status?.paired ? (
          <button className="mini-button reject" disabled={busy} onClick={disable}>
            <X size={14} /> Disable
          </button>
        ) : (
          <button className="mini-button approve" disabled={busy || checking} onClick={enable}>
            <Zap size={14} /> {status === null && !checking ? 'Runtime not reachable here' : 'Enable on this computer'}
          </button>
        )}
      </div>
    </div>
  )
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

      <RemoteAccessCard />

      <div className="data-card-actions" style={{ marginBottom: 20 }}>
        <button className="mini-button approve" disabled={pairingBusy} onClick={connectDevice}>
          <Laptop size={14} /> Connect this device (manual, via device-agent)
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

function CloudTierSettingsCard() {
  const [status, setStatus] = useState<platformApi.CloudTierStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [url, setUrl] = useState('')
  const [model, setModel] = useState('')

  function load() {
    setLoading(true)
    platformApi.getCloudTierStatus().then(setStatus).finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  async function handleSave(event: FormEvent) {
    event.preventDefault()
    if (!apiKey.trim()) return
    setSaving(true)
    setError('')
    const result = await platformApi.saveCloudTierSettings({
      apiKey: apiKey.trim(),
      url: url.trim() || undefined,
      model: model.trim() || undefined,
    })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setApiKey('')
    load()
  }

  if (!platformApi.isPlatformApiConfigured()) return null

  return (
    <div className="info-panel" style={{ marginTop: 20 }}>
      <div className="info-panel-header">
        <Sparkles size={18} />
        <span>Cloud Smart Tier (70B, opt-in)</span>
        {!loading && status && (
          <span className={`status-badge ${status.configured ? 'badge-success' : 'badge-unknown'}`} style={{ marginInlineStart: 'auto' }}>
            {status.configured ? `Connected · ${status.model ?? 'configured'}` : 'Not configured'}
          </span>
        )}
      </div>
      <div className="info-panel-body">
        <p className="data-card-desc" style={{ marginBottom: 12 }}>
          Free-tier 70B-class model as an optional escalation, kept server-side only -- the key never leaves this
          server or reaches the browser. Get a free key at{' '}
          <a href="https://console.groq.com" target="_blank" rel="noreferrer">console.groq.com</a>.
        </p>
        {error && <p className="data-card-desc" style={{ color: '#fca5a5', marginBottom: 8 }}>{error}</p>}
        <form onSubmit={handleSave}>
          <input
            className="text-input"
            type="password"
            placeholder={status?.configured ? 'Replace saved key…' : 'Groq API key (gsk_...)'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            style={{ width: '100%', marginBottom: 8 }}
          />
          <button type="button" className="mini-button" onClick={() => setShowAdvanced((v) => !v)} style={{ marginBottom: 8 }}>
            {showAdvanced ? 'Hide' : 'Show'} advanced options
          </button>
          {showAdvanced && (
            <>
              <input
                className="text-input"
                placeholder="Upstream URL (default: Groq's OpenAI-compatible endpoint)"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                style={{ width: '100%', marginBottom: 8 }}
              />
              <input
                className="text-input"
                placeholder="Model (default: llama-3.3-70b-versatile)"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                style={{ width: '100%', marginBottom: 8 }}
              />
            </>
          )}
          <button type="submit" className="primary-button" disabled={saving || !apiKey.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </form>
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
      <CloudTierSettingsCard />
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
  attachments?: { name: string; size: number }[]
  imageDataUrl?: string
  viaCloudBoost?: string
}

// The cloud smart tier gets no system prompt at all otherwise -- a raw
// completion call with just user/assistant turns tends to drift into
// whatever language dominates the visible history (observed live: a
// German first message locked the model into German even after the user
// switched to Arabic) and, at default sampling settings, occasionally
// mixes stray words from an unrelated language into an Arabic sentence.
// Mirrors browserRuntime.ts's own SYSTEM_PROMPT honesty rules (no file/
// tool/Yahalla-data access in this mode either) plus an explicit
// language-matching instruction the browser tier doesn't need as badly
// since its conversations tend to be shorter and more consistent.
const CLOUD_BOOST_SYSTEM_PROMPT = `
You are Yahalla AI, answering via an opt-in cloud escalation to a stronger model -- not a cloud service with hidden server-side tools.

Always reply in the same language the user's most recent message is written in. Default to Arabic when in doubt. Never mix words from an unrelated language into a sentence -- if you don't know a term, say it in the reply's own language instead of substituting a foreign word.

What you can do: hold a conversation, answer general questions, explain things, help draft or reason through something the user describes to you directly in the chat.

What you cannot do, ever, in this mode -- say so plainly the moment it's relevant, do not claim otherwise:
- Read or write project files, run commands, or use git/GitHub.
- See or query the user's actual Yahalla data: tasks, projects, servers, devices, approvals, or anything else stored in their account.
- Anything requiring a live tool, sensor, or network call. You only ever see the text the user typed into this chat.

Be concise and direct. Never guess or invent facts and present them as verified.
`.trim()

type AttachedFile = { name: string; content: string; size: number }

const MAX_ATTACHMENT_BYTES = 200_000
// Read as plain text and included as context -- no vision model is wired
// up (see the camera-capture feature), so an actual image attachment
// can't be "seen" by any tier yet. Extension allowlist, not MIME
// sniffing: browsers report inconsistent/missing MIME types for code
// files, and this list is honest about exactly what gets read as text.
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'jsx', 'ts', 'tsx', 'py', 'css', 'html', 'htm',
  'csv', 'log', 'yaml', 'yml', 'xml', 'sh', 'sql', 'toml', 'ini', 'env', 'c', 'h', 'cpp',
  'java', 'go', 'rs', 'rb', 'php',
])

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
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isListening, setIsListening] = useState(false)
  const [voiceError, setVoiceError] = useState('')
  const voiceRecognizerRef = useRef<VoiceRecognizer | null>(null)
  // Voice Call mode: hands-free listen -> think -> speak -> listen again
  // loop, distinct from the one-shot mic-to-composer dictation above. A
  // ref mirrors callModeOpen because the loop is driven by imperative
  // Web Speech API callbacks (speechSynthesis.onend, recognizer.onresult)
  // that fire outside React's render cycle -- reading stale state there
  // would keep the loop going after the user has already ended the call.
  const [callModeOpen, setCallModeOpen] = useState(false)
  const callModeOpenRef = useRef(false)
  const [callStatus, setCallStatus] = useState<'listening' | 'thinking' | 'speaking'>('listening')
  const [callError, setCallError] = useState('')
  const callRecognizerRef = useRef<VoiceRecognizer | null>(null)
  const callSpeechRef = useRef<voiceOutput.SpeechHandle | null>(null)
  // Which of the device's own installed voices speaks the AI's replies --
  // persisted so the choice survives a reload. voiceURI is undefined until
  // voices are loaded/picked, in which case speak() falls back to its own
  // best-match-by-language default.
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([])
  const [selectedVoiceURI, setSelectedVoiceURI] = useState<string>(() => localStorage.getItem('yahalla_voice_uri') ?? '')
  const [cameraOpen, setCameraOpen] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const [capturedImage, setCapturedImage] = useState<string | null>(null)
  const [pendingImage, setPendingImage] = useState<string | null>(null)
  // Blink-to-capture: opt-in per camera session, off by default. Loads a
  // few-MB model on first enable (see gestureControl.ts), so it's never
  // started automatically just because the camera opened.
  const [gestureEnabled, setGestureEnabled] = useState(false)
  const [gestureLoading, setGestureLoading] = useState(false)
  const [gestureError, setGestureError] = useState('')
  const gestureDetectorRef = useRef<BlinkDetector | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)
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
  const [runtimeTier, setRuntimeTier] = useState<'local' | 'browser' | 'cloud' | 'device' | null>(null)
  // Explicit, user-toggled escalation to the opt-in cloud smart tier (see
  // platform/api/src/cloudTier.ts) -- distinct from runtimeTier's 'cloud',
  // which is the legacy last-resort fallback when no on-device path exists
  // at all. This one is always a deliberate choice, never automatic, and
  // only ever available when platform-api is configured.
  const [cloudBoostEnabled, setCloudBoostEnabled] = useState(false)
  // Explicit escalation to a paired device's real file/git/GitHub tools
  // (task #78-81) -- lets any browser/phone command a machine you've
  // enabled remote access on (see RemoteAccessCard), the same way this
  // very Claude Code session can touch real files. Mutually meaningful
  // with cloudBoostEnabled but checked first below: real tool access beats
  // a bigger model when both are on.
  const [deviceTaskEnabled, setDeviceTaskEnabled] = useState(false)
  const browserHistoryRef = useRef<BrowserChatMessage[]>([])

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Camera tracks must stop even if the user navigates away mid-capture
  // (closes the tab, switches pages) -- otherwise the camera light stays
  // on with no UI left to turn it off from.
  useEffect(() => {
    return () => {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop())
      gestureDetectorRef.current?.stop()
    }
  }, [])

  // Same reasoning as the camera cleanup above: a live mic + speech
  // synthesis must stop on unmount, not keep running with no UI left to
  // end the call from.
  useEffect(() => {
    return () => {
      callModeOpenRef.current = false
      callRecognizerRef.current?.stop()
      callSpeechRef.current?.cancel()
    }
  }, [])

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

  function extensionOf(filename: string): string {
    const dot = filename.lastIndexOf('.')
    return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase()
  }

  async function handleFileSelect(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    setAttachmentError('')
    const files = Array.from(fileList)
    const accepted: AttachedFile[] = []
    const problems: string[] = []

    for (const file of files) {
      if (!TEXT_ATTACHMENT_EXTENSIONS.has(extensionOf(file.name))) {
        problems.push(`${file.name}: نوع الملف غير مدعوم بعد -- يمكن قراءة ملفات نصية/كود فقط (لا يوجد نموذج رؤية متصل حالياً لفهم الصور).`)
        continue
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        problems.push(`${file.name}: أكبر من ${Math.round(MAX_ATTACHMENT_BYTES / 1000)}كB -- قصّه أو قسّمه أولاً.`)
        continue
      }
      try {
        const content = await file.text()
        accepted.push({ name: file.name, content, size: file.size })
      } catch {
        problems.push(`${file.name}: تعذّرت قراءته كملف نصي.`)
      }
    }

    if (accepted.length > 0) setAttachedFiles((prev) => [...prev, ...accepted])
    if (problems.length > 0) setAttachmentError(problems.join(' '))
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function removeAttachment(name: string) {
    setAttachedFiles((prev) => prev.filter((f) => f.name !== name))
  }

  async function toggleVoiceInput() {
    if (isListening) {
      voiceRecognizerRef.current?.stop()
      return
    }
    setVoiceError('')
    if (!isSpeechRecognitionSupported()) {
      setVoiceError('التعرف على الصوت غير مدعوم في هذا المتصفح.')
      return
    }
    // Explicit, user-initiated permission request -- matches the pattern
    // already established in capabilities.ts (requestMediaPermission is
    // never called automatically). SpeechRecognition would prompt for mic
    // access on its own too, but asking directly first gives an honest,
    // specific error message instead of a generic recognition failure if
    // the user denies it.
    const granted = await requestMediaPermission('microphone')
    if (!granted) {
      setVoiceError('تم رفض إذن الميكروفون.')
      return
    }

    const recognizer = createVoiceRecognizer({
      lang: 'ar-SA',
      onTranscript: (text, isFinal) => {
        setInput((prev) => (isFinal ? `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${text}` : prev))
      },
      onEnd: () => {
        setIsListening(false)
        voiceRecognizerRef.current = null
      },
      onError: (message) => {
        setVoiceError(message)
        setIsListening(false)
        voiceRecognizerRef.current = null
      },
    })
    if (!recognizer) {
      setVoiceError('تعذّر بدء التعرف على الصوت.')
      return
    }
    voiceRecognizerRef.current = recognizer
    setIsListening(true)
    recognizer.start()
  }

  // Voice Call mode: a hands-free listen -> send -> speak -> listen again
  // loop, layered on top of the same sendMessage/three-tier fallback used
  // everywhere else -- it does not duplicate any of that logic, it just
  // feeds sendMessage a transcript instead of the composer's input, and
  // speaks whatever answer comes back instead of only rendering it.

  function startCallListening() {
    if (!callModeOpenRef.current) return
    setCallError('')
    setCallStatus('listening')
    const recognizer = createVoiceRecognizer({
      lang: 'ar-SA',
      onTranscript: (text, isFinal) => {
        if (!isFinal || !text.trim()) return
        callRecognizerRef.current?.stop()
        callRecognizerRef.current = null
        setCallStatus('thinking')
        void sendMessage(undefined, text.trim())
      },
      onEnd: () => {
        callRecognizerRef.current = null
      },
      onError: (message) => {
        callRecognizerRef.current = null
        if (callModeOpenRef.current) setCallError(message)
      },
    })
    if (!recognizer) {
      setCallError('تعذّر بدء التعرف على الصوت.')
      return
    }
    callRecognizerRef.current = recognizer
    recognizer.start()
  }

  async function speakCallReply(text: string) {
    if (!callModeOpenRef.current) return
    setCallStatus('speaking')
    try {
      const handle = await voiceOutput.speak(text, {
        lang: 'ar-SA',
        voiceURI: selectedVoiceURI || undefined,
        onEnd: () => {
          callSpeechRef.current = null
          if (callModeOpenRef.current) startCallListening()
        },
        onError: (message) => {
          callSpeechRef.current = null
          if (callModeOpenRef.current) {
            setCallError(message)
            startCallListening()
          }
        },
      })
      callSpeechRef.current = handle
    } catch {
      if (callModeOpenRef.current) startCallListening()
    }
  }

  async function startCall() {
    setCallError('')
    if (!isSpeechRecognitionSupported() || !voiceOutput.isSpeechSynthesisSupported()) {
      setCallError('المكالمة الصوتية غير مدعومة في هذا المتصفح.')
      return
    }
    // Must happen synchronously inside this click handler, before any
    // await -- see voiceOutput.unlock()'s comment. Every speak() call for
    // the rest of the call happens later, from inside async callbacks,
    // and would otherwise be silently swallowed on iOS Safari.
    voiceOutput.unlock()
    const granted = await requestMediaPermission('microphone')
    if (!granted) {
      setCallError('تم رفض إذن الميكروفون.')
      return
    }
    callModeOpenRef.current = true
    setCallModeOpen(true)
    voiceOutput.listVoicesForLang('ar').then(setAvailableVoices)
    startCallListening()
  }

  function handleVoiceChange(uri: string) {
    setSelectedVoiceURI(uri)
    localStorage.setItem('yahalla_voice_uri', uri)
  }

  function endCall() {
    callModeOpenRef.current = false
    callRecognizerRef.current?.stop()
    callRecognizerRef.current = null
    callSpeechRef.current?.cancel()
    callSpeechRef.current = null
    setCallModeOpen(false)
  }

  function stopCameraStream() {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop())
    cameraStreamRef.current = null
  }

  async function openCamera() {
    setCameraError('')
    setCapturedImage(null)
    // Defensive: stop any stream left over from a previous attempt before
    // requesting a new one. Repeated taps on the camera button (e.g. after
    // a black-screen attempt, or Retake -> Capture cycles) could otherwise
    // accumulate live MediaStreams that never got released, which on
    // several mobile browsers manifests as the tab itself crashing under
    // memory/hardware pressure rather than a clean error.
    stopCameraStream()
    // A single getUserMedia call -- it prompts for permission itself, so
    // a separate requestMediaPermission pre-check (as microphone/voice
    // input use) would mean opening and immediately stopping one stream
    // just to open a second one right after, which on several mobile
    // browsers leaves the camera hardware in a brief "still releasing"
    // state and produces a genuinely black <video> even though playback
    // technically starts. One call avoids that race entirely.
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    } catch {
      try {
        // 'environment' has nothing to match on most laptops/desktops
        // (no rear camera) -- retry with no facing preference so the
        // single available webcam still works instead of failing outright.
        stream = await navigator.mediaDevices.getUserMedia({ video: true })
      } catch {
        setCameraError('تم رفض إذن الكاميرا أو تعذّر الوصول إليها.')
        return
      }
    }
    cameraStreamRef.current = stream
    setCameraOpen(true)
    // The <video> element only exists once cameraOpen renders it --
    // assign the stream on the next tick rather than racing the render.
    // Some browsers (notably iOS Safari) don't reliably autoplay a
    // srcObject assigned this way without an explicit play() call.
    setTimeout(() => {
      const video = videoRef.current
      if (!video) return
      video.srcObject = stream
      video.play().catch(() => {})
    }, 0)
  }

  function stopGestureDetector() {
    gestureDetectorRef.current?.stop()
    gestureDetectorRef.current = null
    setGestureEnabled(false)
  }

  async function toggleGesture() {
    if (gestureEnabled) {
      stopGestureDetector()
      return
    }
    setGestureError('')
    if (!isGestureControlSupported() || !videoRef.current) {
      setGestureError('التحكم بالإيماءات غير مدعوم على هذا الجهاز.')
      return
    }
    setGestureLoading(true)
    const detector = await createBlinkDetector(
      () => capturePhoto(),
      (message) => {
        setGestureError(message)
        stopGestureDetector()
      },
    )
    setGestureLoading(false)
    if (!detector) return
    gestureDetectorRef.current = detector
    detector.attach(videoRef.current)
    setGestureEnabled(true)
  }

  function capturePhoto() {
    const video = videoRef.current
    if (!video || video.videoWidth === 0) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0)
    setCapturedImage(canvas.toDataURL('image/jpeg', 0.85))
    stopCameraStream()
    stopGestureDetector()
  }

  function retakePhoto() {
    setCapturedImage(null)
    openCamera()
  }

  function closeCamera() {
    stopCameraStream()
    stopGestureDetector()
    setCameraOpen(false)
    setCapturedImage(null)
  }

  function attachCapturedPhoto() {
    if (capturedImage) setPendingImage(capturedImage)
    closeCamera()
  }

  async function sendMessage(event?: FormEvent, voiceText?: string) {
    event?.preventDefault()
    const typed = (voiceText ?? input).trim()
    if ((!typed && attachedFiles.length === 0 && !pendingImage) || sending) return

    // Attached files are read client-side (never uploaded anywhere on
    // their own) and folded into the same text sent to whichever tier
    // answers -- there is no separate "file" concept the runtimes
    // understand, just more context in the message.
    const fileContext = attachedFiles
      .map((f) => `\n\n--- attached file: ${f.name} ---\n\`\`\`\n${f.content}\n\`\`\``)
      .join('')
    // No vision-capable model is connected in any tier yet -- saying so
    // explicitly in the prompt itself keeps the model from guessing at or
    // hallucinating a description of a photo it structurally cannot see,
    // the same honesty rule as browserRuntime's system prompt.
    const imageContext = pendingImage
      ? '\n\n[User attached a photo. No vision-capable model is connected in this build -- you cannot see or describe its contents. Say so plainly if asked about it.]'
      : ''
    const message = (typed || `(${attachedFiles.length + (pendingImage ? 1 : 0)} attachment(s), no message)`) + fileContext + imageContext
    const attachmentsForDisplay = attachedFiles.map((f) => ({ name: f.name, size: f.size }))

    if (!voiceText) setInput('')
    setAttachedFiles([])
    setAttachmentError('')
    setPendingImage(null)
    setError('')

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: message,
      createdAt: new Date(),
      attachments: attachmentsForDisplay.length > 0 ? attachmentsForDisplay : undefined,
      imageDataUrl: pendingImage ?? undefined,
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
      let usedCloudBoostModel: string | undefined

      // Shared by both the explicit Cloud Boost toggle and the automatic
      // fallback below -- recent history as plain {role, content} turns
      // (the cloud tier has no tool access and no memory of its own, it
      // only ever sees what's in this one request).
      async function callCloudBoost(): Promise<ChatResponse> {
        // Only include assistant turns Cloud Boost itself produced
        // (viaCloudBoost set) -- otherwise, switching to Cloud Boost mid-
        // conversation feeds the 70B model another tier's prior replies
        // as if they were its own. Observed live: after the small
        // browser-tier model got stuck repeating a broken, language-
        // mixed denial, turning Cloud Boost on made the 70B model
        // continue that same broken pattern, because it saw those
        // garbled turns in its own history and continued the style.
        // User turns are always real regardless of which tier answered.
        const history = messages
          .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.viaCloudBoost))
          .slice(-20)
          .map((m) => ({ role: m.role, content: m.content }))
        const cloudResult = await platformApi.cloudTierChat([
          { role: 'system', content: CLOUD_BOOST_SYSTEM_PROMPT },
          ...history,
          { role: 'user', content: message },
        ])
        if (cloudResult.ok) {
          usedCloudBoostModel = cloudResult.model
          return { success: true, answer: cloudResult.content, conversation_id: conversationId ?? undefined }
        }
        return { success: false, error: cloudResult.error }
      }

      // Dispatches this message as a real task to a paired, online device
      // (see RemoteAccessCard/local-runtime's taskPoller) and polls until
      // it finishes -- the same request/response shape as a normal chat
      // reply, just executed with real file/git/GitHub tool access on
      // whichever machine is paired, not in this browser tab.
      async function callDeviceTask(): Promise<ChatResponse> {
        const created = await platformApi.createDeviceTask(message)
        if (!created.ok) return { success: false, error: created.error }
        const taskId = created.task.id
        const deadline = Date.now() + 120_000
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000))
          const task = await platformApi.getTask(taskId)
          if (!task) continue
          if (task.status === 'completed') {
            return {
              success: true,
              answer: task.output?.answer || 'Done.',
              executed_tools: task.output?.executedTools?.map((t, i) => ({ ...t, execution_id: `${taskId}:${i}` })),
              conversation_id: conversationId ?? undefined,
            }
          }
          if (task.status === 'failed') {
            return { success: false, error: task.error || 'The paired device could not complete this task.' }
          }
          // queued/running -- keep polling
        }
        return {
          success: false,
          error: 'Timed out waiting for the paired device (2 minutes). It may still finish -- check the Devices page.',
        }
      }

      if (deviceTaskEnabled && platformApi.isPlatformApiConfigured()) {
        setRuntimeTier('device')
        result = await callDeviceTask()
      } else if (cloudBoostEnabled && platformApi.isPlatformApiConfigured()) {
        // Deliberate escalation, not a fallback: still tries this even if
        // local-runtime/browser would also work, because the user
        // explicitly asked for the stronger model this turn.
        result = await callCloudBoost()
      } else if (runtimeHealth?.llm_reachable) {
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
      } else if (platformApi.isPlatformApiConfigured()) {
        // Neither on-device tier exists here -- most commonly iOS Safari,
        // which has no WebGPU (navigator.gpu is simply absent there) and
        // no local-runtime app installed. Rather than falling straight to
        // the legacy pre-local-first Supabase path (which requires a
        // manually-marked-online model row and, in practice, usually just
        // errors with "No AI model is currently online"), use the same
        // opt-in cloud tier automatically -- still opt-in at the
        // deployment level (an admin has to have saved a key in Settings
        // for this to do anything but 503), just not something a phone
        // user without WebGPU has to remember to toggle by hand every time.
        setRuntimeTier('cloud')
        result = await callCloudBoost()
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
          viaCloudBoost: usedCloudBoostModel,
        }
        setMessages((prev) => [...prev, assistantMessage])
      }

      const newArtifacts = extractArtifacts(finalMessageId, assistantContent)
      if (newArtifacts.length > 0) setActiveArtifactId(newArtifacts[newArtifacts.length - 1]!.id)

      // Voice Call mode: this message originated from the call's own
      // listen loop (voiceText set), so speak the reply and, once done,
      // start listening for the next turn -- see speakCallReply/
      // startCallListening above. A message sent normally through the
      // composer while a call happens to be open is never spoken.
      if (voiceText && callModeOpenRef.current) {
        void speakCallReply(assistantContent)
      }

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
              {runtimeTier === 'device' && 'Remote Device · real file/git/GitHub access'}
              {runtimeTier === null && 'AI Orchestrator · Online'}
            </div>
          </div>
          {runtimeTier && runtimeTier !== 'local' && runtimeTier !== 'device' && (
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
                  {message.attachments && message.attachments.length > 0 && (
                    <div className="attachment-chips">
                      {message.attachments.map((f) => (
                        <span key={f.name} className="attachment-chip static">
                          <FileText size={12} />
                          {f.name}
                        </span>
                      ))}
                    </div>
                  )}
                  {message.imageDataUrl && (
                    <img className="message-image" src={message.imageDataUrl} alt="Attached" />
                  )}
                  <div className={`message-bubble ${message.error ? 'message-error' : ''} ${message.id === streamingMessageId ? 'streaming' : ''}`}>
                    {message.content}
                  </div>
                  {message.viaCloudBoost && (
                    <div className="task-chip cloud-boost-chip" title="Answered by the opt-in cloud smart tier -- this message left your device.">
                      <Sparkles size={12} />
                      Cloud Boost · {message.viaCloudBoost}
                    </div>
                  )}
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

          {attachmentError && <div className="composer-error">{attachmentError}</div>}

          {(attachedFiles.length > 0 || pendingImage) && (
            <div className="attachment-chips">
              {pendingImage && (
                <span className="attachment-chip image-chip">
                  <img src={pendingImage} alt="Captured" />
                  Photo attached (no vision model connected)
                  <button type="button" onClick={() => setPendingImage(null)} title="Remove">
                    <X size={11} />
                  </button>
                </span>
              )}
              {attachedFiles.map((f) => (
                <span key={f.name} className="attachment-chip">
                  <FileText size={12} />
                  {f.name}
                  <button type="button" onClick={() => removeAttachment(f.name)} title="Remove">
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {voiceError && <div className="composer-error">{voiceError}</div>}
          {cameraError && <div className="composer-error">{cameraError}</div>}

          {callModeOpen && (
            <div className="camera-modal">
              <div className="camera-modal-inner call-modal-inner">
                <div className={`call-orb ${callStatus}`}>
                  {callStatus === 'listening' && <Mic size={28} />}
                  {callStatus === 'thinking' && <Sparkles size={28} />}
                  {callStatus === 'speaking' && <Phone size={28} />}
                </div>
                <div className="call-status-text">
                  {callStatus === 'listening' && 'يستمع…'}
                  {callStatus === 'thinking' && 'يفكر…'}
                  {callStatus === 'speaking' && 'يتحدث…'}
                </div>
                {callError && <div className="composer-error">{callError}</div>}
                {availableVoices.length > 0 && (
                  <select
                    className="chat-select"
                    value={selectedVoiceURI}
                    onChange={(e) => handleVoiceChange(e.target.value)}
                    style={{ marginTop: 10 }}
                  >
                    <option value="">Default voice</option>
                    {availableVoices.map((v) => (
                      <option key={v.voiceURI} value={v.voiceURI}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                )}
                <div className="camera-modal-actions">
                  <button type="button" className="secondary-button" onClick={endCall}>
                    <PhoneOff size={14} /> End Call
                  </button>
                </div>
              </div>
            </div>
          )}

          {cameraOpen && (
            <div className="camera-modal">
              <div className="camera-modal-inner">
                {capturedImage ? (
                  <img src={capturedImage} alt="Captured preview" />
                ) : (
                  // eslint-disable-next-line jsx-a11y/media-has-caption
                  <video ref={videoRef} autoPlay playsInline muted />
                )}
                {!capturedImage && isGestureControlSupported() && (
                  <label className="gesture-toggle">
                    <input type="checkbox" checked={gestureEnabled} disabled={gestureLoading} onChange={toggleGesture} />
                    {gestureLoading ? 'Loading gesture model…' : gestureEnabled ? 'Blink to capture · ON' : 'Blink to capture (hands-free)'}
                  </label>
                )}
                {gestureError && <div className="composer-error">{gestureError}</div>}
                <div className="camera-modal-actions">
                  {capturedImage ? (
                    <>
                      <button type="button" className="secondary-button" onClick={retakePhoto}>
                        <RotateCcw size={14} /> Retake
                      </button>
                      <button type="button" className="primary-button" onClick={attachCapturedPhoto}>
                        <Check size={14} /> Use photo
                      </button>
                    </>
                  ) : (
                    <button type="button" className="primary-button" onClick={capturePhoto}>
                      <Camera size={14} /> Capture
                    </button>
                  )}
                  <button type="button" className="secondary-button" onClick={closeCamera}>
                    <X size={14} /> Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          <form className="composer" onSubmit={sendMessage}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => handleFileSelect(e.target.files)}
            />
            <button type="button" className="composer-icon attach" onClick={() => fileInputRef.current?.click()} title="Attach a text/code file">
              <Paperclip size={18} />
            </button>
            <button
              type="button"
              className={`composer-icon mic ${isListening ? 'listening' : ''}`}
              onClick={toggleVoiceInput}
              title={isListening ? 'Stop voice input' : 'Voice input'}
            >
              {isListening ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
            <button type="button" className="composer-icon camera" onClick={openCamera} title="Take a photo">
              <Camera size={18} />
            </button>
            {isSpeechRecognitionSupported() && voiceOutput.isSpeechSynthesisSupported() && (
              <button type="button" className="composer-icon call" onClick={startCall} title="Start a hands-free voice call">
                <Phone size={18} />
              </button>
            )}
            {platformApi.isPlatformApiConfigured() && (
              <button
                type="button"
                className={`composer-icon cloud-boost ${cloudBoostEnabled ? 'active' : ''}`}
                onClick={() => setCloudBoostEnabled((v) => !v)}
                title={
                  cloudBoostEnabled
                    ? 'Cloud Boost is ON -- this message will be sent to the opt-in cloud 70B tier'
                    : 'Cloud Boost (off) -- click to send the next message to the opt-in cloud 70B tier'
                }
              >
                <Sparkles size={18} />
              </button>
            )}
            {platformApi.isPlatformApiConfigured() && (
              <button
                type="button"
                className={`composer-icon device-task ${deviceTaskEnabled ? 'active' : ''}`}
                onClick={() => setDeviceTaskEnabled((v) => !v)}
                title={
                  deviceTaskEnabled
                    ? 'Remote Device is ON -- this message will run as a real task on your paired device'
                    : 'Remote Device (off) -- click to run the next message as a real task on a paired device (Devices page)'
                }
              >
                <Zap size={18} />
              </button>
            )}
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
