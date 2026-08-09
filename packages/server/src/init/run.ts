/**
 * The impure shell for `reticle init`: gather project files via an injected IO surface, build the
 * plan (pure), optionally write the apply-steps, and print a human-readable report. All filesystem
 * access goes through `InitIo` so the orchestration is unit-testable with an in-memory IO.
 */

import { dirname, join } from 'node:path';
import { detect, Framework, type DetectInput } from './detect.js';
import {
  DEPS_TARGET,
  MCP_TARGET,
  buildPlan,
  StepStatus,
  type Plan,
  type PlanInput,
} from './plan.js';
import { claudeAvailableProbe, claudeExistsProbe } from './mcp.js';
import { reticleDevLocation } from './next-patch.js';
import { scanTestids, storeHints } from './capabilities.js';
import { CURSOR_DIR_RELPATH, CURSOR_MCP_RELPATH } from './cursor.js';
import { deriveProjectId, packageName } from './project-id.js';
import { VITE_DEV_MODULE_PATH } from './snippets.js';
import { CLAUDE_COMMAND_PATH, CURSOR_COMMAND_PATH } from './slash-command.js';
import { SERVER_VERSION } from '../server-version.js';
import { InitFailure, reportInitOutcome } from '../telemetry/init-telemetry.js';

/** Lockfile basenames, in package-manager preference order (mirrors detect.ts). */
const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'package-lock.json',
] as const;

/**
 * Resolve the lockfiles set used to pick the package manager. A lockfile in the project root wins;
 * otherwise we walk UP the directory tree (monorepos keep the lockfile at the workspace root, not in
 * each package) so `reticle init` in a sub-package suggests `pnpm add` instead of defaulting to `npm i`.
 */
export function resolveLockfiles(
  rootFiles: ReadonlySet<string>,
  cwd: string,
  io: Pick<InitIo, 'exists'>,
): Set<string> {
  const set = new Set(rootFiles);
  if (LOCKFILE_NAMES.some((name) => set.has(name))) return set; // local lockfile is authoritative
  let dir = cwd;
  for (let depth = 0; depth < 50; depth++) {
    for (const name of LOCKFILE_NAMES) {
      if (io.exists(join(dir, name))) {
        set.add(name);
        return set;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return set;
}

const PACKAGE_JSON = 'package.json';
/**
 * Root-layout candidates, App Router only. `--src-dir` apps keep theirs under `src/app`, and the
 * ReticleDev component has to land NEXT TO the layout or the relative import it generates is dead.
 */
const NEXT_LAYOUT_CANDIDATES = [
  'app/layout.tsx',
  'app/layout.jsx',
  'app/layout.js',
  'src/app/layout.tsx',
  'src/app/layout.jsx',
  'src/app/layout.js',
];
/**
 * Pages Router mount points, checked only when there is no App Router layout. A Pages app has no
 * `app/` directory at all, so writing the component there produced a file nothing imported.
 */
const NEXT_PAGES_APP_CANDIDATES = [
  'pages/_app.tsx',
  'pages/_app.jsx',
  'pages/_app.js',
  'src/pages/_app.tsx',
  'src/pages/_app.jsx',
  'src/pages/_app.js',
];
const SVELTEKIT_HOOKS = 'src/hooks.client.ts';
/** Where an app's components live. Bounded on purpose — this is a hint, not an index of the repo. */
const SOURCE_DIRS = ['src', 'src/components', 'src/pages', 'app', 'components'] as const;
const SOURCE_FILE = /\.(tsx|jsx|ts|js|svelte|vue|astro)$/;
/** Files read for the testid scan. A capabilities block is a hint; reading a whole repo for it is not. */
const MAX_SCANNED_FILES = 200;

/** Read a bounded set of the app's source files, for the `data-testid` scan. */
function readSourceFiles(io: InitIo): string[] {
  const out: string[] = [];
  for (const dir of SOURCE_DIRS) {
    for (const name of io.listFiles(dir)) {
      if (!SOURCE_FILE.test(name)) continue;
      const content = io.readFile(`${dir}/${name}`);
      if (content !== null) out.push(content);
      if (out.length >= MAX_SCANNED_FILES) return out;
    }
  }
  return out;
}

/** Direct dependency names, for naming the state libraries an app actually has. */
function dependencyNames(pkg: unknown): Set<string> {
  const p = (pkg ?? {}) as Record<string, Record<string, string> | undefined>;
  return new Set([
    ...Object.keys(p['dependencies'] ?? {}),
    ...Object.keys(p['devDependencies'] ?? {}),
  ]);
}
const VITE_CONFIG_CANDIDATES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.mts',
];
const NEXT_CONFIG_CANDIDATES = [
  'next.config.mjs',
  'next.config.js',
  'next.config.ts',
  'next.config.cjs',
];

export interface InitOptions {
  cwd: string;
  port: number | undefined;
  mcp: boolean;
  dryRun: boolean;
  install: boolean;
  /** Set on the recursive call after a workspace redirect, so the search happens at most once. */
  redirected?: boolean;
}

export interface InitIo {
  /** Returns file content or null if it does not exist. Path is project-relative or absolute. */
  readFile(relPath: string): string | null;
  /** Writes content, creating parent directories. Path is project-relative or absolute. */
  writeFile(relPath: string, content: string): void;
  exists(relPath: string): boolean;
  /** The user's home directory (for global agent config like ~/.cursor/mcp.json). */
  homeDir(): string;
  /** Basenames present in the project root. */
  rootFiles(): readonly string[];
  /** Subdirectory names inside a project-relative directory; empty when it isn't one. */
  listDirs(relPath: string): readonly string[];
  /** File (non-directory) basenames inside a project-relative directory, including dotfiles. */
  listFiles(relPath: string): readonly string[];
  /** The same IO re-rooted at a project-relative subdirectory (used for the workspace redirect). */
  scoped(relPath: string): InitIo;
  /** Runs a subprocess to completion (inherits stdio); returns true on exit code 0. */
  exec(command: string, args: readonly string[]): boolean;
  /** Runs a subprocess quietly (no stdio) for a yes/no check; returns true on exit code 0. */
  probe(command: string, args: readonly string[]): boolean;
  print(line: string): void;
}

interface InitResult {
  ok: boolean;
  applied: number;
  manual: number;
}

/**
 * `⚠` means WORK LEFT TO DO and nothing else — it is what an agent (and the release gate) counts to
 * decide whether the install finished. A notice gets its own mark so "steps remaining" can reach zero
 * on a working install that happens to be on an ungated stack.
 */
const STATUS_SYMBOL: Record<StepStatus, string> = {
  [StepStatus.APPLY]: '✓',
  [StepStatus.MANUAL]: '⚠',
  [StepStatus.ALREADY]: '·',
  [StepStatus.SKIP]: '–',
  [StepStatus.NOTICE]: 'ℹ',
};

function firstPresent(files: ReadonlySet<string>, candidates: readonly string[]): string | null {
  for (const c of candidates) if (files.has(c)) return c;
  return null;
}

function gatherPlanInput(options: InitOptions, io: InitIo, pkgRaw: string): PlanInput {
  const pkg: unknown = JSON.parse(pkgRaw);
  // Stable identity derived from the app's package.json name + root, so it survives port changes.
  const projectId = deriveProjectId(packageName(pkg), options.cwd);
  const rootFiles = new Set(io.rootFiles());
  const detectInput: DetectInput = {
    pkg: typeof pkg === 'object' && pkg !== null ? pkg : {},
    configFiles: rootFiles,
    // Walk up for the lockfile so a monorepo sub-package picks the workspace's package manager.
    lockfiles: resolveLockfiles(rootFiles, options.cwd, io),
    // An already-installed tree names its own manager, which matters when no lockfile is committed.
    nodeModulesMarkers: new Set(io.listFiles('node_modules')),
  };
  const detection = detect(detectInput);

  const vitePath = firstPresent(rootFiles, VITE_CONFIG_CANDIDATES);
  const viteSource = vitePath === null ? null : io.readFile(vitePath);
  const viteConfig =
    vitePath !== null && viteSource !== null ? { path: vitePath, source: viteSource } : null;

  // Global MCP registration targets each agent that's present: Claude via its CLI, Cursor via its
  // global config file. Only probe when the MCP step is in play.
  const availableProbe = claudeAvailableProbe();
  const claudeCli = options.mcp ? io.probe(availableProbe.command, availableProbe.args) : false;
  const existsProbe = claudeExistsProbe();
  const mcpExists = claudeCli ? io.probe(existsProbe.command, existsProbe.args) : false;

  const cursorDir = `${io.homeDir()}/${CURSOR_DIR_RELPATH}`;
  const cursorConfigPath = `${io.homeDir()}/${CURSOR_MCP_RELPATH}`;
  const cursorPresent = options.mcp && io.exists(cursorDir);
  const cursorConfig = cursorPresent ? io.readFile(cursorConfigPath) : null;

  const nextConfigFile = firstPresent(rootFiles, NEXT_CONFIG_CANDIDATES);
  // App Router first; a Pages Router app has no layout, and its mount point is pages/_app.
  const layoutPath =
    NEXT_LAYOUT_CANDIDATES.find((p) => io.exists(p)) ??
    NEXT_PAGES_APP_CANDIDATES.find((p) => io.exists(p)) ??
    null;
  const layoutSource = layoutPath === null ? null : io.readFile(layoutPath);
  // Where the component goes depends on WHICH router mounts it: `pages/` routes on presence, so a
  // component there becomes a broken route; `app/` routes on filename, so a sibling is inert.
  const devLocation = reticleDevLocation(layoutPath ?? 'app/layout.tsx', detection.typescript);

  return {
    detection,
    claudeCli,
    mcpExists,
    cursorPresent,
    cursorProjectPresent: io.exists(CURSOR_DIR_RELPATH),
    cursorConfig,
    cursorConfigPath,
    viteConfig,
    nextConfigFile,
    nextConfigSource: nextConfigFile === null ? null : io.readFile(nextConfigFile),
    nextLayout:
      layoutPath !== null && layoutSource !== null
        ? { path: layoutPath, source: layoutSource }
        : null,
    // Capabilities: scanned, never asked for. Bounded — a hint for the agent, not a repo index.
    testids: scanTestids(readSourceFiles(io)),
    storeHints: storeHints(dependencyNames(pkg)),
    viteDevModuleExists: io.exists(VITE_DEV_MODULE_PATH),
    nextReticleDevPath: devLocation.path,
    nextReticleDevImport: devLocation.importSpecifier,
    nextReticleDevExists: io.exists(devLocation.path),
    svelteKitHooksExists: io.exists(SVELTEKIT_HOOKS),
    reticleConfigExists: io.exists('.reticle.json'),
    // Read the agent instruction files so the rule merge stays idempotent across re-runs.
    claudeMdContent: io.readFile('CLAUDE.md'),
    agentsMdContent: io.readFile('AGENTS.md'),
    cursorRuleExists: io.exists('.cursor/rules/reticle.mdc'),
    claudeCommandExists: io.exists(CLAUDE_COMMAND_PATH),
    cursorCommandExists: io.exists(CURSOR_COMMAND_PATH),
    options: {
      port: options.port,
      mcp: options.mcp,
      install: options.install,
      projectId,
      // The SDK must match the CLI asking for it — see pinnedPackages.
      sdkVersion: SERVER_VERSION,
    },
  };
}

/** Where workspace tooling conventionally puts packages. */
const WORKSPACE_PARENTS = ['apps', 'packages'] as const;
/** Deps that mark a directory as a runnable web app even when it has no bundler config file. */
const APP_DEPS = ['next', 'vite'] as const;

function looksLikeApp(dir: string, io: Pick<InitIo, 'exists' | 'readFile'>): boolean {
  const pkgRaw = io.readFile(`${dir}/${PACKAGE_JSON}`);
  if (pkgRaw === null) return false;
  const configs = [...VITE_CONFIG_CANDIDATES, ...NEXT_CONFIG_CANDIDATES];
  if (configs.some((c) => io.exists(`${dir}/${c}`))) return true;
  // `next.config` is optional in Next, so the dependency list is the other half of the signal.
  return APP_DEPS.some((d) => pkgRaw.includes(`"${d}"`));
}

/**
 * App directories under a workspace root.
 *
 * Running `reticle init` at the repo root is what people actually do, and in a monorepo the app is a
 * directory down — so init detected "no framework", printed a wall of manual HTML instructions, and
 * would have installed the SDK into the ROOT package.json. It already walks UP for the lockfile, so
 * it knows it is in a workspace; this is the matching walk DOWN.
 */
export function findWorkspaceApps(io: Pick<InitIo, 'exists' | 'readFile' | 'listDirs'>): string[] {
  const found: string[] = [];
  for (const parent of WORKSPACE_PARENTS) {
    for (const name of io.listDirs(parent)) {
      const dir = `${parent}/${name}`;
      if (looksLikeApp(dir, io)) found.push(dir);
    }
  }
  return found;
}

function restartHint(framework: Framework): string {
  if (framework === Framework.NEXT)
    return 'Restart `next dev`, then ask your agent: "List Reticle sessions".';
  if (framework === Framework.VITE)
    return 'Restart `vite`, then ask your agent: "List Reticle sessions".';
  if (framework === Framework.ASTRO)
    return 'Restart `astro dev`, then ask your agent: "List Reticle sessions".';
  if (framework === Framework.SVELTEKIT)
    return 'Restart your dev server (`npm run dev`), then ask your agent: "List Reticle sessions".';
  return 'Reload your app on localhost, then ask your agent: "List Reticle sessions".';
}

const SKIPPED_DETAIL =
  'skipped — the dependency install above failed, and wiring the app to a package that is not ' +
  'installed stops it booting. Run that install, then re-run `reticle init`.';

function report(
  plan: Plan,
  dryRun: boolean,
  failed: ReadonlySet<string>,
  skipped: ReadonlySet<string>,
  io: InitIo,
): InitResult {
  io.print(dryRun ? 'reticle init (dry run — no files written)' : 'reticle init');
  io.print('');
  let applied = 0;
  let manual = 0;
  for (const s of plan.steps) {
    // A side effect that failed to apply is reported as a manual step with its fallback command.
    const downgraded = failed.has(s.target) || skipped.has(s.target);
    const status = downgraded ? StepStatus.MANUAL : s.status;
    const detail = skipped.has(s.target)
      ? SKIPPED_DETAIL
      : downgraded && s.exec !== undefined
        ? `step failed — run manually: ${s.exec.fallback}`
        : s.detail;
    io.print(`  [${STATUS_SYMBOL[status]}] ${s.title} → ${s.target}`);
    if (status === StepStatus.APPLY) applied++;
    if (status === StepStatus.MANUAL || status === StepStatus.NOTICE) {
      // A notice prints in full like a manual step — it is worth reading — but is NOT counted as work.
      if (status === StepStatus.MANUAL) manual++;
      for (const line of detail.split('\n')) io.print(`      ${line}`);
    } else if (detail.length > 0) {
      io.print(`      ${detail}`);
    }
  }
  io.print('');
  io.print(restartHint(plan.framework));
  return { ok: true, applied, manual };
}

/**
 * Perform the apply-step side effects; return the targets whose side effect failed.
 *
 * Steps run in plan order, which puts the dependency install BEFORE everything that imports what it
 * installs. If it fails, the wiring is skipped rather than applied: patching `next.config.ts` to
 * import a `@reticlehq/next` that was never installed takes the dev server down with
 * MODULE_NOT_FOUND, so the app stops booting *because* Reticle was installed. A skipped step is a
 * message; a half-wired app is a broken project.
 */
function applyEffects(plan: Plan, io: InitIo): { failed: Set<string>; skipped: Set<string> } {
  const failed = new Set<string>();
  const skipped = new Set<string>();
  let installFailed = false;
  for (const s of plan.steps) {
    if (s.status !== StepStatus.APPLY) continue;
    if (installFailed && s.dependsOnInstall === true) {
      skipped.add(s.target);
      continue;
    }
    if (s.write !== undefined) io.writeFile(s.write.path, s.write.content);
    if (s.exec !== undefined && !io.exec(s.exec.command, s.exec.args)) {
      failed.add(s.target);
      if (s.target === DEPS_TARGET) installFailed = true;
    }
  }
  return { failed, skipped };
}

/**
 * Which STEP failed, from the step targets — not from an error string, which would carry paths.
 *
 * The distinction that matters: a dependency install failing is a machine/network problem (offline,
 * a locked registry, a broken package manager), while MCP registration failing means the `claude` CLI
 * is missing or refused. Two completely different fixes, and until now both were simply "init didn't
 * work" with nothing to tell them apart.
 */
function classifyInitFailure(failed: ReadonlySet<string>): string {
  if (failed.has(DEPS_TARGET)) return InitFailure.DEPENDENCY_INSTALL;
  if (failed.has(MCP_TARGET)) return InitFailure.MCP_REGISTRATION;
  return InitFailure.OTHER;
}

const AMBIGUOUS_HEADER =
  'Several apps found in this workspace. Re-run `reticle init` inside the one you want:';

/**
 * When the current directory is a workspace root with no app of its own, wire the app instead of the
 * root. One candidate is wired silently (there is nothing to ask about); several are listed, because
 * guessing which app someone meant is worse than one line of output.
 * Returns null when there is nothing to redirect to — the caller then proceeds here as before.
 */
function redirectToWorkspaceApp(
  options: InitOptions,
  io: InitIo,
  pkgRaw: string,
): InitResult | null {
  if (options.redirected === true) return null;
  const pkg: unknown = JSON.parse(pkgRaw);
  const rootFiles = new Set(io.rootFiles());
  const here = detect({
    pkg: typeof pkg === 'object' && pkg !== null ? pkg : {},
    configFiles: rootFiles,
    lockfiles: new Set(),
  });
  if (here.framework !== Framework.HTML) return null; // this directory IS the app

  const apps = findWorkspaceApps(io);
  const target = apps.length === 1 ? apps[0] : undefined;
  if (target === undefined) {
    if (apps.length === 0) return null; // not a workspace — fall through to the normal HTML plan
    io.print(AMBIGUOUS_HEADER);
    for (const a of apps) io.print(`  ${a}`);
    return { ok: false, applied: 0, manual: apps.length };
  }
  io.print(`No app in this directory — wiring ${target} instead.`);
  io.print('');
  return runInit(
    { ...options, cwd: join(options.cwd, target), redirected: true },
    io.scoped(target),
  );
}

export function runInit(options: InitOptions, io: InitIo): InitResult {
  const pkgRaw = io.readFile(PACKAGE_JSON);
  if (pkgRaw === null) {
    io.print('No package.json found. Run `reticle init` from your project root.');
    // The onboarding funnel had NO instrumentation, so a setup that died here was indistinguishable
    // from someone who never ran the command — the two failure modes with the most different fixes.
    reportInitOutcome({ ok: false, reason: InitFailure.NO_PACKAGE_JSON });
    return { ok: false, applied: 0, manual: 0 };
  }

  const redirected = redirectToWorkspaceApp(options, io, pkgRaw);
  if (redirected !== null) return redirected;

  const plan = buildPlan(gatherPlanInput(options, io, pkgRaw));
  const effects = options.dryRun
    ? { failed: new Set<string>(), skipped: new Set<string>() }
    : applyEffects(plan, io);
  const { failed, skipped } = effects;
  const result = report(plan, options.dryRun, failed, skipped, io);
  // A dry run is a preview, not an outcome — reporting it would inflate both success and failure.
  if (!options.dryRun) {
    reportInitOutcome({
      ok: result.ok,
      ...(result.ok ? {} : { reason: classifyInitFailure(failed) }),
      stack: plan.framework,
      mcpRegistered: !failed.has(MCP_TARGET),
    });
  }
  return result;
}
