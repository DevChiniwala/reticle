import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, beforeAll } from 'vitest';
import { ReticleDir, ReticleEnv } from '@reticlehq/core';
import { reticle, RETICLE_CONNECT_MODULE, RETICLE_VITE_PLUGIN_NAME } from './index.js';

/**
 * Proves the prod-safety claim against Vite's *actual* config resolution rather than a unit
 * assertion on the `apply` field: `resolveConfig(..., 'build')` runs Vite's own apply-filter, so a
 * plugin missing from the resolved build pipeline can never touch a production bundle. Skipped when
 * `vite` is not installed (e.g. offline local runs); CI installs it as a devDependency.
 */

/** A dev server, as much of it as this suite drives. */
interface DevServerLike {
  listen: () => Promise<unknown>;
  close: () => Promise<void>;
  resolvedUrls?: { local: string[] };
}
type CreateServer = (inline: Record<string, unknown>) => Promise<DevServerLike>;

type ResolveConfig = (
  inline: { plugins: unknown[]; configFile: false; logLevel: 'silent' },
  command: 'build' | 'serve',
) => Promise<{ plugins: readonly { name: string }[] }>;

let resolveConfig: ResolveConfig | undefined;
let createServer: CreateServer | undefined;

/**
 * Generous, explicit, and NOT a retuned guess.
 *
 * These hooks import Vite and start/stop a real dev server. Measured on an idle machine:
 * `import('vite')` 127ms, createServer+listen 9-55ms, close 0-40ms — including after a keep-alive
 * fetch, which was the first thing suspected and is not the cause. So the work is ~0.2s and vitest's
 * default 10s hook timeout has two orders of magnitude of headroom. It still fails, on Windows CI
 * and on a Mac deep into swap, because a machine that is thrashing is slow by a factor that makes
 * any fixed number wrong.
 *
 * Raising this is NOT the mistake corrected in tool-fuzz. There, the timeout WAS the assertion — it
 * defined what counted as "hung", so bumping it changed what the test claimed. Here the assertion is
 * `expect(...).toContain('tok_written_later')`, and the hook bound is incidental infrastructure: a
 * larger number cannot make a broken plugin pass. This is exactly the remedy CLAUDE.md prescribes —
 * "use a generous per-test timeout" — rather than a statement about the machine.
 */
const HOOK_TIMEOUT_MS = 60_000;
/** How long a dev server gets to close before teardown stops waiting. See the note in afterEach. */
const CLOSE_BUDGET_MS = 5_000;

beforeAll(async () => {
  try {
    const vite = (await import('vite')) as {
      resolveConfig: ResolveConfig;
      createServer: CreateServer;
    };
    resolveConfig = vite.resolveConfig;
    createServer = vite.createServer;
  } catch {
    resolveConfig = undefined;
    createServer = undefined;
  }
}, HOOK_TIMEOUT_MS);

function names(plugins: readonly { name: string }[]): string[] {
  return plugins.map((p) => p.name);
}

describe('reticle() in the real Vite config resolution', () => {
  it('is included in the serve pipeline', async () => {
    if (resolveConfig === undefined) return;
    const resolved = await resolveConfig(
      { plugins: [reticle()], configFile: false, logLevel: 'silent' },
      'serve',
    );
    expect(names(resolved.plugins)).toContain(RETICLE_VITE_PLUGIN_NAME);
  });

  it('is filtered out of the build pipeline (never ships to production)', async () => {
    if (resolveConfig === undefined) return;
    const resolved = await resolveConfig(
      { plugins: [reticle()], configFile: false, logLevel: 'silent' },
      'build',
    );
    expect(names(resolved.plugins)).not.toContain(RETICLE_VITE_PLUGIN_NAME);
  });
});

/**
 * The daemon may start AFTER the dev server, and this is the case that broke.
 *
 * `load` reads the pairing token at serve time for exactly that reason, but Vite caches the module
 * it produced and answers every later request from that cache — including after a full page reload.
 * So the app kept receiving the tokenless connect module it was served first, the SDK got a 1008
 * `authentication failed` and (correctly) stopped retrying, and `reticle status` reported no session
 * while the page demonstrably contained `/@reticle-connect`. Only restarting the dev server cleared
 * it. Reported from a Windows Vite + React app; reproduces on every platform.
 *
 * Against a REAL dev server, because the whole defect lives in Vite's cache: a unit test on `load`
 * calls it directly and passes either way, which is why nothing here caught this.
 */
describe('the connect module picks up a token written after the dev server started', () => {
  const dirs: string[] = [];
  const servers: DevServerLike[] = [];

  afterEach(async () => {
    // One server that will not close must not strand the others, nor the temp dirs. Teardown that
    // aborts halfway leaks a listening port into the next test, which then fails for a reason that
    // has nothing to do with it — the failure being debugged here, one layer down.
    for (const server of servers.splice(0)) {
      // Bounded, because `close()` can genuinely never resolve. Measured in isolation: a dev server
      // that has served `/@reticle-connect` does not close — 90s and counting — while the same
      // server closes in 1ms if it served a real file instead, and in 7ms with no Reticle plugin at
      // all. The served module imports `/.vite/deps/@reticlehq_react.js`, so Vite's dependency
      // optimizer is involved and `close()` waits on it forever. Filed separately; it is a product
      // interaction, not something this test should paper over silently.
      //
      // The assertion this suite exists for has already run by the time teardown starts, so a
      // teardown that cannot finish must not be allowed to fail it — that inversion is what made
      // this look like a flaky timeout for weeks.
      await Promise.race([
        server.close().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, CLOSE_BUDGET_MS)),
      ]);
    }
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows holds handles open behind a file watcher; a leaked temp dir is not a test failure */
      }
    }
    delete process.env[ReticleEnv.PAIRING_TOKEN_DIR];
  }, HOOK_TIMEOUT_MS);

  it('serves the token on the next request, without a dev-server restart', async () => {
    if (createServer === undefined) return;
    const tokenDir = mkdtempSync(join(tmpdir(), 'reticle-token-'));
    const root = mkdtempSync(join(tmpdir(), 'reticle-app-'));
    dirs.push(tokenDir, root);
    process.env[ReticleEnv.PAIRING_TOKEN_DIR] = tokenDir;

    // A stand-in for the SDK: the import must RESOLVE, or Vite fails the module and re-runs `load`
    // on every request — which hides the staleness the same way it hid it during investigation.
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src/sdk.js'),
      'export const reticle = { connect(){} };\nexport const install = () => {};\n',
    );
    writeFileSync(
      join(root, 'index.html'),
      '<html><body><script type="module" src="/src/main.js"></script></body></html>',
    );
    writeFileSync(join(root, 'src/main.js'), 'export const app = 1;\n');

    const server = await createServer({
      root,
      logLevel: 'silent',
      configFile: false,
      server: { port: 0, host: '127.0.0.1' },
      resolve: { alias: { '@reticlehq/react': join(root, 'src/sdk.js') } },
      plugins: [reticle()],
    });
    servers.push(server);
    await server.listen();
    const base = server.resolvedUrls?.local[0] ?? '';
    const url = `${base.replace(/\/$/, '')}${RETICLE_CONNECT_MODULE}`;

    // Served BEFORE the daemon exists: no token, and nothing wrong with that.
    expect(await (await fetch(url)).text()).not.toContain('tok_');

    // The daemon starts and writes its pairing token. The page is reloaded — one more request.
    writeFileSync(join(tokenDir, ReticleDir.PAIRING_TOKEN_FILE), 'tok_written_later');

    expect(await (await fetch(url)).text()).toContain('tok_written_later');
  });
});
