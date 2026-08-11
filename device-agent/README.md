# Yahalla Device Agent

Runs on your own Mac/Windows/Linux machine and executes the tools that need
real local filesystem/git/command access (`read_project_file`,
`write_project_file`, `patch_project_file`, `list_project_files`,
`git_status`, `git_diff`, `run_project_command`). The Yahalla Control
Center and Supabase never run these themselves — Supabase Edge Functions
are stateless and have no project filesystem to work against, which is why
this agent exists.

Nothing here needs a VPS or any Yahalla-owned server: this process *is* the
execution environment, wherever you start it.

## One-time setup

```sh
cd device-agent
npm install
npm run build
npm run pair    # or: node dist/index.js pair
```

You'll be asked for:
- The pairing code shown on the Control Center's **Devices** page (click
  "Connect this device").
- Your Supabase URL and anon key (the same `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY` the web app uses — not secret, safe to paste).
- The local directory this device should treat as the project root. Tools
  can only ever read/write inside this directory (see Security below).

This writes `~/.yahalla/agent.json` (mode `0600`) containing this device's
own scoped Supabase session — a dedicated identity created just for this
device, never your own login and never the project's service role key.

## Running

```sh
npm start   # or: node dist/index.js start
```

This is the only step that needs to happen more than once, and it doesn't
need to happen manually — set it to start automatically at login (below)
and day-to-day use never touches a terminal again.

## Autostart (so this isn't a manual step every time)

**macOS** — a ready-to-run installer, not just a template to copy by hand:

```sh
npm run pair            # if you haven't already
sh scripts/install-macos-autostart.sh
```

This copies `launchd/de.yahalla.agent.plist` into `~/Library/LaunchAgents/`
(substituting in this checkout's actual path — no manual path editing),
`launchctl bootstrap`s it for your user (not root, not system-wide), and
enables `RunAtLoad` + `KeepAlive`. `scripts/run-agent.sh` locates your
`node` binary itself (nvm/Homebrew/system — launchd doesn't read your shell
profile, which is the usual reason a hand-written plist silently fails to
start), so you don't need to hardcode a node path.

- Logs: `device-agent/logs/agent.out.log` and `agent.err.log`
- Status: `launchctl print gui/$(id -u)/de.yahalla.agent`
- Stop temporarily: `launchctl bootout gui/$(id -u)/de.yahalla.agent`
- Remove entirely: `sh scripts/uninstall-macos-autostart.sh` (device stays
  paired — this only removes the autostart registration)

**Linux (systemd --user)** — `~/.config/systemd/user/yahalla-agent.service`:
```ini
[Unit]
Description=Yahalla Device Agent

[Service]
ExecStart=/usr/bin/node /absolute/path/to/device-agent/dist/index.js start
Restart=always

[Install]
WantedBy=default.target
```
Then: `systemctl --user enable --now yahalla-agent`

**Windows** — Task Scheduler: create a task triggered "At log on", action
`node.exe C:\path\to\device-agent\dist\index.js start`, "Run whether user
is logged on or not" if you want it before login too.

Packaging this as a signed one-click installer (.dmg/.exe) is future work —
it needs code-signing credentials this repo doesn't have. The steps above
are what a future installer would automate.

## Security model

- **Identity**: each paired device gets its own Supabase Auth identity, not
  your login and not the service role key. Row-Level Security scopes it to
  only the task/tool rows explicitly assigned to this device (see
  `current_device_id()` in `supabase/migrations/20260811100000_device_execution.sql`).
- **Filesystem sandbox** (`src/tools/sandbox.ts`): every file tool resolves
  paths against the configured project root and rejects absolute paths,
  `..` traversal, and symlink escapes (verified via `realpath` on the
  nearest existing ancestor). This is enforced in code, not just convention
  — see the tool's own test run in the PR/commit that introduced it.
- **Command execution** (`src/tools/run_command.ts`): `run_project_command`
  only ever spawns an exact allowlisted binary+subcommand
  (`git`, `npm install/run/test/ci`, `node`, `npx`, `tsc`) with
  `shell: false` — arguments are passed as an argv array, never through a
  shell, so there is no shell-injection surface. A 120s timeout and output
  size cap apply to every invocation.
- **Not a full OS sandbox**: this agent does not run commands in a
  container, seccomp profile, or chroot. `node`/`npx` running arbitrary
  project scripts can still do anything your OS user account can do. The
  allowlist and no-shell rule stop injection and out-of-scope commands;
  they don't stop a malicious script that's already an allowed dependency
  from doing something bad. Only pair a device to a project you trust.
- **Offline handling**: if this process stops, the Supabase-side reaper
  (`reap_stalled_tasks()`, on a 5-minute `pg_cron` schedule) notices the
  stale heartbeat, marks the device offline, and requeues any task that was
  waiting on it — the task resumes automatically next time this agent
  starts, rather than being silently lost or reported as still running.
