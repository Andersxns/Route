# Performance

Route IDE is still an Electron application. It removes work that upstream does
on every start and avoids adding new work, but its memory floor is the same as
VS Code's. It needs 64-bit Windows 10 or later, like upstream.

## What Route IDE changes

| Change | Why it helps |
|---|---|
| The built-in Copilot Chat extension is not packaged | Upstream activates it in every window (`onStartupFinished`). It is by far the largest built-in extension. |
| The `github` extension is not packaged | It activates on `*`, i.e. in every window during startup. |
| `chat.disableAIFeatures` defaults to `true` | Hides the Copilot UI, and the workbench does not initialize the agent host used by the Agents feature. |
| Route AI loads with its view, and its SDK bundle on the first request | Opening the panel runs about 10 KB of extension code; the 600 KB Anthropic/OpenAI bundle loads when you send something. |
| `workbench.startupEditor: none` | The Welcome page is a full editor with walkthrough content, rendered in every new window. |
| Secondary side bar hidden by default | Nothing is rendered on the right until you open it, and Route AI loads only then. |
| `editor.minimap.enabled: false` | One less canvas per editor to repaint while scrolling and typing. |
| Semantic highlighting off in Route Dark | The TypeScript server does not compute semantic tokens. |
| Six fewer built-in extensions | Fewer manifests to read at startup, which shows on hard drives. |
| Chromium locales other than `en-US` are deleted after packaging | Disk space only; Chromium loads a single locale anyway. Set `electronLocales` in `distro.json` to keep more, or to `[]` to keep all. |
| Source maps are deleted after packaging | About 290 MB of disk. They only matter when debugging the editor itself; upstream strips them only on its CI. |

## What it deliberately leaves alone

- **Telemetry code.** It never runs (see the README); deleting it would only
  make every upstream update harder.
- **Workbench loading order.** Workbench contributions are already loaded by
  lifecycle phase. Reordering them means patching code that changes every
  release, so do it only for a contribution that shows up in a measurement.
- **Electron and V8 flags.** Flags such as disabling the GPU trade one
  bottleneck for another, and which one is right depends on the machine. They
  are listed below as per-machine settings instead.

One known piece of dead weight remains: the Copilot SDK runtime
(`@github/copilot-sdk-win32-x64`, 115 MB) is still packaged because upstream's
agent host imports it. The workbench leaves the agent host uninitialized while
AI features are off, so it costs disk space rather than memory. Removing it
needs the kind of deeper patch VSCodium maintains for Copilot.

## Settings for a weak machine

| Setting | When | Cost |
|---|---|---|
| `"disable-hardware-acceleration": true` in argv.json (**Preferences: Configure Runtime Arguments**) | Rendering glitches or a large GPU process on old graphics drivers | All drawing moves to the CPU, which can be slower on a weak CPU |
| `typescript.tsserver.maxTsServerMemory`, e.g. `1536` | 4 GB machines with large TypeScript projects | The TS server restarts at the limit instead of pushing the system into swap; very large projects lose IntelliSense |
| `files.watcherExclude`: `{ "**/node_modules/*/**": true }` | High CPU from the file watcher in big JavaScript repos | Changes inside `node_modules`, e.g. after `npm install`, may not be picked up until the TS server restarts |
| `search.followSymlinks: false` | Search pegs the CPU in pnpm or monorepo layouts | Search skips symlinked folders |
| **Disable (Workspace)** on extensions a project doesn't need | Always | None |

## Measuring

Measure before and after a change; the numbers depend heavily on the machine.

- **Developer: Startup Performance** shows the time spent in each startup phase
  and which extensions activated, and why.
- **Developer: Show Running Extensions** shows activation time per extension.
- **Developer: Open Process Explorer** shows CPU and memory per process:
  window, extension host, GPU, terminals, language servers, file watcher.
- `route-ide --status`, run in a terminal while the app is open, prints the
  same process list.
- Start with `route-ide --disable-extensions` to see what extensions cost.
