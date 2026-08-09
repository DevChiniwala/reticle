/**
 * Pure assembly of the `reticle init` action plan. Given the detection result and the relevant file
 * contents, produce an ordered list of steps — each marked apply / manual / already / skip. The
 * runner performs the `write` side-effects; this module decides *what* should happen.
 */

import {
  Framework,
  PackageManager,
  UiLibrary,
  installCommand,
  installCommandParts,
  type Detection,
} from './detect.js';
import { claudeAddCommand, mcpManual } from './mcp.js';
import { mergeCursorConfig, CursorMergeStatus, cursorServerEntry } from './cursor.js';
import { CLAUDE_COMMAND_PATH, CURSOR_COMMAND_PATH, SLASH_COMMAND_BODY } from './slash-command.js';
import {
  mergeMarkedInstruction,
  cursorRuleFile,
  AgentRuleStatus,
  CLAUDE_MD_PATH,
  AGENTS_MD_PATH,
  CURSOR_RULE_PATH,
} from './agent-rules.js';
import { viteSteps, nextSteps, svelteKitSteps, VITE_PLUGIN_DETAIL } from './plan-framework.js';
import {
  htmlManual,
  reticleConfigContent,
  unverifiedUiLibraryNote,
  astroManual,
} from './snippets.js';

// An app dev installs exactly the audience-scoped browser-side dependencies — never the retired
// `@reticlehq/core` umbrella (which dragged the Node MCP server + ws into every app). The kit is the
// framework adapter (it re-exports the browser sensor), paired with that framework's dev-only build
// plugin for source mapping + connect injection.
const RETICLE_REACT_KIT = '@reticlehq/react';
const RETICLE_VITE_PLUGIN = '@reticlehq/vite-plugin';
const RETICLE_NEXT_PLUGIN = '@reticlehq/next';

/**
 * Pin the SDK to the CLI's own version.
 *
 * `pnpm add -D @reticlehq/react` installed **2.2.1** in one project while npm and yarn took 2.3.0 in
 * the next — a stale registry metadata cache, invisible to the user and to us. A version-skewed SDK
 * talking to a newer daemon is the `-32000` failure path: the app connects, the protocol disagrees,
 * and nothing on either side names a version. Asking for the CLI's exact version makes the cache
 * irrelevant, and a skewed pair impossible to install by accident.
 */
export function pinnedPackages(
  packages: readonly string[],
  version: string | undefined,
): readonly string[] {
  if (version === undefined || version.length === 0) return packages;
  return packages.map((p) => `${p}@${version}`);
}

/** The dev-dependencies `reticle init` installs for a given framework — kit first, build plugin next. */
export function frameworkPackages(framework: Framework): readonly string[] {
  switch (framework) {
    case Framework.NEXT:
      return [RETICLE_REACT_KIT, RETICLE_NEXT_PLUGIN];
    case Framework.VITE:
    case Framework.SVELTEKIT:
      // SvelteKit builds on Vite; until a dedicated Svelte kit exists it uses the Vite build plugin.
      return [RETICLE_REACT_KIT, RETICLE_VITE_PLUGIN];
    case Framework.ASTRO:
      // Astro owns its own Vite instance and renders its own HTML, so there is no config for the
      // plugin to attach to — the kit alone, connected from a page <script> (see astroManual).
      return [RETICLE_REACT_KIT];
    case Framework.HTML:
      // No bundler plugin to install — just the kit; connect is wired by hand (see htmlManual).
      return [RETICLE_REACT_KIT];
  }
}

/** Exported so the init telemetry can tell an MCP-registration failure from a dependency install. */
export const MCP_TARGET = 'global (claude user scope)';
/** The step that runs the package manager — the other thing that commonly fails on a user's machine. */
export const DEPS_TARGET = 'package.json';
const RETICLE_CONFIG_FILE = '.reticle.json';

export const StepStatus = {
  APPLY: 'apply',
  MANUAL: 'manual',
  ALREADY: 'already',
  SKIP: 'skip',
  /**
   * Something the user should KNOW, not something they must DO. The UNVERIFIED lines are the case:
   * a Preact or SvelteKit app is wired and working, it just isn't covered by a gate. Reporting those
   * as `manual` made "steps left to do" a number that could never reach zero, and made a release gate
   * read two regressions that were not regressions.
   */
  NOTICE: 'notice',
} as const;
export type StepStatus = (typeof StepStatus)[keyof typeof StepStatus];

export interface Step {
  title: string;
  target: string;
  status: StepStatus;
  detail: string;
  /** Present only when status is APPLY and a file must be written. */
  write?: { path: string; content: string };
  /** Present only when status is APPLY and a subprocess must run (the dependency install). */
  exec?: { command: string; args: string[]; fallback: string };
  /**
   * This step wires the app to a package the install step provides. If that install fails, applying
   * it anyway leaves the app importing a module that is not there — `next.config.ts` importing
   * `@reticlehq/next` took a dev server down exactly this way. Installing Reticle must never be the
   * reason an app stops booting.
   */
  dependsOnInstall?: boolean;
}

export interface Plan {
  framework: Framework;
  steps: Step[];
}

export interface PlanInput {
  detection: Detection;
  /** Whether the `claude` CLI is installed (so we can register the MCP server globally). */
  claudeCli: boolean;
  /** Whether an `reticle` MCP server is already registered with Claude (any scope) — idempotency. */
  mcpExists: boolean;
  /** Whether Cursor is installed for this user (its global config dir exists). */
  cursorPresent: boolean;
  /** Whether THIS project has a .cursor/ directory — the signal that Cursor works on this repo. */
  cursorProjectPresent?: boolean | undefined;
  /** Current ~/.cursor/mcp.json content, or null if absent. */
  cursorConfig: string | null;
  /** Absolute path of ~/.cursor/mcp.json (the write target). */
  cursorConfigPath: string;
  /** Discovered Vite config: its path + source, or null if none found. */
  viteConfig: { path: string; source: string } | null;
  /** Discovered Next config filename (e.g. 'next.config.mjs'), or null. */
  nextConfigFile: string | null;
  /** Source of that Next config, so the export can be wrapped in withReticle. */
  nextConfigSource?: string | null | undefined;
  /** Discovered Next root layout: its path + source, or null (App Router only). */
  nextLayout?: { path: string; source: string } | null | undefined;
  /** Where the dev-only connect component goes — never inside `pages/`, which routes on presence. */
  nextReticleDevPath?: string | undefined;
  /** What the mount file should import — a sibling for App Router, `../components/…` for Pages. */
  nextReticleDevImport?: string | undefined;
  /** Whether the ReticleDev component file already exists. */
  nextReticleDevExists: boolean;
  /** `data-testid` values scanned from the app's source, for the generated capabilities block. */
  testids?: readonly string[] | undefined;
  /** Ready-to-uncomment `registerStore` lines for the state libraries the app actually depends on. */
  storeHints?: readonly string[] | undefined;
  /** Whether src/reticle-dev.ts already exists — it is the one generated file users are meant to edit. */
  viteDevModuleExists?: boolean | undefined;
  /** Whether src/hooks.client.ts already exists (SvelteKit idempotency). */
  svelteKitHooksExists?: boolean;
  /** Whether .reticle.json already exists in the project root (idempotency). */
  reticleConfigExists?: boolean;
  /** Current project-root CLAUDE.md content (for the idempotent agent-rule merge), or null/undefined. */
  claudeMdContent?: string | null | undefined;
  /** Current project-root AGENTS.md content (cross-agent fallback rule), or null/undefined. */
  agentsMdContent?: string | null | undefined;
  /** Whether .cursor/rules/reticle.mdc already exists (agent-rule idempotency). */
  cursorRuleExists?: boolean | undefined;
  /** Whether .claude/commands/reticle.md already exists (slash-command idempotency). */
  claudeCommandExists?: boolean | undefined;
  /** Whether .cursor/commands/reticle.md already exists. */
  cursorCommandExists?: boolean | undefined;
  options: {
    port: number | undefined;
    mcp: boolean;
    install: boolean;
    /** Stable project identity derived at init (package.json name + root). Baked into snippets/.reticle.json. */
    projectId?: string;
    /** The CLI's own version, pinned onto the SDK install so a stale registry cache cannot skew it. */
    sdkVersion?: string;
  };
}

const CLAUDE_MCP_TITLE = 'MCP server (Claude, global)';
const CURSOR_MCP_TITLE = 'MCP server (Cursor, global)';

function claudeMcpStep(input: PlanInput): Step | null {
  if (!input.claudeCli) return null;
  if (input.mcpExists) {
    return {
      title: CLAUDE_MCP_TITLE,
      target: MCP_TARGET,
      status: StepStatus.ALREADY,
      detail: 'reticle already registered (install once, used by every project)',
    };
  }
  const cmd = claudeAddCommand();
  return {
    title: CLAUDE_MCP_TITLE,
    target: MCP_TARGET,
    status: StepStatus.APPLY,
    detail: 'register reticle globally for all projects',
    exec: { command: cmd.command, args: cmd.args, fallback: cmd.display },
  };
}

function cursorMcpStep(input: PlanInput): Step | null {
  if (!input.cursorPresent) return null;
  const r = mergeCursorConfig(input.cursorConfig);
  if (r.status === CursorMergeStatus.ALREADY) {
    return {
      title: CURSOR_MCP_TITLE,
      target: input.cursorConfigPath,
      status: StepStatus.ALREADY,
      detail: 'reticle already in Cursor global config',
    };
  }
  if (r.status === CursorMergeStatus.MANUAL) {
    return {
      title: CURSOR_MCP_TITLE,
      target: input.cursorConfigPath,
      status: StepStatus.MANUAL,
      detail: `couldn't parse ${input.cursorConfigPath} — add this server by hand:\n  "reticle": ${JSON.stringify(cursorServerEntry())}`,
    };
  }
  return {
    title: CURSOR_MCP_TITLE,
    target: input.cursorConfigPath,
    status: StepStatus.APPLY,
    detail: 'register reticle in Cursor global config',
    write: { path: input.cursorConfigPath, content: r.content },
  };
}

/** One global registration per detected agent (Claude + Cursor). Falls back to a manual note. */
function mcpSteps(input: PlanInput): Step[] {
  if (!input.options.mcp) {
    return [
      {
        title: 'MCP server (global)',
        target: MCP_TARGET,
        status: StepStatus.SKIP,
        detail: '--no-mcp',
      },
    ];
  }
  const steps = [claudeMcpStep(input), cursorMcpStep(input)].filter((s): s is Step => s !== null);
  if (steps.length > 0) return steps;
  // No supported agent detected — print the one-time global instructions.
  return [
    {
      title: 'MCP server (global)',
      target: MCP_TARGET,
      status: StepStatus.MANUAL,
      detail: mcpManual(),
    },
  ];
}

const SLASH_COMMAND_TITLE = 'The /reticle command';

/**
 * `/reticle` — the entry point SKILL.md promises in three places and nothing ever created, so it
 * silently did nothing in every tool. One file per agent that supports custom commands.
 */
function slashCommandSteps(input: PlanInput): Step[] {
  const targets: { path: string; when: boolean; exists: boolean }[] = [
    {
      path: CLAUDE_COMMAND_PATH,
      when: input.claudeCli,
      exists: input.claudeCommandExists === true,
    },
    {
      path: CURSOR_COMMAND_PATH,
      when: input.cursorProjectPresent === true || (input.cursorPresent && !input.claudeCli),
      exists: input.cursorCommandExists === true,
    },
  ];
  return targets
    .filter((t) => t.when)
    .map((t) =>
      t.exists
        ? {
            title: SLASH_COMMAND_TITLE,
            target: t.path,
            status: StepStatus.ALREADY,
            detail: 'command already exists',
          }
        : {
            title: SLASH_COMMAND_TITLE,
            target: t.path,
            status: StepStatus.APPLY,
            detail: 'type /reticle to verify one flow in the browser',
            write: { path: t.path, content: SLASH_COMMAND_BODY },
          },
    );
}

const AGENT_RULE_TITLE = 'Agent verification rule';
const AGENT_RULE_DETAIL = 'teach the agent to verify features with Reticle after building them';

function claudeRuleStep(input: PlanInput): Step | null {
  if (!input.claudeCli) return null;
  const r = mergeMarkedInstruction(input.claudeMdContent);
  if (r.status === AgentRuleStatus.ALREADY) {
    return {
      title: AGENT_RULE_TITLE,
      target: CLAUDE_MD_PATH,
      status: StepStatus.ALREADY,
      detail: 'Reticle rule already in CLAUDE.md',
    };
  }
  return {
    title: AGENT_RULE_TITLE,
    target: CLAUDE_MD_PATH,
    status: StepStatus.APPLY,
    detail: AGENT_RULE_DETAIL,
    write: { path: CLAUDE_MD_PATH, content: r.content },
  };
}

/**
 * The Cursor rule is a PROJECT file, so it is written only when Cursor plausibly works on THIS
 * project — the repo has a `.cursor/` dir, or Cursor is the only agent found. `~/.cursor` merely
 * existing on the machine meant every Claude Code user got an unexplained `.cursor/rules/reticle.mdc`
 * committed into their repo. (Global MCP registration is different: it is global, and stays.)
 */
function cursorRuleStep(input: PlanInput): Step | null {
  if (!input.cursorPresent) return null;
  if (input.cursorProjectPresent !== true && input.claudeCli) return null;
  if (input.cursorRuleExists === true) {
    return {
      title: AGENT_RULE_TITLE,
      target: CURSOR_RULE_PATH,
      status: StepStatus.ALREADY,
      detail: 'Reticle rule already in .cursor/rules',
    };
  }
  return {
    title: AGENT_RULE_TITLE,
    target: CURSOR_RULE_PATH,
    status: StepStatus.APPLY,
    detail: AGENT_RULE_DETAIL,
    write: { path: CURSOR_RULE_PATH, content: cursorRuleFile() },
  };
}

/**
 * The behavioral rule that makes the agent actually USE Reticle. Written into the detected agent's
 * instruction file (Claude / Cursor, or both), falling back to the cross-agent AGENTS.md when neither
 * is detected. Rides with the MCP wiring — `--no-mcp` opts out of registering the tools AND the rule.
 */
function agentRuleSteps(input: PlanInput): Step[] {
  if (!input.options.mcp) return [];
  const detected = [claudeRuleStep(input), cursorRuleStep(input)].filter(
    (s): s is Step => s !== null,
  );
  if (detected.length > 0) return detected;
  const r = mergeMarkedInstruction(input.agentsMdContent);
  return [
    r.status === AgentRuleStatus.ALREADY
      ? {
          title: AGENT_RULE_TITLE,
          target: AGENTS_MD_PATH,
          status: StepStatus.ALREADY,
          detail: 'Reticle rule already in AGENTS.md',
        }
      : {
          title: AGENT_RULE_TITLE,
          target: AGENTS_MD_PATH,
          status: StepStatus.APPLY,
          detail: AGENT_RULE_DETAIL,
          write: { path: AGENTS_MD_PATH, content: r.content },
        },
  ];
}

/**
 * What to say when the install command fails.
 *
 * pnpm's `minimumReleaseAge` refuses any release younger than the configured window — a deliberate
 * supply-chain policy, not a bug — with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. Unpinned it silently
 * resolves to an OLDER version instead, which is how an app ends up running a 2.2.1 SDK against a
 * 2.3.0 daemon: the connection succeeds, the protocol disagrees, and the failure surfaces as -32000
 * with nothing naming a version. Pinning turns that into this loud failure, which is the better
 * trade — but only if the message says what to do about it.
 */
function installFailureHint(pm: PackageManager): string {
  if (pm !== PackageManager.PNPM) return 'If the version was refused, install the SDK yourself.';
  return (
    'If pnpm reported ERR_PNPM_NO_MATURE_MATCHING_VERSION, its minimumReleaseAge setting is holding ' +
    'this release back. Either wait out the window, or allow these packages explicitly:\n' +
    '  pnpm config set minimumReleaseAgeExclude "@reticlehq/*"\n' +
    'Do NOT drop the version pin — unpinned, pnpm installs an older SDK against a newer daemon, and ' +
    'that mismatch surfaces as a -32000 with nothing naming a version.'
  );
}

function installStep(input: PlanInput): Step {
  const pm = input.detection.packageManager;
  const packages = pinnedPackages(
    frameworkPackages(input.detection.framework),
    input.options.sdkVersion,
  );
  const command = installCommand(pm, packages);
  if (!input.options.install) {
    return {
      title: 'Install dependencies',
      target: 'package.json',
      status: StepStatus.MANUAL,
      detail: command,
    };
  }
  const parts = installCommandParts(pm, packages);
  return {
    title: 'Install dependencies',
    target: 'package.json',
    status: StepStatus.APPLY,
    detail: command,
    exec: {
      command: parts.command,
      args: parts.args,
      fallback: `${command}\n\n${installFailureHint(pm)}`,
    },
  };
}

function reticleConfigStep(input: PlanInput): Step {
  if (input.reticleConfigExists === true) {
    return {
      title: 'Reticle config',
      target: RETICLE_CONFIG_FILE,
      status: StepStatus.ALREADY,
      detail: '.reticle.json already exists',
    };
  }
  const content = reticleConfigContent(
    input.detection.framework,
    input.options.port,
    input.options.projectId,
  );
  return {
    title: 'Reticle config',
    target: RETICLE_CONFIG_FILE,
    status: StepStatus.APPLY,
    detail: 'write project config (framework + port)',
    write: { path: RETICLE_CONFIG_FILE, content },
  };
}

/**
 * A step that says out loud when the app isn't React. SvelteKit already carries its own unverified
 * note, so it isn't doubled up here.
 */
function uiLibraryStep(input: PlanInput): Step[] {
  const lib = input.detection.uiLibrary;
  if (lib === UiLibrary.REACT || input.detection.framework === Framework.SVELTEKIT) return [];
  if (lib === UiLibrary.UNKNOWN) return [];
  return [
    {
      title: `${lib} is UNVERIFIED`,
      target: 'package.json',
      status: StepStatus.NOTICE,
      detail: unverifiedUiLibraryNote(lib),
    },
  ];
}

export function buildPlan(input: PlanInput): Plan {
  const steps: Step[] = [
    ...mcpSteps(input),
    ...agentRuleSteps(input),
    ...slashCommandSteps(input),
    ...uiLibraryStep(input),
    installStep(input),
    reticleConfigStep(input),
  ];
  if (input.detection.framework === Framework.VITE) {
    steps.push(...viteSteps(input));
  } else if (input.detection.framework === Framework.NEXT) {
    steps.push(...nextSteps(input));
  } else if (input.detection.framework === Framework.ASTRO) {
    steps.push({
      title: 'Connect snippet (Astro)',
      target: 'astro.config + layout',
      status: StepStatus.MANUAL,
      detail: astroManual(input.options.port, input.options.projectId),
    });
  } else if (input.detection.framework === Framework.SVELTEKIT) {
    steps.push(...svelteKitSteps(input));
    // The Vite plugin as well as the client hook. `init` already INSTALLS @reticlehq/vite-plugin for
    // SvelteKit and then never wired it into the config, so it sat in package.json doing nothing —
    // which is why a SvelteKit app connected fine and every verdict came back with no file:line.
    steps.push(...viteSteps(input, VITE_PLUGIN_DETAIL.SVELTEKIT));
  } else {
    steps.push({
      title: 'Connect snippet',
      target: 'index.html',
      status: StepStatus.MANUAL,
      detail: htmlManual(input.options.port, input.options.projectId),
    });
  }
  return { framework: input.detection.framework, steps };
}
