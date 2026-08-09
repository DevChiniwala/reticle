/**
 * Generated file contents and copy-paste snippets for `reticle init`. Kept as named constants/builders
 * so the runner never inlines free strings.
 */

import { RETICLE_DEFAULT_PORT, bridgeWsUrl } from '@reticlehq/core';

/**
 * The connect argument literal: a non-default port adds a `url`, and a projectId is always passed
 * (so the app is identifiable across port changes). Empty string only when neither applies.
 */
function connectArg(port: number | undefined, projectId?: string): string {
  const parts: string[] = [];
  if (port !== undefined && port !== RETICLE_DEFAULT_PORT) {
    parts.push(`url: '${bridgeWsUrl(port)}'`);
  }
  if (projectId !== undefined && projectId.length > 0) parts.push(`projectId: '${projectId}'`);
  return parts.length > 0 ? `{ ${parts.join(', ')} }` : '';
}

/** The Vite-config snippet printed when we can't safely auto-patch the config. */
export function viteManual(port: number | undefined): string {
  const call = port === undefined ? 'reticle()' : `reticle({ port: ${String(port)} })`;
  return `Add the Reticle plugin to your Vite config:

  import { reticle } from '@reticlehq/vite-plugin';

  export default defineConfig({
    plugins: [react(), ${call}],
  });

The plugin only applies during \`vite\` (dev) — it is dropped from \`vite build\`.`;
}

/** Next.js config wrap — always printed (we never auto-rewrite next.config). */
export function nextConfigManual(configFile: string): string {
  return `Wrap your ${configFile} export with withReticle (keeps SWC, dev-only):

  import { withReticle } from '@reticlehq/next';

  export default withReticle(nextConfig);`;
}

/**
 * The dev-only client component that connects Reticle after hydration.
 *
 * The token is not optional. The bridge requires a pairing token even on localhost, and unlike Vite
 * (where the plugin injects it) a Next app has to carry it through `withReticle`, which publishes it
 * as `NEXT_PUBLIC_RETICLE_TOKEN`. This file used to connect with only a projectId, so every Next
 * setup ended at `bridge refused the connection: authentication failed` and no session ever appeared.
 */
export function nextReticleDevFile(
  port: number | undefined,
  projectId?: string,
  testids: readonly string[] = [],
  stores: readonly string[] = [],
): string {
  const base = connectArg(port, projectId);
  const fields = base === '' ? '' : `${base.slice(1, -1).trim()}, `;
  const ids = testids.map((t) => `'${t}'`).join(', ');
  const storeBlock =
    stores.length === 0
      ? '      // No state library detected. If you add one, register it here — see docs/usage.md.'
      : stores.map((h) => `      // import your store, then: ${h}`).join('\n');
  return `'use client';
import { useEffect } from 'react';

/** Dev-only: connect Reticle + install the React adapter, after hydration. */
export function ReticleDev() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    void import('@reticlehq/react').then(({ reticle, install, registerCapabilities }) => {
      install();
      // Both provided by withReticle() in next.config. The bridge rejects a connect with no token;
      // the root makes source paths repo-relative instead of absolute.
      const token = process.env.NEXT_PUBLIC_RETICLE_TOKEN;
      const root = process.env.NEXT_PUBLIC_RETICLE_ROOT;
      reticle.connect({ ${fields}...(token ? { token } : {}), ...(root ? { root } : {}) });

      // ── Start with ONE flow. ──────────────────────────────────────────────────────────────────
      // Registering a store is the highest-value line here: it lets the agent check what the app
      // BELIEVES, not just what it rendered. Pass the STORE, not \`() => store.getState()\` — the store
      // form wires \`subscribe\` too, so every mutation emits a diff; the getter form is read-only.
${storeBlock}
      registerCapabilities({
        testids: [${ids}],${testids.length === 0 ? ' // none found — add data-testid to your key elements' : ''}
        signals: [], // names you pass to reticle.signal()
        stores: [], // the keys you registered above
      });
    });
  }, []);
  return null;
}
`;
}

/**
 * Astro connect instructions.
 *
 * Astro is Vite-based but SSRs its own HTML, so the plugin's index.html injection never fires, and
 * `vite` is not a direct dependency — so this used to fall through to the generic HTML advice, which
 * tells you to add a connect to an "entry module" Astro does not have, or to bundle the SDK with
 * esbuild. Both are wrong for Astro, and following either gets you nothing.
 *
 * Astro bundles a page `<script>`, so the bare import resolves there. The token has to be inlined by
 * the config because there is no plugin in the page's path to inject it, and `build.target` has to be
 * raised or Astro down-levels the modern SDK bundle and dies on a destructuring transform.
 */
export function astroManual(port: number | undefined, projectId?: string): string {
  const extra =
    port !== undefined && port !== RETICLE_DEFAULT_PORT
      ? `\n          url: '${bridgeWsUrl(port)}',`
      : '';
  const id =
    projectId !== undefined && projectId.length > 0 ? `\n          projectId: '${projectId}',` : '';
  return `Astro renders its own HTML, so the connect goes in a page <script> and the pairing token is inlined by the config.

1. In astro.config.mjs — inline the daemon's token and raise the build target:

  import { readFileSync } from 'node:fs';
  import { homedir } from 'node:os';
  import { join } from 'node:path';

  function reticleToken() {
    const dir = process.env['RETICLE_PAIRING_TOKEN_DIR'] || join(homedir(), '.reticle');
    try { return readFileSync(join(dir, 'pairing-token'), 'utf8').trim(); } catch { return ''; }
  }

  export default defineConfig({
    vite: {
      // Astro's default target down-levels the modern SDK bundle and fails on a destructuring transform.
      build: { target: 'es2022' },
      optimizeDeps: { esbuildOptions: { target: 'es2022' } },
      define: {
        __RETICLE_TOKEN__: JSON.stringify(reticleToken()),
        // Without this, source pointers come back as absolute paths from YOUR machine — useless in a
        // report. Every other framework gets it from its build plugin; Astro owns its Vite instance.
        __RETICLE_ROOT__: JSON.stringify(process.cwd()),
      },
    },
  });

2. In your layout (or the page you want instrumented), inside <body>:

  <script>
    if (import.meta.env.DEV) {
      const token = typeof __RETICLE_TOKEN__ !== 'undefined' ? __RETICLE_TOKEN__ : '';
      const root = typeof __RETICLE_ROOT__ !== 'undefined' ? __RETICLE_ROOT__ : '';
      const { reticle, install } = await import('@reticlehq/react');
      install();
      reticle.connect({${id}${extra}
          ...(token.length > 0 ? { token } : {}),
          ...(root.length > 0 ? { root } : {}),
      });
    }
  </script>

Start the daemon BEFORE \`astro dev\`, so the token file exists when the config is read. Until it does the token is empty and the page reloads once the daemon is up.`;
}

/**
 * The app-side dev module the Vite plugin imports by convention.
 *
 * `registerCapabilities` tells the agent what it can drive without guessing; `registerStore` is the
 * one that matters most and the one we cannot write for you — detecting that an app depends on
 * zustand is easy, knowing which module exports the store instance is not, and a wrong import here
 * breaks the module everything else hangs off. So the store lines are generated COMMENTED, naming
 * the libraries actually found in package.json, with the exact call to uncomment.
 */
export function viteDevModuleFile(testids: readonly string[], stores: readonly string[]): string {
  const ids = testids.map((t) => `'${t}'`).join(', ');
  const storeBlock =
    stores.length === 0
      ? '  // No state library detected. If you add one, register it here — see docs/usage.md.'
      : stores.map((h) => `  // import your store, then: ${h}`).join('\n');
  return `// Dev-only. Imported automatically by @reticlehq/vite-plugin — you do not need to import it.
// Self-guards on import.meta.env.DEV, so it is a no-op in a production build.
import { registerCapabilities } from '@reticlehq/react';

if (import.meta.env.DEV) {
  // ── Start with ONE flow. ─────────────────────────────────────────────────────────────────────
  // You do not need to describe the whole app to get value, and trying to is the slow path. Register
  // the store your most important flow reads, and list the testids that flow touches. Add more later,
  // when a flow you actually replay needs them.
  //
  // Registering a store is the highest-value line in this file: it lets the agent check what the app
  // BELIEVES, not just what it rendered — the class of bug a screenshot cannot see. Pass the STORE,
  // not \`() => store.getState()\`: the store form wires \`subscribe\` too, so every mutation emits a
  // state diff; the getter form is read-only and silently produces empty diffs.
${storeBlock}

  registerCapabilities({
    testids: [${ids}],${testids.length === 0 ? ' // none found — add data-testid to your key elements' : ''}
    signals: [], // names you pass to reticle.signal()
    stores: [], // the keys you registered above
  });
}
`;
}

/** Where that module goes. Matches @reticlehq/vite-plugin's convention list. */
export const VITE_DEV_MODULE_PATH = 'src/reticle-dev.ts';

/** Default root-layout path, used when no layout was found on disk (reporting only). */
export const NEXT_LAYOUT_PATH = 'app/layout.tsx';

/** Mount instruction for the root layout. */
export const NEXT_LAYOUT_MANUAL = `Mount <ReticleDev /> in your root layout (app/layout.tsx), dev-only:

  import { ReticleDev } from './reticle-dev';
  // inside <body>:
  {process.env.NODE_ENV === 'development' ? <ReticleDev /> : null}`;

/**
 * Manual connect guidance for projects without a Vite/Next plugin. Most such projects still use a
 * BUNDLER (CRA, webpack, Parcel, Vue/Svelte CLIs) — for those, the connect goes in the entry MODULE,
 * where a bare `@reticlehq/react` import resolves. A bare import in a plain index.html does NOT resolve in
 * the browser, so we never tell a bundled app to do that (the old advice silently failed for CRA).
 */
export function htmlManual(port: number | undefined, projectId?: string): string {
  const arg = connectArg(port, projectId);
  return `No Vite/Next plugin detected — wire the dev-only connect by hand. Pick the form for your setup:

  • Bundled app (Create React App, webpack, Parcel, Vue/Svelte CLI, etc.) — add to your ENTRY module
    (e.g. src/index.js or src/main.js), where '@reticlehq/react' resolves through your bundler:

      if (location.hostname === 'localhost') {
        const { reticle, install } = await import('@reticlehq/react');
        install();
        reticle.connect(${arg});
      }

  • Plain static HTML with no build step — the browser can't resolve the bare '@reticlehq/react' import, so
    bundle the SDK once (e.g. \`npx esbuild\`) and point a dev-only <script type="module"> at the output,
    or serve the page through a dev server (Vite) that resolves bare imports.`;
}

export const NEXT_RETICLE_DEV_PATH = 'app/reticle-dev.tsx';
export const SVELTEKIT_HOOKS_PATH = 'src/hooks.client.ts';

/**
 * Said to the user's face rather than discovered later. React, Next, Remix and Astro each have an
 * app and a CI gate; SvelteKit has neither, so "it generated some wiring" is not evidence it works.
 */
/**
 * Said out loud when the app does not render through React. The SDK is framework-agnostic — DOM,
 * network, console and routing all still work — but `@reticlehq/react` is a React adapter, so
 * component names and source mapping do not, and no CI gate covers this stack. Reporting all-green
 * here is the one thing this project exists not to do.
 */
export function unverifiedUiLibraryNote(library: string): string {
  return `Detected a ${library} app. Reticle's DOM, network, console and state tools work here, but @reticlehq/react is a React adapter: component names and data-reticle-source file:line will be missing, and no CI gate covers ${library}. Gated today: Vite + React, Next.js, Remix, Astro. If something doesn't work, please open an issue.`;
}

export const UNVERIFIED_FRAMEWORK_NOTE =
  'Reticle has no SvelteKit app and no CI gate for one, so this wiring is untested — it may work, but nothing proves it and nothing will tell us if it breaks. Supported and gated today: Vite + React, Next.js, Remix and Astro. If the hook does not register a session, please open an issue.';

/**
 * Dev-only client hook that connects Reticle in a SvelteKit app. SvelteKit renders through app.html and
 * never triggers Vite's index.html injection (verified), so the standard plugin can't auto-connect —
 * a client hook is the reliable path. SvelteKit runs src/hooks.client.ts on the client at startup.
 */
export function svelteKitHooksFile(port: number | undefined, projectId?: string): string {
  const base = connectArg(port, projectId);
  const fields = base === '' ? '' : `${base.slice(1, -1).trim()}, `;
  return `// Dev-only: connect Reticle on the client. SvelteKit renders via app.html, so the Vite-plugin
// index.html injection doesn't fire — connect from this client hook instead.
if (import.meta.env.DEV) {
  void import('@reticlehq/react').then(({ reticle, install }) => {
    install();
    // The bridge requires the pairing token even on localhost. Nothing in a browser can read the
    // file it lives in, so @reticlehq/vite-plugin inlines it here at build time. Without it the
    // console reads "bridge refused the connection: authentication failed" and no session appears.
    const token = typeof __RETICLE_TOKEN__ !== 'undefined' ? __RETICLE_TOKEN__ : '';
    reticle.connect({ ${fields}...(token.length > 0 ? { token } : {}) });
  });
}

declare const __RETICLE_TOKEN__: string | undefined;
`;
}

/**
 * Root-level project config for Reticle. Written by `reticle init`; read by `reticle mcp` for the port
 * and by tooling for the stable projectId (the app's identity across port changes).
 */
export function reticleConfigContent(
  framework: string,
  port: number | undefined,
  projectId?: string,
): string {
  const fields: Record<string, unknown> = { framework };
  if (projectId !== undefined && projectId.length > 0) fields['projectId'] = projectId;
  if (port !== undefined && port !== RETICLE_DEFAULT_PORT) fields['port'] = port;
  return `${JSON.stringify(fields, null, 2)}\n`;
}
