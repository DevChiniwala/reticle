# Reticle

Start by detecting which mode to run:

```bash
# Is Reticle already set up in this project?
cat .reticle.json 2>/dev/null || echo "NOT_FOUND"
```

- **`.reticle.json` not found → run Setup (below)**
- **`.reticle.json` found → run Test (further below)**

---

# SETUP MODE

> Run this once per project. Writes config files, installs the SDK, and validates the connection. After setup, every subsequent `/reticle` goes straight to Test mode.

## Step 1 — Run `init`. Ask the user nothing.

```bash
npx @reticlehq/server init
```

That is the setup. It takes a few seconds and it does the whole job: detects the framework, package manager and UI library; registers the MCP server globally with whichever agents are installed; writes the agent verification rule **and the `/reticle` slash command**; installs the SDK pinned to the CLI's version; writes `.reticle.json`; wires the build config — the Vite plugin, or all three Next.js files (`next.config`, the root layout, and the `ReticleDev` component); and generates a **capabilities scaffold** pre-filled with the `data-testid` values it found and the state library it detected.

**Ask the user nothing. Not one question.** Not which framework, not which package manager, not which port, not which editor or MCP client, not whether they have `data-testid` attributes. Every one of those is answerable from the repository you are already sitting in, and `init` answers them itself — from `package.json`, the lockfile, the config files, and which agent CLIs exist on the machine. The people this is built for do not know the answers, and asking is how a two-minute setup became an hour.

If you genuinely cannot determine something, pick the sensible default, say which default you picked in one line, and keep going. A wrong default that gets corrected in ten seconds beats a question that blocks for ten minutes.

**Never ask about the port.** There are two different ports and conflating them is the single most common setup failure:

|  | What it is | Who owns it |
| --- | --- | --- |
| Dev-server port (3000, 5173, 4321, …) | where the app is served | the user's `npm run dev` — Reticle never touches it |
| Bridge port (**4400**) | the daemon ↔ SDK channel | Reticle, and it defaults correctly |

Reticle **attaches** to whatever is already running; it never starts or manages a dev server, so it does not need to know that port. Putting a dev-server port in `.reticle.json`'s `port` field makes the daemon fight the app for it. Leave `port` out unless you are running several apps at once.

**In a monorepo, run it at the repo root anyway.** If the root isn't the app, `init` finds the app under `apps/*` or `packages/*` and wires that instead. If it finds several, it lists them — pick the one the user has been working in (the one their recent edits touch) and say which you picked. Do not put the list to them as a question.

Then read the report. Each line is marked:

| Mark | Meaning                  | What you do                                         |
| ---- | ------------------------ | --------------------------------------------------- |
| `✓`  | applied                  | nothing                                             |
| `·`  | already wired            | nothing                                             |
| `–`  | skipped by a flag        | nothing                                             |
| `⚠`  | needs a human/agent edit | **only these** — the line carries the exact snippet |

**If every line is `✓`, `·` or `–`, skip to Step 4 and validate.** The manual sections below exist for the `⚠` lines only.

Useful flags: `--port N` (only when running several apps at once), `--no-install` (you'll run the package manager yourself), `--no-mcp` (skip agent registration), `--dry-run` (preview).

**What is proven:** Vite + React, Next.js, Remix and Astro each have an app in this repo and a CI gate that drives it — the first two in the `pnpm test:e2e` battery, Remix and Astro in `pnpm test:integration`. Plain HTML and bundled non-Vite apps (CRA, webpack, Parcel) are wired by hand and have **no** app and no gate: they may well work, nothing proves it. The SDK is framework-agnostic and will usually connect elsewhere — but on a Vue, Preact or Svelte app `init` prints an UNVERIFIED line saying which parts work (DOM, network, console, state) and which do not (component names, `file:line`). Repeat that to the user rather than reporting a clean install.

---

## Manual fallback — Configure the MCP server

> **Only if `init` printed `⚠` for the MCP step**, or the user runs an agent `init` doesn't register (it handles Claude Code and Cursor automatically; the rest are below).

There is no single MCP config file all tools share. Each harness has its own file and schema — write only the one the user actually uses.

| Tool | File | Root key | Command format | `type` needed? |
| --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/claude_mcp_config.json` | `mcpServers` | `"command"` + `"args"` split | no |
| OpenCode | `opencode.json` | `mcp` | `"command"` flat array | `"local"` required |
| Codex CLI | `.codex/config.toml` | `[mcp_servers.reticle]` | TOML `command` + `args` | no |
| Cursor | `.cursor/mcp.json` | `mcpServers` | `"command"` + `"args"` split | no |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | `"command"` + `"args"` split | no |
| VS Code | `.vscode/mcp.json` | `"servers"` | `"command"` + `"args"` split | no |
| Zed | `~/.config/zed/settings.json` | `context_servers` | `"command"` + `"args"` split | no |

**Claude Code** (user-level, default)

Register once globally so Reticle is available in every project:

```bash
claude mcp add reticle -s user -- npx @reticlehq/server mcp
```

Confirm with `claude mcp list` — `reticle` should appear. **After adding, restart Claude Code** (or run `/mcp` to refresh) so it picks up the server.

**If the `claude` CLI is unavailable**, fall back to writing `~/.claude/claude_mcp_config.json` (create if missing, merge `"reticle"` if it exists):

```jsonc
{
  "mcpServers": {
    "reticle": {
      "command": "npx",
      "args": ["@reticlehq/server", "mcp"],
    },
  },
}
```

Only write to `.mcp.json` (project root) if the user explicitly asks for project-level registration.

**OpenCode — `opencode.json`** (`type:"local"` required; command is one flat array, no `args`)

```jsonc
{
  "mcp": {
    "reticle": {
      "type": "local",
      "command": ["npx", "@reticlehq/server", "mcp"],
    },
  },
}
```

Verify with `opencode mcp list`.

**Codex CLI — `.codex/config.toml`** (TOML, not JSON)

```toml
[mcp_servers.reticle]
command = "npx"
args    = ["@reticlehq/server", "mcp"]
```

**Cursor — `.cursor/mcp.json`** (same schema as Claude Code, different path)

```jsonc
{
  "mcpServers": {
    "reticle": {
      "command": "npx",
      "args": ["@reticlehq/server", "mcp"],
    },
  },
}
```

**Windsurf — `~/.codeium/windsurf/mcp_config.json`** (global; create if missing)

```jsonc
{
  "mcpServers": {
    "reticle": {
      "command": "npx",
      "args": ["@reticlehq/server", "mcp"],
    },
  },
}
```

**VS Code — `.vscode/mcp.json`** (`"servers"` not `"mcpServers"` — most common mistake)

```jsonc
{
  "servers": {
    "reticle": {
      "command": "npx",
      "args": ["@reticlehq/server", "mcp"],
    },
  },
}
```

MCP tools only appear in Copilot **Agent mode**.

**Zed — `~/.config/zed/settings.json`** (`context_servers` not `mcpServers`)

```jsonc
{
  "context_servers": {
    "reticle": {
      "command": "npx",
      "args": ["@reticlehq/server", "mcp"],
    },
  },
}
```

---

## Step 1b — Stop hook (Claude Code only — skip unless asked)

**Do not add this hook by default.** Killing the daemon after every turn is the most common cause of the "Failed to reconnect to reticle: -32000" error: the daemon is stopped, Claude Code immediately reconnects, and the new daemon sometimes takes longer than expected to boot — the proxy times out and exits with code 1, which Claude Code reports as -32000.

Reticle doesn't need the hook. `reticle_session {action:"yield"}` (mandatory — see Rules) signals turn end in-band, and the server flips the panel to "waiting" automatically if the agent goes quiet.

Only add this if the user explicitly asks for the daemon to stop between turns:

```jsonc
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "npx @reticlehq/server stop --quiet" }],
      },
    ],
  },
}
```

---

## Manual fallback — Install the SDK

> Only if `init` printed `⚠` for the install step (offline, a locked registry, an unusual package manager).

> **Mental model:** The user keeps running their dev server (`npm run dev`) themselves. Reticle embeds a tiny SDK in the app that connects to a local bridge daemon. The agent talks to the daemon over MCP — no Chromium is downloaded or needed for standard agent workflows. Playwright is only required if you explicitly use `--drive` mode.

```bash
npm install --save-dev @reticlehq/react @reticlehq/vite-plugin    # swap npm for the project's package manager
# Next.js instead of Vite? npm install --save-dev @reticlehq/react @reticlehq/next
```

---

## Manual fallback — Wire up the SDK

> Only for the files `init` marked `⚠`. It auto-patches `vite.config.*` and all three Next.js files; it bails to `⚠` when a config's shape isn't one it recognises, and prints the snippet you need on that line.

**Vite + React**

Add the Reticle plugin to `vite.config.ts` — it auto-injects `reticle.connect()` in dev builds:

```ts
// vite.config.ts
import { reticle } from '@reticlehq/vite-plugin';

export default defineConfig({
  plugins: [react(), reticle()], // reticle() is dev-only, dropped from vite build
});
```

Then describe your app's testable surface so the agent knows what to drive (fill in your real values):

```ts
// src/reticle-dev.ts — self-guards on import.meta.env.DEV, so it's a no-op in prod
import { registerCapabilities, registerStore } from '@reticlehq/react';
import { useApp } from './store'; // your zustand/Redux store
if (import.meta.env.DEV) {
  // Register your store(s). This is the highest-value line in this file: it is what lets the agent
  // check what the app BELIEVES, not just what it rendered — the class of bug a screenshot cannot see.
  registerStore('app', useApp); // zustand or Redux: pass the store itself
  registerCapabilities({
    testids: [], // your data-testid values, e.g. ['login-btn', 'submit-form']
    signals: [], // your reticle.signal() names, e.g. ['auth:login']
    stores: ['app'],
  });
}
```

**Registering the store is the step people skip, and it is the one that matters.** Pass the store itself (not `() => store.getState()`) — the store form wires `subscribe` too, so every mutation emits a state diff automatically; the getter form is read-only and silently produces empty diffs.

Which libraries work:

| Library | How |
| --- | --- |
| zustand, Redux, Redux Toolkit | `registerStore('app', store)` — no adapter needed |
| **TanStack Query** | `registerStore('queries', tanstackQueryStore(queryClient))` |
| Jotai | `registerStore('app', jotaiStore(getDefaultStore(), { cart, user }))` |
| XState / Valtio / MobX | `xstateStore(actor)` / `valtioStore(...)` / `mobxStore(...)` |
| Svelte stores | `registerStore('cart', svelteStore(cartStore))` |
| Pinia (Vue) | `registerStore('cart', piniaStore(useCartStore()))` |
| Recoil | `registerStore('app', recoilStore({ cart: cartAtom }, getSnapshot, subscribe))` — see the bridge in [docs/usage.md](docs/usage.md) |
| React Context / useState / useReducer | `useReticleStore('cart', cart)` from `@reticlehq/react/store` |

Register TanStack Query even if you register nothing else: a stale cache served as fresh fires **no network request**, so the network log shows silence and the DOM shows a plausible number — the cache is the only witness. Adapters come from `@reticlehq/browser`.

**You do not need to import this file.** `@reticlehq/vite-plugin` imports `src/reticle-dev.*` by convention, so `init` never has to edit the entry file you own. (Only if you are wiring by hand with `inject: false` do you add `if (import.meta.env.DEV) import('./reticle-dev');` to `src/main.tsx` yourself.)

To emit `reticle.signal()` from app code (components, stores), **never import `reticle` statically** — a top-level `import { reticle } from '@reticlehq/react'` drags the whole dev-only SDK into your production bundle. Funnel signals through a dev-guarded helper so `import.meta.env.DEV` dead-code-eliminates it in prod:

```ts
// src/reticle.ts — import { signal } from './reticle' in your components
export function signal(name: string, data?: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  void import('@reticlehq/react').then(({ reticle }) => reticle.signal(name, data));
}
```

**Next.js (App Router)**

`init` creates this file, wraps `next.config`, and mounts the component for you — all three are `✓` on a normal `create-next-app`. Use this only to extend the generated file (adding `registerStore` / `registerCapabilities`), or if one of the three came back `⚠`.

Create it next to your root layout — `app/reticle-dev.tsx`, or `src/app/reticle-dev.tsx` in a `--src-dir` app:

```ts
'use client';
import { useEffect } from 'react';
export function ReticleDev() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    void import('@reticlehq/react').then(
      ({ reticle, install, registerCapabilities, registerStore }) => {
        install();
        // The bridge requires a pairing token even on localhost. Vite gets it injected by the
        // plugin; on Next it comes from withReticle(), which publishes it as NEXT_PUBLIC_RETICLE_TOKEN.
        // Omit it and the browser logs "bridge refused the connection: authentication failed".
        const token = process.env.NEXT_PUBLIC_RETICLE_TOKEN;
        reticle.connect({ ...(token ? { token } : {}) });
        registerStore('app', useApp); // your store — see the table above for non-zustand libraries
        registerCapabilities({
          testids: [], // your data-testid values
          signals: [], // your reticle.signal() names
          stores: ['app'],
        });
      },
    );
  }, []);
  return null;
}
```

Mount it in `app/layout.tsx` (dev-only):

```tsx
import { ReticleDev } from './reticle-dev';
// inside <body>:
{
  process.env.NODE_ENV === 'development' ? <ReticleDev /> : null;
}
```

Add `@reticlehq/next` → `withReticle` to `next.config.*`. It does two jobs: source mapping (`data-reticle-source`), and publishing the pairing token the connect above needs.

```ts
import { withReticle } from '@reticlehq/next';
export default withReticle(nextConfig);
```

It configures **both** Turbopack and webpack, so it is correct on Next 16 (Turbopack by default) and on Next 15 and earlier. If you are on `@reticlehq/next` older than 2.3.1, `next dev` on Next 16 dies with _"This build is using Turbopack, with a webpack config and no turbopack config"_ — upgrade rather than dropping `withReticle`.

**Other frameworks** — call `reticle.connect()` and `install()` inside a dev guard. Vanilla / HTML: use a dynamic `import('@reticlehq/react')` inside `if (location.hostname === 'localhost')`.

---

## Step 4 — Validate the connection

**The human can see this.** Reticle's HUD is on by default — a glow border round the page, an animated cursor, and a narration line for each action — and any browser Reticle launches itself is visible by default too. Neither needs a flag. Tell the user to keep the tab in view while you drive: watching the agent operate their own app IS the demo, and it is what makes the first two minutes land. (`--headless` hides the launched browser; CI does that automatically. `reticle.connect({ present: false })` turns the HUD off.)

`init` already wrote `.reticle.json`. Verify with:

```bash
cat .reticle.json
```

If setting up manually, write `.reticle.json` to the project root (commit this — `reticle mcp` reads it to pick the right port):

```jsonc
{
  "framework": "vite",
}
```

`framework` is one of `vite`, `next`, `sveltekit`, `astro`, `html`. **Leave `port` out** — it defaults to `4400` and everything just works for a single app.

> **`port` here is the Reticle _bridge_ port — NOT your dev server port.** The bridge is the daemon ↔ SDK channel (default `4400`); your dev server (e.g. 5173) is a separate thing Reticle never touches. Do **not** set `.reticle.json` `port` to your dev-server port — that collides the daemon with your app.
>
> Only set `port` when running **multiple apps at once**, so each gets its own bridge. When you do, set the **same** value in two places or the SDK and daemon never meet:
>
> ```jsonc
> // .reticle.json          →  reticle({ port: 4460 })  in vite.config.ts
> { "framework": "vite", "port": 4460 }
> ```
>
> Pick any free port that is **not** your dev-server port (4460, 4461, …).

Tell the user: **"Run `npm run dev` (your normal dev server) and open the app in your browser."**

Once they confirm the app is open, poll `reticle_sessions()` until your tab appears (the first live call already blocks for the session). You should see a session whose URL matches the app's localhost address.

### No session appeared? Work this checklist in order

Most no-connect cases are one of these. Fastest signal first:

1. **Read the browser console.** The SDK announces its own failures. If you see `[Reticle] could not reach the bridge at ws://localhost:<port> … Is the Reticle daemon running on that port?` — that's a **port mismatch or a dead daemon** (items 2–3), and the message tells you which port the app is dialing. No `[Reticle]` line at all → the SDK never loaded (item 4).
2. **Port match (the #1 manual-setup bug).** The app's bridge port MUST equal the daemon's. Check both:
   - App side: `reticle({ port: N })` in `vite.config.ts` (or `connect({ url: 'ws://localhost:N/reticle' })`) — omitted ⇒ `4400`.
   - Daemon side: `.reticle.json` `"port"` / `RETICLE_PORT` — omitted ⇒ `4400`. They must be the **same number**, and it must **not** be your dev-server port. Simplest fix: remove the port from both and let them default to `4400`.
3. **Is the daemon up on that port?** `npx @reticlehq/server status` lists running daemons + connected sessions. Nothing there ⇒ the agent hasn't launched it yet (restart the agent / `/mcp`), or it's on a different port than the app (item 2).
4. **Is the SDK actually wired + loaded in dev?** `reticle()` present in `vite.config.ts`; for the manual entry, `if (import.meta.env.DEV) import('./reticle-dev')` in `src/main.tsx`. After editing `vite.config.ts` you **must restart `vite`** (config changes need a fresh dev server), then **hard-reload the browser tab**. A production build won't connect — the SDK is dev-only by design.
5. **Still nothing?** See the full [Troubleshooting](#troubleshooting) section (stale `npx` cache, Stop-hook killing the daemon, `-32000`).

---

## Step 5 — Prove it on ONE flow, while the user watches

**Do not stop at "connected".** A connected session is not a result; the user has installed something and seen nothing happen. Drive one flow now, in front of them. This is the whole first impression.

**One flow. Not the app.** The person installing this has an existing project with dozens of flows. An agent that tries to instrument all of them spends ten minutes producing nothing to look at. Pick the single most important flow that completes in a handful of steps — the one a user would do first — say which one you picked in a line, and drive only that.

**You do not need to add `data-testid` anywhere to do this.** `reticle_snapshot` addresses elements by role and name, and it works on an app that has never heard of Reticle. Adding testids is an optimisation for flows you will replay often — it is not a prerequisite, and treating it as one is what turns a two-minute setup into an afternoon.

1. Tell the user: **"Keep the tab visible — you'll see this happen."** The HUD is on by default: a glow border, a moving cursor, and a narration line per step.
2. `reticle_snapshot` → find the elements the flow needs.
3. Walk it with `reticle_act_and_wait`, narrating each step before you take it.
4. `reticle_assert` after each step — that the effect happened, not just that the click dispatched.
5. `reticle_console` + `reticle_network` at the end, for what the DOM does not show.

Then report what you drove and what it produced, with `file:line` for anything broken.

**Only after that flow has run**, tell the user:

> "Reticle is set up, and you just watched it drive <flow>. Type `/reticle` any time to verify a flow after a change — `init` created that command in this project."

**Setup complete — stop here. Do not proceed to Test mode.**

---

---

# TEST MODE

> Runs automatically when `.reticle.json` exists. Connects to the running app, exercises flows, asserts outcomes, and reports what passed and what broke.

## Phase 1 — Connect

Just ran `reticle init` or started the dev server? Block until the app's SDK connects first, so your first real call doesn't lose the race with the WebSocket — just poll **`reticle_sessions()`** (readiness is server-internal now — the first live call blocks until the SDK connects) until your tab appears. Then, with `reticle_sessions()`, there are three possible states:

**A. One session → proceed.**

**B. No sessions:** Tell the user:

> "No app connected. Run your dev server (`npm run dev`) and open the app in your browser, then try `/reticle` again. Reticle never starts the dev server for you — that's your job." Stop here.

**C. Multiple sessions — ask:**

> "I see [N] sessions connected: [list sessionId + url]. Which should I test?"

Pin `sessionId` for every subsequent call.

---

## Phase 2 — Orient

Call these in parallel:

```
reticle_snapshot({ sessionId, mode: "interactive" })
reticle_run({ tool: "reticle_capabilities", args: { sessionId } })   // not advertised in the default hybrid profile — reach it via reticle_run
reticle_network({ sessionId, limit: 10 })
reticle_console({ sessionId, limit: 20 })
```

> **Default `hybrid` profile: 16 tools advertised.** Everything else the skill names — `reticle_capabilities`, `reticle_act_sequence`, `reticle_session {action:"yield"}`, `reticle_session {action:"review"}`, the flow/record tools — is reached with `reticle_run({ tool, args })` (or list its params first with `reticle_tools`). Measured surfaces: `hybrid` 16 tools / ~74k chars, `standard` 33 / ~117k, `full` 46 / ~166k — so the default costs ~55% fewer schema characters than `full`.
>
> **`RETICLE_TOOL_PROFILE` is read by the DAEMON at startup, not by your client.** Setting it in the agent's environment while a daemon is already running changes nothing, and the two profiles then look identical because you are still talking to the old one. Run `npx @reticlehq/server stop` first.

Build a mental model:

- **Route/screen:** where is the app right now?
- **Testids:** what interactive elements are registered?
- **Signals:** what domain events does the app emit?
- **Console state:** any errors already present before touching anything?

Pre-existing console errors → call them out immediately before testing.

---

## Phase 3 — Decide what to test

Check what changed: `git diff HEAD --stat 2>/dev/null | head -20`

Then pick a mode:

| Context                                    | Mode                                             |
| ------------------------------------------ | ------------------------------------------------ |
| User says "test X" or names a flow         | **Targeted** — focus on that feature             |
| User says "everything" or "smoke test"     | **Smoke** — exercise every registered testid     |
| Recent git diff shows a specific component | **Targeted** — that component and adjacent flows |
| No clear signal                            | **Smoke**                                        |

---

## Phase 4 — Run the tests

### Targeted

1. Navigate if needed: `reticle_navigate({ sessionId, url })`
2. Snapshot to confirm correct state
3. Act on controls using testids:
   ```
   reticle_act({ sessionId, ref, action: "click" })
   ```
4. Assert — always use `since` from the act result:
   ```
   reticle_assert({ sessionId, since, timeout_ms: 5000, predicate: { kind: "allOf", predicates: [
     { kind: "net",     method: "POST", urlContains: "/api/...", status: 200 },
     { kind: "element", query: { role: "...", name: "..." }, state: "visible" },
     { kind: "signal",  name: "..." },
     { kind: "console", level: "error", absent: true }
   ]}})
   ```
5. Record: ✅ pass / ❌ fail / ⚠️ partial

### Plan then batch — do NOT ping-pong act-by-act

The repeat loop is cheap (~175 tok); the expensive part is the FIRST drive of a surface you have not seen. Every extra round-trip pays the advertised tool surface again, so the way to make a first drive cheap is fewer, bigger hops — not smaller ones.

**Do this** — state the whole journey, then assert its consequence once:

```
reticle_run({ tool: "reticle_act_sequence", args: { sessionId, steps: [
  { ref: emailRef,    action: "fill",   args: { value: "a@b.com" } },
  { ref: passwordRef, action: "fill",   args: { value: "hunter2"  } },
  { ref: submitRef,   action: "click" }
] }})   // act_sequence is not advertised under the default hybrid profile — hence reticle_run
→ reticle_assert({ sessionId, since, predicate: { kind: "allOf", predicates: [
    { kind: "signal",  name: "auth:granted" },
    { kind: "net",     method: "POST", urlContains: "/api/login", status: 200 },
    { kind: "console", level: "error", absent: true }
  ]}})
```

**Not this** — act, look, act, look:

```
act(fill email) → snapshot → act(fill password) → snapshot → act(click) → snapshot → assert
```

Both verify the same thing. The second costs several times more and gives the model more chances to wander off-plan mid-journey.

**Declare before you act.** Name the consequence you expect _before_ the action, in `until`/`mustHold` — never after seeing the result. An oracle written after the fact can be rationalized into agreeing with whatever happened; one written before cannot. `reticle_act_and_wait({ ref, action, until })` is the one-hop version of exactly this.

**Record the first drive.** If you had to explore to find a journey, save it (`reticle_flow_save`) so the exploration is paid once, ever — every later run replays it deterministically for ~175 tok with no LLM.

### Smoke

Walk every testid in `capabilities.testids`. For each one that is visible and interactable:

```
reticle_query({ sessionId, by: "testid", value: testid })
→ reticle_act({ sessionId, ref, action: "click" })
→ reticle_assert({ since, predicate: { kind: "console", level: "error", absent: true } })
```

Flag anything that throws a console error or triggers a `status >= 400` network call.

### Regression suite (record once, re-verify on every change)

For flows worth re-checking forever — the actual test suite — record them, then re-verify the whole set in ONE deterministic call (no LLM per flow, so it's ~hundreds of tokens, not a full re-drive):

1. Record + assert the business outcome (not just clicks):
   ```
   reticle_record {action:"start"}({ recordingName: "ship-deploy" })
   → drive the flow with reticle_act
   → reticle_annotate({ flow: "ship-deploy", kind: "intent", text: "ship a deploy to production" })
   → reticle_annotate({ flow: "ship-deploy", kind: "success-state", signal: "deploy:shipped" })
   → reticle_record {action:"stop"}({ recordingName: "ship-deploy" }) → reticle_flow_save({ flowName: "ship-deploy" })
   ```
2. After any change, re-verify EVERY saved flow at once:

   ```
   reticle_flow_verify({ sessionId })
   → { status: "pass"|"fail", passed, failed, failures: [{ flow, verdict, whatChanged, whereInSource, nextAction }] }
   ```

   On a failure the envelope tells you exactly what changed, the `file:line`, and the fix (e.g. "rebind to 'new-deploy'") — act on `nextAction` directly. A single flow: `reticle_flow_replay({ flowName })`.

   > **Tool profile (default `hybrid`).** Reticle advertises 16 core verify tools directly and keeps everything else (record/replay/verify/heal, screenshots, network-mock, `act_sequence`, …) one call away behind two meta-tools — ~55% fewer schema characters per turn than `full`. Reach a non-core tool with `reticle_run({ tool: "reticle_flow_verify", args: { sessionId } })`, or `reticle_tools` first to list its params. Want them advertised directly? Set `RETICLE_TOOL_PROFILE=standard` (33 tools) or `=full` (46) **and restart the daemon** — the profile is read at daemon startup, not per client.

### Read program truth in one call — instead of reconstructing it from the DOM

Reticle's edge over a DOM/screenshot tool is **efficiency and robustness**, not that it sees things nothing else can. A capable browser-automation agent _can_ reach app state by running JS in the page (e.g. walking the React fiber via `browser_evaluate`) — but that's fragile (breaks on minified prod builds, non-React stores, framework-internals changes) and costs ~10× the tool-calls/tokens/time. Reticle reads the same truth with **one typed call**, stably:

- **UI-vs-state desync** (the UI shows one value, the store holds another — e.g. a count that didn't refresh, or a value corrupted in the store but rendered in no view): `reticle_state({ sessionId, store, path })` returns it directly. A pure snapshot can't see it; an agent spelunking framework internals can, but at far higher cost — measured head-to-head, Reticle-MCP caught a never-rendered store tamper in **4 tool calls / 45s** where a Playwright-MCP agent needed **45 calls / ~9min** reverse-engineering the React fiber.
- **Present-but-unusable / off-theme controls**: `reticle_inspect` returns `occluded` (covered by an overlay), `styles.cursor`/`opacity`, `box` (0×0), and `theme.offTheme` (color off the design-token palette) — the "is it actually usable / on-brand?" read, in one call.

### Consume the human's bug reports (`reticle_session {action:"review"}`)

The dev can click **"Flag a bug"** in the running app, point at an element, and type what's wrong. Each flag becomes a **mark** you drain with `reticle_session {action:"review"}`:

```
reticle_session {action:"review"}({ sessionId })
→ { marks: [{ id: "m1", note: "this button is misaligned", label: "button \"Pay\"",
              source: { file: "src/Checkout.tsx", line: 42 },
              fix: "Open src/Checkout.tsx:42 and fix: this button is misaligned. Then reticle_session {action:"review"} { resolve: \"m1\" }" }],
    pendingCount: 1 }
```

Check it at the start of a session and whenever the human may have flagged something. Open the `source` file:line, apply the fix the `note` asks for, verify, then `reticle_session {action:"review"}({ resolve: "m1" })`. Reading never consumes a mark, so you can list → fix → verify → resolve.

---

## Phase 5 — Report

Always refer to the tool as **Reticle** in reports, summaries, and messages to the user.

```
## Reticle — <route or feature>

**Result: ✅ PASS / ❌ FAIL / ⚠️ PARTIAL**

| Flow | Result | Evidence |
|---|---|---|
| Login → dashboard | ✅ | POST /api/login 200, route /dashboard |
| Click "Deploy"    | ❌ | POST /api/deploy 401 — missing auth header |
| Sidebar nav       | ✅ | 4 items, no console errors |

**Console errors:** none / <list>
**Failed requests:** none / <list>
**Fix at:** src/lib/api.ts:65   ← from reticle_inspect on the failing element
```

If something failed, call `reticle_inspect({ sessionId, ref })` on the failing element to get the `file:line`, and include it in the report.

---

## Rules (always apply in Test mode)

- **Always close the session when you stop driving.** The human may be watching the browser, so the panel must reflect your real state — never leave it reading "live" when you've stopped. The moment you finish a turn or need the human, call `reticle_session {action:"yield"}({ mode: "waiting" })`, or `reticle_session {action:"yield"}({ mode: "ask", note: "<your question>" })` when you're blocked on them. Call `reticle_session {action:"end"}()` only when the whole task is done. The session revives automatically on your next action, so this is cheap and safe to do every time. (A server-side idle fallback flips the panel to "waiting" if you forget, but signal it yourself — it's immediate and it can say _why_.)
- Always pass `since` in `reticle_assert` — scopes to post-action events, prevents stale buffer fakes.
- Always assert `{ kind: "console", level: "error", absent: true }` — silent errors are the most common thing agents miss.
- Batch net + element + signal + console into one `allOf` — don't call `reticle_assert` four times.
- Never assert on pixels — use predicates, not `reticle_screenshot` (screenshots are for genuinely visual checks only).
- If the session disconnects mid-test (navigation creates a new session ID) — call `reticle_sessions()` again and continue.
- **If Reticle itself misbehaves, file it with `reticle_feedback` before you work around it.** Three things are worth reporting: a tool that returned something wrong or impossible (`kind: "bug"`), something you needed to observe and Reticle simply could not see (`kind: "gap"`), and a verification that ran but left you unable to tell pass from fail (`kind: "ambiguity"`). Write `text` as a root-cause analysis — what you called, what you expected, what you got — and put the call trail in `trace`. Then continue the task; do not retry the failing call just to re-report it. Report defects in **Reticle**, not bugs you found in the app under test: finding those is Reticle working, and they belong in your report to the user.

---

## Troubleshooting

### The `reticle_*` tools disappeared mid-session

The MCP proxy lost its stream to the daemon. From 2.3.1 it reconnects on its own and replays the handshake, so this should heal without anyone doing anything — the daemon stays up across the drop, and `npx @reticlehq/server status` will confirm it (`running:true`).

Read `~/.reticle/mcp-proxy.log` — it records every drop and reconnect with a reason (`sse_ended`, `sse_error`, `connect_error`) and the attempt number. It is the only place this is visible; the disconnect is silent from the agent's side.

If the tools stay gone, the proxy exhausted its reconnect budget (`reticle_mcp_proxy_gave_up` in that log) and only the human can restore them by running `/mcp`. Until then, use the CLI for anything that doesn't need the tools: `npx @reticlehq/server status | doctor | open | drive`.

### Multiple projects / port conflicts

Each project should have its own port in `.reticle.json`. When `reticle mcp` starts, it reads `.reticle.json` in the current working directory and uses that project's port — so agents in different project directories automatically connect to different daemons.

If two projects share the same port, start the second on a different port:

```bash
npx @reticlehq/server stop --port 4400   # stop the other project's daemon if needed
# Then ensure .reticle.json in this project has a unique "port" field
```

Use `npx @reticlehq/server status` to see which daemons are running and which sessions are connected.

### No Chromium / Playwright needed for standard use

Reticle does NOT download Chromium for normal agent workflows. The browser SDK runs inside the user's own browser — the agent sees the DOM, network, console, and state through the WebSocket bridge. Playwright is only installed if you explicitly call `reticle serve --drive <url>` or `reticle verify`, which launch an autonomous browser for unattended automation.

To attach to a browser the user already has open (zero download, zero extra process):

```bash
# Start Chrome with remote debugging enabled (user does this once):
# Mac: /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
# Then set RETICLE_CDP_URL when starting the daemon:
RETICLE_CDP_URL=http://localhost:9222 npx @reticlehq/server mcp
```

This connects Reticle to the existing Chrome — native clicks and screenshots work without Playwright.

### "Failed to reconnect to reticle: -32000"

This means the `reticle mcp` proxy process exited and Claude Code couldn't restart it cleanly. -32000 is the JSON-RPC code for a server-side error; here it means the proxy exited with code 1 before the MCP handshake completed.

**Check version first — stale npx cache is the most common silent culprit.** `npx` caches packages locally and may keep running an old version of `@reticlehq/server` even after a new one is published. An older daemon speaking a different protocol than the new proxy (or vice-versa) causes the proxy to exit immediately and Claude Code to report -32000. Always clear the cache and force-resolve the latest version before investigating anything else:

```bash
npx --yes @reticlehq/server@latest version   # force-resolves latest and prints version
npx @reticlehq/server stop                    # stop any daemon running the old version
```

Then reload Claude Code (`/mcp`) so the new version is picked up on next connection.

**Second common cause: the Stop hook is killing the daemon between turns.** If `~/.claude/settings.json` has a Stop hook running `reticle stop --quiet`, remove it. The daemon must stay alive across turns — killing it forces a cold-boot spawn on every reconnect, and if that spawn takes longer than 10 seconds (cold npx cache, slow disk, first install), the proxy times out and exits with code 1. See Step 1b above.

**Fix (in order):**

1. **Force the latest version and clear the stale daemon:**

   ```bash
   npx --yes @reticlehq/server@latest version
   npx @reticlehq/server stop
   ```

   Reload Claude Code. If -32000 is gone, done.

2. **Check for the Stop hook:** `cat ~/.claude/settings.json | grep reticle` If present, delete that hook entry, then repeat step 1.

3. **If -32000 persists**, the daemon may be crashing on startup. Check the log: `cat ~/.reticle/daemon-4400.log | tail -30` Look for `reticle_daemon_start_failed` or `reticle_mcp_proxy_error`. If the port is taken by another process: `lsof -i :4400` to identify it, then kill it and retry.

4. **Confirm the MCP config is user-level** (not project-level) and has no pinned version:

   ```bash
   cat ~/.claude/claude_mcp_config.json
   # Should contain: {"mcpServers": {"reticle": {"command": "npx", "args": ["@reticlehq/server", "mcp"]}}}
   ```

   If the project has a `.mcp.json` or `.claude/mcp.json` that overrides the user-level config with pinned args (e.g., `["@reticlehq/server@0.x.y", "mcp"]`), rename it out of the way and re-register:

   ```bash
   claude mcp add reticle -s user -- npx @reticlehq/server mcp
   ```

**Tell the user what you found** so they can confirm which fix applies.
