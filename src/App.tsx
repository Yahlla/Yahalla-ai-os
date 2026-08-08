import { useState } from 'react'

function App() {
  const [message, setMessage] = useState('')

  return (
    <div className="min-h-screen bg-[#0b0d10] text-white">
      <div className="flex min-h-screen">
        <aside className="w-64 border-r border-white/10 bg-[#101318] p-4">
          <div className="mb-8 text-xl font-semibold">Yahalla AI</div>

          <nav className="space-y-2 text-sm">
            <button className="w-full rounded-lg bg-white/10 px-4 py-3 text-left">
              💬 Chat
            </button>
            <button className="w-full rounded-lg px-4 py-3 text-left hover:bg-white/5">
              🤖 Agents
            </button>
            <button className="w-full rounded-lg px-4 py-3 text-left hover:bg-white/5">
              🧠 Memory
            </button>
            <button className="w-full rounded-lg px-4 py-3 text-left hover:bg-white/5">
              📚 Knowledge
            </button>
            <button className="w-full rounded-lg px-4 py-3 text-left hover:bg-white/5">
              🔌 Tools
            </button>
            <button className="w-full rounded-lg px-4 py-3 text-left hover:bg-white/5">
              🔐 Permissions
            </button>
            <button className="w-full rounded-lg px-4 py-3 text-left hover:bg-white/5">
              📋 Tasks
            </button>
            <button className="w-full rounded-lg px-4 py-3 text-left hover:bg-white/5">
              ⚙️ Settings
            </button>
          </nav>
        </aside>

        <main className="flex flex-1 flex-col">
          <header className="flex h-16 items-center justify-between border-b border-white/10 px-6">
            <div>
              <h1 className="font-semibold">Yahalla AI</h1>
              <p className="text-xs text-white/40">AI Control Center</p>
            </div>

            <div className="text-sm text-white/60">Owner</div>
          </header>

          <section className="flex flex-1 flex-col items-center justify-center px-6">
            <div className="mb-10 text-center">
              <h2 className="text-4xl font-semibold">How can I help?</h2>
              <p className="mt-3 text-white/50">
                تحدث مع Yahalla AI أو أعطه مهمة لتنفيذها.
              </p>
            </div>

            <div className="w-full max-w-3xl">
              <div className="rounded-2xl border border-white/10 bg-[#15191f] p-3 shadow-2xl">
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="اكتب أمرك هنا..."
                  className="min-h-32 w-full resize-none bg-transparent p-3 text-base outline-none placeholder:text-white/30"
                />

                <div className="flex items-center justify-between border-t border-white/10 pt-3">
                  <span className="text-xs text-white/30">
                    العربية · Deutsch
                  </span>

                  <button
                    type="button"
                    className="rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-black hover:bg-white/90"
                  >
                    Send
                  </button>
                </div>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  )
}

export default App
