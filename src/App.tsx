import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from './lib/supabase'
import { signIn, signOut } from './lib/auth'

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
    <main className="flex min-h-screen items-center justify-center bg-[#0b0d10] px-6 text-white">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mb-4 text-3xl font-semibold">Yahalla AI</div>
          <h1 className="text-2xl font-semibold">Welcome back</h1>
          <p className="mt-2 text-sm text-white/50">
            Anmeldung beim Yahalla AI Control Center
          </p>
        </div>

        <form
          onSubmit={handleLogin}
          className="rounded-2xl border border-white/10 bg-[#15191f] p-6 shadow-2xl"
        >
          <label className="mb-2 block text-sm text-white/70">E-Mail</label>

          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            className="mb-5 w-full rounded-xl border border-white/10 bg-[#0f1216] px-4 py-3 outline-none focus:border-white/30"
            placeholder="name@example.com"
          />

          <label className="mb-2 block text-sm text-white/70">Passwort</label>

          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            className="mb-5 w-full rounded-xl border border-white/10 bg-[#0f1216] px-4 py-3 outline-none focus:border-white/30"
            placeholder="••••••••"
          />

          {error && (
            <div className="mb-5 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-white px-4 py-3 font-medium text-black transition hover:bg-white/90 disabled:opacity-50"
          >
            {loading ? 'Anmeldung läuft…' : 'Anmelden'}
          </button>
        </form>

        <div className="mt-6 text-center text-xs text-white/30">
          العربية · Deutsch
        </div>
      </div>
    </main>
  )
}

function ControlCenter({
  email,
  onLogout,
}: {
  email: string
  onLogout: () => void
}) {
  return (
    <div className="min-h-screen bg-[#0b0d10] text-white">
      <div className="flex min-h-screen">
        <aside className="w-64 border-r border-white/10 bg-[#101318] p-4">
          <div className="mb-8 text-xl font-semibold">Yahalla AI</div>

          <nav className="space-y-2 text-sm">
            {[
              '💬 Chat',
              '🤖 Agents',
              '🧠 Memory',
              '📚 Knowledge',
              '🔌 Tools',
              '🔐 Permissions',
              '📋 Tasks',
              '⚙️ Settings',
            ].map((item, index) => (
              <button
                key={item}
                className={`w-full rounded-lg px-4 py-3 text-left ${
                  index === 0
                    ? 'bg-white/10'
                    : 'hover:bg-white/5'
                }`}
              >
                {item}
              </button>
            ))}
          </nav>
        </aside>

        <main className="flex flex-1 flex-col">
          <header className="flex h-16 items-center justify-between border-b border-white/10 px-6">
            <div>
              <h1 className="font-semibold">Yahalla AI</h1>
              <p className="text-xs text-white/40">AI Control Center</p>
            </div>

            <div className="flex items-center gap-4">
              <span className="text-sm text-white/60">{email}</span>

              <button
                onClick={onLogout}
                className="rounded-lg border border-white/10 px-3 py-2 text-sm hover:bg-white/5"
              >
                Abmelden
              </button>
            </div>
          </header>

          <section className="flex flex-1 flex-col items-center justify-center px-6">
            <div className="text-center">
              <h2 className="text-4xl font-semibold">
                Yahalla AI Control Center
              </h2>

              <p className="mt-3 text-white/50">
                Du bist als Owner angemeldet.
              </p>

              <div className="mt-8 rounded-2xl border border-white/10 bg-[#15191f] px-8 py-6">
                <div className="text-sm text-white/40">
                  System Status
                </div>

                <div className="mt-2 text-lg text-green-400">
                  ● Authentication Online
                </div>
              </div>
            </div>
          </section>
        </main>
      </div>
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
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })

    return () => subscription.unsubscribe()
  }, [])

  async function handleLogout() {
    await signOut()
    setUser(null)
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#0b0d10] text-white">
        <div className="text-white/50">Loading Yahalla AI…</div>
      </main>
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
