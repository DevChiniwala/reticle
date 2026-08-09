import { describe, expect, it } from 'vitest';
import { runInit, resolveLockfiles, type InitIo, type InitOptions } from './run.js';

interface MemoryIo extends InitIo {
  written: Record<string, string>;
  lines: string[];
  execCalls: { command: string; args: readonly string[] }[];
}

const HOME = '/home/u';

interface MemoryOpts {
  execOk?: boolean;
  claudeAvailable?: boolean;
  mcpExists?: boolean;
  cursor?: boolean;
}

interface Sinks {
  written: Record<string, string>;
  lines: string[];
  execCalls: { command: string; args: readonly string[] }[];
}

function memoryIo(
  files: Record<string, string>,
  opts: MemoryOpts = {},
  prefix = '',
  // A workspace redirect re-roots the IO but must keep reporting into the SAME sinks, or a test can
  // see the redirect happen and none of what it did.
  sinks: Sinks = { written: {}, lines: [], execCalls: [] },
): MemoryIo {
  const { execOk = true, claudeAvailable = true, mcpExists = false, cursor = false } = opts;
  const { written, lines, execCalls } = sinks;
  // Simulate the Cursor config dir existing when requested.
  const present = { ...files };
  if (cursor) present[`${HOME}/.cursor`] = '';
  // Absolute paths (home-dir config) bypass the scoping prefix, matching the real IO.
  const key = (p: string): string => (p.startsWith('/') || prefix === '' ? p : `${prefix}/${p}`);
  return {
    written,
    lines,
    execCalls,
    readFile: (p) => present[key(p)] ?? written[key(p)] ?? null,
    writeFile: (p, c) => {
      written[key(p)] = c;
    },
    exists: (p) => key(p) in present || key(p) in written,
    homeDir: () => HOME,
    rootFiles: () => {
      const scope = prefix === '' ? '' : `${prefix}/`;
      return Object.keys(files)
        .filter((p) => p.startsWith(scope))
        .map((p) => p.slice(scope.length))
        .filter((p) => p !== '' && !p.includes('/'));
    },
    listDirs: (rel) => {
      const scope = `${key(rel)}/`;
      const names = Object.keys(present)
        .filter((p) => p.startsWith(scope))
        .map((p) => p.slice(scope.length).split('/')[0] ?? '')
        .filter((n) => n !== '');
      return [...new Set(names)];
    },
    listFiles: (rel) => {
      const scope = `${key(rel)}/`;
      return Object.keys(present)
        .filter((p) => p.startsWith(scope))
        .map((p) => p.slice(scope.length))
        .filter((n) => n !== '' && !n.includes('/'));
    },
    scoped: (rel) => memoryIo(files, opts, key(rel), sinks),
    exec: (command, args) => {
      execCalls.push({ command, args });
      return execOk;
    },
    probe: (_command, args) => (args.includes('get') ? mcpExists : claudeAvailable),
    print: (l) => lines.push(l),
  };
}

describe('resolveLockfiles — package-manager detection in a monorepo', () => {
  it('walks up to the workspace-root lockfile when the sub-package has none', () => {
    const io = { exists: (p: string) => p === '/repo/pnpm-lock.yaml' };
    const set = resolveLockfiles(
      new Set(['package.json', 'vite.config.ts']),
      '/repo/apps/bench-app',
      io,
    );
    expect(set.has('pnpm-lock.yaml')).toBe(true);
  });

  it('a local lockfile wins and short-circuits the walk', () => {
    const io = {
      exists: (): boolean => {
        throw new Error('should not walk when a local lockfile exists');
      },
    };
    const set = resolveLockfiles(new Set(['package-lock.json']), '/x/y', io);
    expect(set.has('package-lock.json')).toBe(true);
  });

  it('falls back to just the root files when no lockfile exists anywhere', () => {
    const io = { exists: (): boolean => false };
    const set = resolveLockfiles(new Set(['package.json']), '/x/y', io);
    expect([...set]).toEqual(['package.json']);
  });
});

const OPTS: InitOptions = {
  cwd: '/app',
  port: undefined,
  mcp: true,
  dryRun: false,
  install: false,
};

const VITE_FILES = {
  'package.json': JSON.stringify({ devDependencies: { vite: '^5', react: '^19' } }),
  'vite.config.ts': `export default { plugins: [] };\n`,
};

describe('runInit', () => {
  it('errors cleanly without a package.json', () => {
    const io = memoryIo({});
    const r = runInit(OPTS, io);
    expect(r.ok).toBe(false);
    expect(io.lines.join('\n')).toContain('No package.json');
  });

  it('registers reticle globally via the claude CLI (not a project .mcp.json) and patches vite', () => {
    const io = memoryIo(VITE_FILES);
    const r = runInit(OPTS, io);
    expect(r.ok).toBe(true);
    expect(io.written['.mcp.json']).toBeUndefined();
    expect(io.execCalls.some((c) => c.command === 'claude' && c.args.includes('add'))).toBe(true);
    expect(io.written['vite.config.ts']).toContain('@reticlehq/vite-plugin');
  });

  it('does not re-register when an reticle server already exists (idempotent, install-once)', () => {
    const io = memoryIo(VITE_FILES, { mcpExists: true });
    runInit(OPTS, io);
    expect(io.execCalls.some((c) => c.command === 'claude')).toBe(false);
  });

  it('prints manual global instructions when no agent is detected', () => {
    const io = memoryIo(VITE_FILES, { claudeAvailable: false, cursor: false });
    runInit(OPTS, io);
    expect(io.execCalls.some((c) => c.command === 'claude' && c.args.includes('add'))).toBe(false);
    expect(io.lines.join('\n')).toContain('-s user');
  });

  it('registers in Cursor global config when Cursor is present', () => {
    const io = memoryIo(VITE_FILES, { claudeAvailable: false, cursor: true });
    runInit(OPTS, io);
    expect(io.written['/home/u/.cursor/mcp.json']).toContain('@reticlehq/server');
  });

  it('registers with BOTH Claude and Cursor when both are present', () => {
    const io = memoryIo(VITE_FILES, { claudeAvailable: true, cursor: true });
    runInit(OPTS, io);
    expect(io.execCalls.some((c) => c.command === 'claude' && c.args.includes('add'))).toBe(true);
    expect(io.written['/home/u/.cursor/mcp.json']).toContain('@reticlehq/server');
  });

  it('dry run writes nothing and runs no subprocess', () => {
    const io = memoryIo(VITE_FILES);
    const r = runInit({ ...OPTS, dryRun: true }, io);
    expect(Object.keys(io.written)).toHaveLength(0);
    expect(io.execCalls).toHaveLength(0);
    expect(io.lines.join('\n')).toContain('dry run');
    expect(r.applied).toBeGreaterThan(0);
  });

  it('runs the install when enabled, pinned to the CLI version', () => {
    const io = memoryIo({ ...VITE_FILES, 'pnpm-lock.yaml': '' }, { mcpExists: true });
    runInit({ ...OPTS, install: true }, io);
    expect(io.execCalls).toHaveLength(1);
    const call = io.execCalls[0];
    expect(call?.command).toBe('pnpm');
    expect(call?.args.slice(0, 2)).toEqual(['add', '-D']);
    // Pinned: a stale registry cache once handed pnpm 2.2.1 while npm took 2.3.0 in the next
    // project, and a version-skewed SDK against a newer daemon is the -32000 path.
    expect(call?.args[2]).toMatch(/^@reticlehq\/react@\d+\.\d+\.\d+/);
    expect(call?.args[3]).toMatch(/^@reticlehq\/vite-plugin@\d+\.\d+\.\d+/);
  });

  it('downgrades a failed step to manual with its fallback command', () => {
    const io = memoryIo(VITE_FILES, { execOk: false, mcpExists: true });
    const r = runInit({ ...OPTS, install: true }, io);
    expect(io.lines.join('\n')).toContain('step failed — run manually');
    expect(r.manual).toBeGreaterThan(0);
  });

  it('creates the connect component for a Next project, matching the project language', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({ dependencies: { next: '15', react: '^19' } }),
      'next.config.mjs': 'export default {};\n',
    });
    runInit(OPTS, io);
    // No tsconfig ⇒ a JavaScript project. A stray .tsx here makes Next auto-install TypeScript on
    // the next `next dev`, which on Next 13 takes its require-hook down and the server never starts.
    expect(io.written['app/reticle-dev.jsx']).toContain('ReticleDev');
    expect(io.written['app/reticle-dev.tsx']).toBeUndefined();
  });

  it('uses .tsx once the project has a tsconfig', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({ dependencies: { next: '15', react: '^19' } }),
      'next.config.mjs': 'export default {};\n',
      'tsconfig.json': '{}',
    });
    runInit(OPTS, io);
    expect(io.written['app/reticle-dev.tsx']).toContain('ReticleDev');
  });

  /**
   * Every file under `pages/` is a route. Writing the component there gave the app a route with no
   * default export — `/reticle-dev` 500s and `next build` fails — on top of the TypeScript problem.
   * Installing Reticle stopped the app booting, which is the worst outcome an installer can have.
   */
  it('keeps the Pages Router component out of pages/, and imports it from where it landed', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({ dependencies: { next: '13', react: '^18' } }),
      'next.config.js': 'module.exports = {};\n',
      'pages/_app.js':
        'export default function App({ Component, pageProps }) {\n  return <Component {...pageProps} />;\n}\n',
    });
    runInit(OPTS, io);
    expect(io.written['components/reticle-dev.jsx']).toContain('ReticleDev');
    expect(io.written['pages/reticle-dev.tsx']).toBeUndefined();
    expect(io.written['pages/reticle-dev.jsx']).toBeUndefined();
    expect(io.written['pages/_app.js']).toContain("from '../components/reticle-dev'");
  });

  it('creates src/hooks.client.ts for a SvelteKit project AND patches vite.config', () => {
    // Both halves, and they do different jobs. The client hook is what registers a session, because
    // SvelteKit renders through app.html so the plugin's HTML injection never fires. The plugin is
    // what stamps data-reticle-source into .svelte components — `init` has always installed
    // @reticlehq/vite-plugin for SvelteKit and used to leave it unwired, so it sat in package.json
    // doing nothing and every verdict on a SvelteKit app came back with no file:line.
    const io = memoryIo({
      'package.json': JSON.stringify({ devDependencies: { '@sveltejs/kit': '^2', vite: '^5' } }),
      'svelte.config.js': 'export default {};\n',
      'vite.config.ts': `import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit()] };\n`,
    });
    runInit(OPTS, io);
    expect(io.written['src/hooks.client.ts']).toContain('reticle.connect(');
    expect(io.written['src/hooks.client.ts']).toContain('app.html'); // explains why the hook exists
    // Without the token the bridge answers "authentication failed" and no session ever appears —
    // the same silent no-connect Next.js shipped. The plugin inlines it as a define.
    expect(io.written['src/hooks.client.ts']).toContain('__RETICLE_TOKEN__');
    expect(io.written['vite.config.ts']).toContain('reticle()');
    expect(io.written['vite.config.ts']).toContain('sveltekit()'); // the app's own plugin survives
  });
});

/**
 * Running `reticle init` at the repo root is what people actually do. In a monorepo that used to
 * detect "no framework", print a wall of manual HTML instructions, and install the SDK into the ROOT
 * package.json — for the most common real-world layout there is.
 */
describe('runInit — workspace roots', () => {
  const WORKSPACE_ROOT = JSON.stringify({ name: 'mono', workspaces: ['apps/*'] });
  const VITE_APP = {
    'apps/web/package.json': JSON.stringify({ dependencies: { react: '^19', vite: '^7' } }),
    'apps/web/vite.config.ts': `import react from '@vitejs/plugin-react';\nexport default { plugins: [react()] };\n`,
  };

  it('wires the single app under apps/ instead of the root', () => {
    const io = memoryIo({ 'package.json': WORKSPACE_ROOT, ...VITE_APP });
    runInit(OPTS, io);
    expect(io.lines.join('\n')).toContain('apps/web');
    expect(io.written['apps/web/vite.config.ts']).toContain('reticle()');
    expect(io.written['apps/web/.reticle.json']).toBeDefined();
    // The root is not the app — nothing of the app's wiring belongs there.
    expect(io.written['vite.config.ts']).toBeUndefined();
    expect(io.written['.reticle.json']).toBeUndefined();
  });

  it('lists the candidates instead of guessing when a workspace has several apps', () => {
    const io = memoryIo({
      'package.json': WORKSPACE_ROOT,
      ...VITE_APP,
      'apps/admin/package.json': JSON.stringify({ dependencies: { next: '16' } }),
    });
    const result = runInit(OPTS, io);
    expect(result.ok).toBe(false);
    const out = io.lines.join('\n');
    expect(out).toContain('apps/web');
    expect(out).toContain('apps/admin');
    expect(io.written['apps/web/.reticle.json']).toBeUndefined();
  });

  it('leaves a plain app directory alone — no redirect when this IS the app', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({ devDependencies: { vite: '^7' } }),
      'vite.config.ts': 'export default { plugins: [] };\n',
      ...VITE_APP, // a nested apps/ dir must not hijack a root that is itself an app
    });
    runInit(OPTS, io);
    expect(io.written['vite.config.ts']).toContain('reticle()');
    expect(io.written['apps/web/vite.config.ts']).toBeUndefined();
  });

  it('still falls through to the manual HTML plan when nothing app-like is anywhere', () => {
    const io = memoryIo({ 'package.json': JSON.stringify({ dependencies: {} }) });
    const result = runInit(OPTS, io);
    expect(result.ok).toBe(true);
    expect(io.written['.reticle.json']).toBeDefined();
  });
});

/**
 * Installing Reticle must never be the reason an app stops booting.
 *
 * When `pnpm add` refused a version (its minimumReleaseAge held the release back), `init` carried on
 * and patched `next.config.ts` to import a `@reticlehq/next` that was never installed. The dev
 * server then died with MODULE_NOT_FOUND — the app was fine until Reticle touched it.
 */
describe('runInit — a failed install must not leave the app half-wired', () => {
  const NEXT_FILES = {
    'package.json': JSON.stringify({ dependencies: { next: '15', react: '^19' } }),
    'next.config.mjs': 'const nextConfig = {};\nexport default nextConfig;\n',
    'app/layout.tsx':
      'export default function L({ children }) {\n  return <html><body>{children}</body></html>;\n}\n',
  };

  it('does not patch the config to import a package the install failed to provide', () => {
    const io = memoryIo(NEXT_FILES, { execOk: false, mcpExists: true });
    runInit({ ...OPTS, install: true }, io);
    expect(io.written['next.config.mjs']).toBeUndefined();
    expect(io.written['app/layout.tsx']).toBeUndefined();
    expect(io.written['app/reticle-dev.jsx']).toBeUndefined();
    // ...and says why, rather than leaving the user to work it out from a MODULE_NOT_FOUND.
    expect(io.lines.join('\n')).toContain('stops it booting');
  });

  it('still wires everything when the install succeeds', () => {
    const io = memoryIo(NEXT_FILES, { execOk: true, mcpExists: true });
    runInit({ ...OPTS, install: true }, io);
    expect(io.written['next.config.mjs']).toContain('withReticle');
    expect(io.written['app/layout.tsx']).toContain('ReticleDev');
  });

  it('config that does not import anything is still written — it has no dependency to miss', () => {
    const io = memoryIo(NEXT_FILES, { execOk: false, mcpExists: true });
    runInit({ ...OPTS, install: true }, io);
    expect(io.written['.reticle.json']).toBeDefined();
  });
});

/**
 * Every app came up `hasCapabilities: false`, capabilities empty, `reticle_state` holding only
 * `__reticle_renders` — the state-truth read, which SKILL.md calls the highest-value line, was
 * unavailable on all six real apps out of the box because `init` wired neither call.
 */
describe('runInit — the capabilities module', () => {
  const APP = {
    'package.json': JSON.stringify({
      devDependencies: { vite: '^5', react: '^19' },
      dependencies: { zustand: '^4' },
    }),
    'vite.config.ts': `export default { plugins: [] };\n`,
    'src/App.tsx': '<button data-testid="pay">Pay</button><a data-testid="home" />',
  };

  it('writes a dev module carrying the scanned testids', () => {
    const io = memoryIo(APP, { mcpExists: true });
    runInit(OPTS, io);
    const mod = io.written['src/reticle-dev.ts'] ?? '';
    expect(mod).toContain('registerCapabilities');
    expect(mod).toContain("'pay'");
    expect(mod).toContain("'home'");
  });

  it('names the store library it found, COMMENTED — a wrong import would break the module', () => {
    const io = memoryIo(APP, { mcpExists: true });
    runInit(OPTS, io);
    const mod = io.written['src/reticle-dev.ts'] ?? '';
    expect(mod).toContain('registerStore');
    // Commented: detecting zustand is easy, knowing which module exports the store instance is not.
    for (const line of mod.split('\n')) {
      if (line.includes('registerStore')) expect(line.trimStart().startsWith('//')).toBe(true);
    }
  });

  it('is created on a RE-RUN too — it used to ride on the config patch and vanish when that was already done', () => {
    const io = memoryIo(
      {
        ...APP,
        'vite.config.ts': `import { reticle } from '@reticlehq/vite-plugin';\nexport default { plugins: [reticle()] };\n`,
      },
      { mcpExists: true },
    );
    runInit(OPTS, io);
    expect(io.written['src/reticle-dev.ts']).toContain('registerCapabilities');
  });

  it('never overwrites an existing one — it is the file the user is meant to edit', () => {
    const io = memoryIo({ ...APP, 'src/reticle-dev.ts': '// mine\n' }, { mcpExists: true });
    runInit(OPTS, io);
    expect(io.written['src/reticle-dev.ts']).toBeUndefined();
  });

  it('still writes the module when an app has no testids yet, and says so', () => {
    const io = memoryIo({ ...APP, 'src/App.tsx': '<button>Pay</button>' }, { mcpExists: true });
    runInit(OPTS, io);
    const mod = io.written['src/reticle-dev.ts'] ?? '';
    expect(mod).toContain('registerCapabilities');
    expect(mod).toContain('add data-testid');
  });
});

/**
 * SKILL.md told the user "Type `/reticle` anytime to verify the app" in three separate places, and
 * `init` never wrote the file that makes the command exist. So the single most obvious way into the
 * product was a command that silently did nothing, in every tool, for everyone.
 */
describe('runInit — the /reticle command', () => {
  it('creates the Claude Code command so /reticle actually exists', () => {
    const io = memoryIo(VITE_FILES, { claudeAvailable: true });
    runInit(OPTS, io);
    const cmd = io.written['.claude/commands/reticle.md'] ?? '';
    expect(cmd).toContain('description:');
    expect(cmd).toContain('reticle_snapshot');
  });

  it('scopes the command to ONE flow — an existing app has many, and instrumenting all is the slow path', () => {
    const io = memoryIo(VITE_FILES, { claudeAvailable: true });
    runInit(OPTS, io);
    const cmd = io.written['.claude/commands/reticle.md'] ?? '';
    expect(cmd).toContain('Pick ONE flow');
    expect(cmd).toContain('Not the whole app');
    // Driving by role/name works without testids; telling people otherwise is what makes onboarding long.
    expect(cmd).toContain('do **not** need');
  });

  it('writes the Cursor command when Cursor is the agent in play', () => {
    const io = memoryIo(VITE_FILES, { claudeAvailable: false, cursor: true });
    runInit(OPTS, io);
    expect(io.written['.cursor/commands/reticle.md']).toContain('reticle_snapshot');
  });

  it('is idempotent — an existing command is left alone', () => {
    const io = memoryIo(
      { ...VITE_FILES, '.claude/commands/reticle.md': '# mine\n' },
      { claudeAvailable: true },
    );
    runInit(OPTS, io);
    expect(io.written['.claude/commands/reticle.md']).toBeUndefined();
  });
});
