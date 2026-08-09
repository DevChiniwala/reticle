'use strict';
// withReticle(nextConfig): adds a dev-only webpack pre-loader that stamps data-reticle-source on
// your JSX so @reticlehq/react can report the source file:line — without disabling SWC. It also
// forwards the daemon's auto-provisioned pairing token to the client so a manual reticle.connect()
// can present it (the bridge requires the token even on localhost).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Kept in sync with @reticlehq/core (ReticleDir / ReticleEnv). This package is plain CJS tooling and
// deliberately has no ESM/TS dependency on core, so the two constants are mirrored here.
const PAIRING_TOKEN_DIR_ENV = 'RETICLE_PAIRING_TOKEN_DIR';
const PAIRING_TOKEN_FILE = 'pairing-token';

/**
 * Read the daemon's auto-provisioned pairing token (~/.reticle/pairing-token, or the
 * RETICLE_PAIRING_TOKEN_DIR override). Node-side only. Returns undefined if the daemon hasn't started
 * yet (start it before `next dev`); the client then connects without a token and the page reloads once
 * the daemon is up and the config is re-read.
 * @returns {string | undefined}
 */
function readPairingToken() {
  const override = process.env[PAIRING_TOKEN_DIR_ENV];
  const dir =
    override !== undefined && override.length > 0 ? override : path.join(os.homedir(), '.reticle');
  try {
    const token = fs.readFileSync(path.join(dir, PAIRING_TOKEN_FILE), 'utf8').trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The stamping loader, addressed by package export so both bundlers can resolve it. Turbopack takes
 * loaders by module id, not by absolute path.
 */
const LOADER_MODULE = '@reticlehq/next/loader';

/**
 * The top-level `turbopack` config key is stable from Next 15.3; before that it was
 * `experimental.turbo`, and an unknown top-level key makes Next print an "Invalid next.config.js
 * options detected" warning on every boot. Older Next also defaults to webpack, so it does not need
 * the key at all — emitting it would be pure noise in somebody's terminal.
 * @returns {boolean}
 */
function supportsTurbopackKey() {
  try {
    const { version } = require('next/package.json');
    const [major, minor] = String(version)
      .split('.')
      .map((n) => parseInt(n, 10));
    if (!Number.isFinite(major)) return true; // unreadable version: assume modern, matching npm's default
    if (major > 15) return true;
    return major === 15 && Number.isFinite(minor) && minor >= 3;
  } catch {
    return true;
  }
}

/**
 * Turbopack rules mirroring the webpack pre-loader.
 *
 * Next 16 made Turbopack the DEFAULT, and a config carrying a `webpack` key with no `turbopack` key
 * is a hard startup error there ("This build is using Turbopack, with a webpack config and no
 * turbopack config") — so `withReticle` killed `next dev` outright for every new Next app. Emitting
 * both keys means whichever bundler is running finds its own wiring and neither errors on the other.
 * @param {Record<string, unknown> | undefined} existing
 */
function turbopackConfig(existing) {
  const rule = { loaders: [LOADER_MODULE] };
  const prev = existing !== undefined && existing !== null ? existing : {};
  const prevRules = prev.rules !== undefined && prev.rules !== null ? prev.rules : {};
  return {
    ...prev,
    rules: {
      ...prevRules,
      // No `as:` — the loader only stamps attributes, so the module type is unchanged. Naming the
      // type here makes Turbopack rewrite the module id (./x.tsx → ./x.tsx.tsx) and every import breaks.
      '*.tsx': rule,
      '*.jsx': rule,
    },
  };
}

/**
 * @param {import('next').NextConfig} [nextConfig]
 * @returns {import('next').NextConfig}
 */
function withReticle(nextConfig = {}) {
  // Production builds are untouched — this is a dev-time aid only.
  if (process.env.NODE_ENV === 'production') return nextConfig;

  const userWebpack = nextConfig.webpack;
  const token = readPairingToken();
  return {
    ...nextConfig,
    ...(supportsTurbopackKey() ? { turbopack: turbopackConfig(nextConfig.turbopack) } : {}),
    // Expose the token to the client bundle as process.env.NEXT_PUBLIC_RETICLE_TOKEN (Next's convention
    // for client-readable env), so a dev-only client connect can present it. Omitted when the daemon
    // hasn't provisioned one yet — the client then connects without it and the page reloads once it has.
    env: {
      ...nextConfig.env,
      ...(token !== undefined ? { NEXT_PUBLIC_RETICLE_TOKEN: token } : {}),
      // The project root, so the SDK can report React's absolute `_debugSource.fileName` as a
      // repo-relative path. Passed via `env` rather than a webpack DefinePlugin because Turbopack — the
      // Next 16 default — never runs the webpack branch, and a source pointer that only works on one
      // of the two bundlers is worse than one that works on neither.
      NEXT_PUBLIC_RETICLE_ROOT: process.cwd(),
    },
    webpack(config, ctx) {
      config.module = config.module || { rules: [] };
      config.module.rules = config.module.rules || [];
      config.module.rules.push({
        test: /\.(t|j)sx$/,
        exclude: /node_modules/,
        enforce: 'pre',
        use: [{ loader: require.resolve('./loader.cjs') }],
      });
      return typeof userWebpack === 'function' ? userWebpack(config, ctx) : config;
    },
  };
}

module.exports = { withReticle, readPairingToken };
