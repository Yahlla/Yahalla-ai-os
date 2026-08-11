# Yahalla AI desktop shell

A one-click installer for local-runtime: no npm, no git, no terminal for the
person installing it. Launches the local Agent Runtime as a child process
(bound to 127.0.0.1 only) and loads the Control Center against it. This
window and the AI it talks to both run entirely on the machine it's
installed on -- nothing here reaches a cloud LLM or opens a tunnel.

## How the pieces fit together

- `local-runtime` picks a model tier (1.5B/3B/7B) based on the actual
  device's RAM/CPU (`src/hardware.ts` in that package) and runs it via
  `llama-server`, entirely on-device.
- `desktop` (this package) is just the shell: an Electron window plus the
  glue to start/stop the local-runtime process and hand its connection
  info to the existing React frontend, unmodified.
- Because Strato/platform-api never runs inference, this scales to any
  number of users at flat server cost -- every additional user's model
  runs on their own machine, not the shared coordination server.

## Building a real installer

Electron's own binary download (and electron-builder's) needs
unrestricted network access most sandboxes don't have. The actual,
verified build path is `.github/workflows/desktop-release.yml`: push a
`desktop-v*` tag (or run the workflow manually from the Actions tab) and
GitHub's own runners -- which do have that access -- produce a `.dmg`
(macOS), `.exe`/nsis installer (Windows), and `.AppImage` (Linux).

To build locally on a machine that *does* have full network access:

```sh
(cd packages/agent-tools && npm install && npm run build)
(cd local-runtime && npm install && npm run build)
npm install && npm run build          # the frontend, from the repo root
(cd desktop && npm install && npm run electron:build)
```

`npm run electron:build` first runs `scripts/stage-resources.mjs`, which
copies the built local-runtime + agent-tools + frontend into
`desktop/resources/` in the exact layout the packaged app expects (see
that script's own comments for why a plain copy isn't enough -- the
`@yahalla/agent-tools` import needs to resolve without the npm workspace
symlink a monorepo checkout provides), then hands off to electron-builder.

## What the installer does *not* bundle yet

`llama-server` (the actual model-serving binary local-runtime spawns)
still needs to be installed separately -- same as the existing
`scripts/setup-local.sh` path (e.g. `brew install llama.cpp` on macOS).
The app detects this itself (`isLlamaServerInstalled()` in
`local-runtime/src/llm.ts`, surfaced on `GET /runtime/status`) rather than
silently failing, but it does not (yet) download or bundle the binary
automatically -- llama.cpp's release asset naming isn't stable enough to
hardcode reliably without live verification against a real network,
which the environment this was built in doesn't have. Bundling a
platform-matched `llama-server` into `extraResources` at CI build time
(where GitHub's runners *do* have real network access) is the natural
next step, tracked separately.

## Dev loop

```sh
cd desktop
npm run electron:dev   # stages resources, then launches the Electron window
```

Set `YAHALLA_DEV_SERVER_URL` to point the window at a running `vite dev`
server instead of the staged static build, for frontend hot-reload.
