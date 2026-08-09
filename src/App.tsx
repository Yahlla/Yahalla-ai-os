import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Bot,
  Brain,
  ChevronRight,
  CircleHelp,
  Cpu,
  Database,
  FileText,
  History,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Paperclip,
  Plus,
  Search,
  Send,
  Settings,
  Shield,
  Sparkles,
  Terminal,
  Wrench,
  X,
  Zap,
} from 'lucide-react'

import { supabase } from './lib/supabase'
import { signIn, signOut } from './lib/auth'

const YAHALLA_AI_FUNCTION =
  `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/yahalla-ai`

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: Date
  taskId?: string
  agent?: string
}

type TestResult = {
  success?: boolean
  task_id?: string
  agent?: {
    key?: string
    name_ar?: string
    name_de?: string
    status?: string
  }
  permissions?: unknown[]
  memory_count?: number
  message?: string
}

function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleLogin(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError('')

    const { error } = await signIn(email, password)

    if (error) {
      setError(error.message)
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

        <h1>Welcome back</h1>

        <p>
          Anmeldung beim Yahalla AI Control Center
        </p>

        <form onSubmit={handleLogin}>
          <label>E-Mail</label>

          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            placeholder="name@example.com"
          />

          <label>Passwort</label>

          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            placeholder="••••••••"
          />

          {error && (
            <div className="error-box">
              {error}
            </div>
          )}

          <button
            className="primary-button login-button"
            disabled={loading}
          >
            {loading ? 'Anmeldung läuft…' : 'Anmelden'}
          </button>
        </form>

        <div className="login-footer">
          <span> العربية </span>
          <span>•</span>
          <span>Deutsch</span>
        </div>
      </div>
    </main>
  )
}

const navigation = [
  { label: 'Chat', icon: MessageSquare },
  { label: 'Agents', icon: Bot },
  { label: 'Memory', icon: Brain },
  { label: 'Knowledge', icon: Database },
  { label: 'Tools', icon: Wrench },
  { label: 'Permissions', icon: Shield },
  { label: 'Tasks', icon: FileText },
  { label: 'Settings', icon: Settings },
]

function ControlCenter({
  email,
  onLogout,
}: {
  email: string
  onLogout: () => void
}) {
  const [active, setActive] = useState('Chat')
  const [mobileOpen, setMobileOpen] = useState(false)

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
  const [showTechnical, setShowTechnical] = useState(false)
  const [lastResult, setLastResult] = useState<TestResult | null>(null)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({
      behavior: 'smooth',
    })
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

    setMessages((current) => [
      ...current,
      userMessage,
    ])

    setSending(true)

    try {
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession()

      if (sessionError) {
        throw new Error(sessionError.message)
      }

      if (!session?.access_token) {
        throw new Error('No active authentication session.')
      }

      const response = await fetch(
        YAHALLA_AI_FUNCTION,
        {
          method: 'POST',
          headers: {
            Authorization:
              `Bearer ${session.access_token}`,
            apikey:
              import.meta.env.VITE_SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message,
          }),
        },
      )

      const result = await response.json()

      if (!response.ok) {
        throw new Error(
          result?.error ||
            `Yahalla AI returned HTTP ${response.status}`,
        )
      }

      setLastResult(result)

      const assistantContent =
        result?.message ||
        'Die Anfrage wurde von Yahalla AI Core angenommen.'

      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: assistantContent,
        createdAt: new Date(),
        taskId: result?.task_id,
        agent: result?.agent?.key,
      }

      setMessages((current) => [
        ...current,
        assistantMessage,
      ])
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Unknown error'

      setError(message)

      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content:
            `حدث خطأ أثناء تنفيذ الطلب: ${message}`,
          createdAt: new Date(),
        },
      ])
    } finally {
      setSending(false)

      setTimeout(() => {
        textareaRef.current?.focus()
      }, 50)
    }
  }

  function newChat() {
    setMessages([
      {
        id: 'welcome-' + Date.now(),
        role: 'assistant',
        content:
          'محادثة جديدة جاهزة. ماذا تريد من Yahalla AI أن يفعل؟',
        createdAt: new Date(),
        agent: 'yahalla-core',
      },
    ])

    setLastResult(null)
    setError('')
    setInput('')
  }

  function handleKeyDown(
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      sendMessage()
    }
  }

  const isChat = active === 'Chat'

  return (
    <div className="app-shell">
      <aside
        className={`sidebar ${
          mobileOpen ? 'mobile-visible' : ''
        }`}
      >
        <div className="sidebar-brand">
          <div className="brand-symbol">
            <Sparkles size={18} />
          </div>

          <div>
            <div className="brand-title">
              Yahalla AI
            </div>

            <div className="brand-subtitle">
              Intelligence OS
            </div>
          </div>

          <button
            className="mobile-close"
            onClick={() => setMobileOpen(false)}
          >
            <X size={18} />
          </button>
        </div>

        <button
          className="new-chat-button"
          onClick={newChat}
        >
          <Plus size={17} />
          <span>New conversation</span>
        </button>

        <div className="nav-label">
          CONTROL CENTER
        </div>

        <nav className="nav-list">
          {navigation.map((item) => {
            const Icon = item.icon
            const selected = active === item.label

            return (
              <button
                key={item.label}
                onClick={() => {
                  setActive(item.label)
                  setMobileOpen(false)
                }}
                className={`nav-item ${
                  selected ? 'active' : ''
                }`}
              >
                <Icon size={17} />

                <span>{item.label}</span>

                {selected && (
                  <ChevronRight
                    size={15}
                    className="nav-arrow"
                  />
                )}
              </button>
            )
          })}
        </nav>

        <div className="sidebar-spacer" />

        <div className="core-status">
          <div className="status-dot" />

          <div>
            <div className="status-title">
              Yahalla Core
            </div>

            <div className="status-text">
              Operational
            </div>
          </div>
        </div>

        <div className="sidebar-user">
          <div className="avatar">
            {email.slice(0, 1).toUpperCase()}
          </div>

          <div className="user-info">
            <div className="user-name">
              Owner
            </div>

            <div className="user-email">
              {email}
            </div>
          </div>

          <button
            onClick={onLogout}
            className="logout-button"
            title="Abmelden"
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>

      {mobileOpen && (
        <div
          className="mobile-overlay"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <main className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="mobile-menu"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={20} />
            </button>

            <div>
              <div className="page-title">
                {active}
              </div>

              <div className="breadcrumb">
                Yahalla AI
                <ChevronRight size={12} />
                Control Center
              </div>
            </div>
          </div>

          <div className="topbar-right">
            <div className="system-pill">
              <span className="status-dot" />
              All systems operational
            </div>

            <button className="icon-button">
              <Search size={18} />
            </button>

            <button className="icon-button">
              <CircleHelp size={18} />
            </button>
          </div>
        </header>

        {isChat ? (
          <section className="chat-page">
            <div className="chat-header">
              <div>
                <div className="chat-agent">
                  <div className="agent-avatar">
                    <Cpu size={20} />
                    <span className="agent-live" />
                  </div>

                  <div>
                    <div className="chat-agent-name">
                      Yahalla Core
                    </div>

                    <div className="chat-agent-status">
                      <span />
                      AI Orchestrator · Online
                    </div>
                  </div>
                </div>
              </div>

              <div className="chat-actions">
                <button
                  className="secondary-button"
                  onClick={newChat}
                >
                  <Plus size={16} />
                  New chat
                </button>

                <button
                  className="icon-button"
                  onClick={() =>
                    setShowTechnical((value) => !value)
                  }
                  title="Technical information"
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

                  <div className="eyebrow">
                    YAHALLA AI CORE
                  </div>

                  <h1>
                    What can I build
                    <br />
                    <span>for Yahalla?</span>
                  </h1>

                  <p>
                    Describe a task, ask a question, or give
                    the Core an instruction.
                  </p>

                  <div className="suggestion-grid">
                    {[
                      'Analysiere mein aktuelles System',
                      'Zeige mir offene Aufgaben',
                      'Prüfe die Yahalla Architektur',
                      'Was soll ich als Nächstes bauen?',
                    ].map((suggestion) => (
                      <button
                        key={suggestion}
                        onClick={() => {
                          setInput(suggestion)
                          textareaRef.current?.focus()
                        }}
                        className="suggestion-card"
                      >
                        <span>{suggestion}</span>
                        <ChevronRight size={15} />
                      </button>
                    ))}
                  </div>
                </div>

                <div className="message-list">
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      className={`message-row ${
                        message.role
                      }`}
                    >
                      {message.role ===
                        'assistant' && (
                        <div className="message-avatar">
                          <Sparkles size={16} />
                        </div>
                      )}

                      <div className="message-content">
                        <div className="message-meta">
                          {message.role === 'user'
                            ? 'You'
                            : 'Yahalla Core'}

                          <span>
                            {message.createdAt.toLocaleTimeString(
                              [],
                              {
                                hour: '2-digit',
                                minute: '2-digit',
                              },
                            )}
                          </span>
                        </div>

                        <div className="message-bubble">
                          {message.content}
                        </div>

                        {message.taskId && (
                          <div className="task-chip">
                            <Zap size={12} />
                            Task accepted
                            <span>
                              {message.taskId.slice(
                                0,
                                8,
                              )}
                            </span>
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
                          Yahalla Core
                          <span>processing</span>
                        </div>

                        <div className="message-bubble typing">
                          <span />
                          <span />
                          <span />
                          <em>
                            Processing request…
                          </em>
                        </div>
                      </div>
                    </div>
                  )}

                  <div ref={messagesEndRef} />
                </div>
              </div>

              <div className="composer-area">
                {error && (
                  <div className="composer-error">
                    {error}
                  </div>
                )}

                {showTechnical &&
                  lastResult && (
                    <details
                      open
                      className="technical-panel"
                    >
                      <summary>
                        <Terminal size={14} />
                        Technical response
                      </summary>

                      <pre>
                        {JSON.stringify(
                          lastResult,
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  )}

                <form
                  className="composer"
                  onSubmit={sendMessage}
                >
                  <button
                    type="button"
                    className="composer-icon"
                  >
                    <Paperclip size={18} />
                  </button>

                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(event) =>
                      setInput(event.target.value)
                    }
                    onKeyDown={handleKeyDown}
                    placeholder="Message Yahalla Core…"
                    rows={1}
                  />

                  <div className="composer-bottom">
                    <div className="composer-hint">
                      <span>
                        Enter to send
                      </span>
                      <span>•</span>
                      <span>
                        Shift + Enter for new line
                      </span>
                    </div>

                    <button
                      type="submit"
                      className="send-button"
                      disabled={
                        sending || !input.trim()
                      }
                    >
                      <Send size={17} />
                    </button>
                  </div>
                </form>

                <div className="composer-disclaimer">
                  Yahalla AI may make mistakes. Review
                  important actions before execution.
                </div>
              </div>
            </div>
          </section>
        ) : (
          <section className="placeholder-page">
            <div className="placeholder-icon">
              {active === 'Agents' ? (
                <Bot />
              ) : active === 'Memory' ? (
                <Brain />
              ) : active === 'Knowledge' ? (
                <Database />
              ) : active === 'Tools' ? (
                <Wrench />
              ) : active === 'Permissions' ? (
                <Shield />
              ) : active === 'Tasks' ? (
                <FileText />
              ) : (
                <Settings />
              )}
            </div>

            <div className="eyebrow">
              YAHALLA AI CONTROL CENTER
            </div>

            <h1>{active}</h1>

            <p>
              This module is connected to the Yahalla AI
              architecture and will be activated in the
              next orchestration phase.
            </p>

            <button
              className="primary-button"
              onClick={() => setActive('Chat')}
            >
              Open AI Chat
              <ChevronRight size={17} />
            </button>
          </section>
        )}
      </main>
    </div>
  )
}

function App() {
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user)
      setLoading(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUser(session?.user ?? null)
      },
    )

    return () => subscription.unsubscribe()
  }, [])

  async function handleLogout() {
    await signOut()
    setUser(null)
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

  if (!user) {
    return <Login />
  }

  return (
    <ControlCenter
      email={user.email ?? ''}
      onLogout={handleLogout}
    />
  )
}

export default App
