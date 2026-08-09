/**
 * How each framework gets wired: the Vite plugin, the three Next files, the SvelteKit client hook.
 * Split out of `plan.ts` — that file is the plan's SHAPE (statuses, ordering, the agent/MCP steps),
 * this one is the per-framework detail, and they grow for different reasons.
 */

import { patchViteConfig, VitePatchKind } from './vite-config.js';
import { patchNextConfig, patchRootLayout, patchPagesApp } from './next-patch.js';
import { PatchKind, type SourcePatch } from './patch-kind.js';
import {
  viteManual,
  NEXT_LAYOUT_MANUAL,
  NEXT_LAYOUT_PATH,
  viteDevModuleFile,
  VITE_DEV_MODULE_PATH,
  nextReticleDevFile,
  NEXT_RETICLE_DEV_PATH,
  nextConfigManual,
  svelteKitHooksFile,
  SVELTEKIT_HOOKS_PATH,
  UNVERIFIED_FRAMEWORK_NOTE,
} from './snippets.js';
import { StepStatus, type PlanInput, type Step } from './plan.js';

/** What adding `reticle()` to a Vite config buys, which differs by framework. */
export const VITE_PLUGIN_DETAIL = {
  /** A plain Vite app gets both halves from the plugin. */
  VITE: 'add reticle() to plugins (also injects connect())',
  /**
   * SvelteKit renders through app.html, so the plugin's HTML injection never fires and connect()
   * comes from the client hook instead. The plugin is still required: it is what stamps
   * data-reticle-source into .svelte components, and without it every verdict on a SvelteKit app
   * comes back with no file:line at all.
   */
  SVELTEKIT: 'add reticle() to plugins (stamps data-reticle-source in .svelte components)',
} as const;

export const CAPABILITIES_TITLE = 'Capabilities + store';

/**
 * The dev module carrying `registerCapabilities` / `registerStore`.
 *
 * Without it every app came up `hasCapabilities: false` with a `reticle_state` holding nothing but
 * `__reticle_renders` — the state-truth read was unavailable on every app out of the box. Written
 * only when absent, because it is the one generated file a user is expected to EDIT.
 */
function capabilitiesStep(input: PlanInput): Step[] {
  if (input.viteDevModuleExists === true) {
    return [
      {
        title: CAPABILITIES_TITLE,
        target: VITE_DEV_MODULE_PATH,
        status: StepStatus.ALREADY,
        detail: 'file exists — left alone, it is yours to edit',
      },
    ];
  }
  const testids = input.testids ?? [];
  const stores = input.storeHints ?? [];
  const found =
    testids.length > 0
      ? `${String(testids.length)} data-testid values`
      : 'no data-testid values yet';
  return [
    {
      title: CAPABILITIES_TITLE,
      target: VITE_DEV_MODULE_PATH,
      status: StepStatus.APPLY,
      detail: `${found}; ${stores.length > 0 ? `store: uncomment the ${String(stores.length)} suggested line(s)` : 'no state library detected'}`,
      write: { path: VITE_DEV_MODULE_PATH, content: viteDevModuleFile(testids, stores) },
      dependsOnInstall: true,
    },
  ];
}

export function viteSteps(input: PlanInput, detail: string = VITE_PLUGIN_DETAIL.VITE): Step[] {
  // Capabilities are independent of whether the config needed patching. Attaching them to the APPLY
  // branch meant a re-run on an already-wired app silently never created the module.
  return [...viteConfigSteps(input, detail), ...capabilitiesStep(input)];
}

function viteConfigSteps(input: PlanInput, detail: string): Step[] {
  const cfg = input.viteConfig;
  const port = input.options.port;
  if (cfg === null) {
    return [
      {
        title: 'Vite plugin',
        target: 'vite.config',
        status: StepStatus.MANUAL,
        detail: viteManual(port),
      },
    ];
  }
  const patch = patchViteConfig(cfg.source, port);
  if (patch.kind === VitePatchKind.ALREADY) {
    return [
      {
        title: 'Vite plugin',
        target: cfg.path,
        status: StepStatus.ALREADY,
        detail: 'reticle() already in plugins',
      },
    ];
  }
  if (patch.kind === VitePatchKind.MANUAL) {
    return [
      {
        title: 'Vite plugin',
        target: cfg.path,
        status: StepStatus.MANUAL,
        detail: `${patch.reason}\n\n${viteManual(port)}`,
      },
    ];
  }
  return [
    {
      title: 'Vite plugin',
      target: cfg.path,
      status: StepStatus.APPLY,
      detail,
      write: { path: cfg.path, content: patch.code },
      dependsOnInstall: true,
    },
  ];
}

/**
 * Turn a conservative source patch into a step: applied when it patched, already when the wiring is
 * there, and the hand-edit instructions when the file shape wasn't one we recognise.
 */
function patchStep(
  title: string,
  path: string,
  patch: SourcePatch,
  applyDetail: string,
  manualDetail: string,
): Step {
  if (patch.kind === PatchKind.ALREADY) {
    return { title, target: path, status: StepStatus.ALREADY, detail: 'already wired' };
  }
  if (patch.kind === PatchKind.MANUAL) {
    return {
      title,
      target: path,
      status: StepStatus.MANUAL,
      detail: `${patch.reason}\n\n${manualDetail}`,
    };
  }
  return {
    title,
    target: path,
    status: StepStatus.APPLY,
    detail: applyDetail,
    write: { path, content: patch.code },
    dependsOnInstall: true,
  };
}

/**
 * Next used to be the ONLY stack with hand edits left over — and both of them fail silently when
 * skipped, so a Next user's app booted, connected to nothing, and said nothing about why. Both are
 * now patched by the same conservative rules the Vite config gets.
 */
export function nextSteps(input: PlanInput): Step[] {
  const configFile = input.nextConfigFile ?? 'next.config.mjs';
  const devPath = input.nextReticleDevPath ?? NEXT_RETICLE_DEV_PATH;
  const devFile: Step = input.nextReticleDevExists
    ? {
        title: 'ReticleDev component',
        target: devPath,
        status: StepStatus.ALREADY,
        detail: 'file exists',
      }
    : {
        title: 'ReticleDev component',
        target: devPath,
        status: StepStatus.APPLY,
        detail: 'create dev-only connect component',
        write: {
          path: devPath,
          content: nextReticleDevFile(
            input.options.port,
            input.options.projectId,
            input.testids ?? [],
            input.storeHints ?? [],
          ),
        },
        dependsOnInstall: true,
      };

  const configPatch: SourcePatch =
    input.nextConfigSource === null || input.nextConfigSource === undefined
      ? { kind: PatchKind.MANUAL, reason: `no ${configFile} found` }
      : patchNextConfig(input.nextConfigSource);
  const layout = input.nextLayout ?? null;
  // Pages Router mounts through pages/_app, App Router through the root layout — different edits,
  // and picking by path is what stops a Pages app being handed the layout patch that cannot apply.
  const isPagesRouter = layout !== null && /(^|\/)pages\/_app\.[jt]sx?$/.test(layout.path);
  const layoutPatch: SourcePatch =
    layout === null
      ? { kind: PatchKind.MANUAL, reason: 'no root layout (app/layout.tsx) or pages/_app found' }
      : isPagesRouter
        ? patchPagesApp(layout.source, input.nextReticleDevImport)
        : patchRootLayout(layout.source);

  return [
    devFile,
    patchStep(
      'Next config (withReticle)',
      configFile,
      configPatch,
      'wrap the export in withReticle (source mapping, dev-only)',
      nextConfigManual(configFile),
    ),
    patchStep(
      'Mount ReticleDev',
      layout?.path ?? NEXT_LAYOUT_PATH,
      layoutPatch,
      'mount <ReticleDev /> in the root layout (dev-only)',
      NEXT_LAYOUT_MANUAL,
    ),
  ];
}

/**
 * SvelteKit is WIRED but not SUPPORTED, and the plan says so out loud.
 *
 * There is no SvelteKit app in `apps/` and no CI gate for one, so nothing proves this hook still
 * registers a session — every other framework init offers (React, Next, Remix, Astro) has both. The
 * wiring is real and may well work; what is missing is anything that would tell us when it stops.
 * Silently emitting it reads as a support claim, which is the thing this project exists to not do.
 */
export function svelteKitSteps(input: PlanInput): Step[] {
  const unverified: Step = {
    title: 'SvelteKit is UNVERIFIED',
    target: SVELTEKIT_HOOKS_PATH,
    status: StepStatus.NOTICE,
    detail: UNVERIFIED_FRAMEWORK_NOTE,
  };
  // SvelteKit can't use the Vite-plugin injection (it renders via app.html) — wire a client hook
  // that SvelteKit runs on startup, which is the path that can register a session at all.
  if (input.svelteKitHooksExists === true) {
    return [
      unverified,
      {
        title: 'Reticle client hook',
        target: SVELTEKIT_HOOKS_PATH,
        status: StepStatus.ALREADY,
        detail: 'file exists',
      },
    ];
  }
  return [
    unverified,
    {
      title: 'Reticle client hook',
      target: SVELTEKIT_HOOKS_PATH,
      status: StepStatus.APPLY,
      detail: 'create dev-only client connect (SvelteKit renders via app.html)',
      write: {
        path: SVELTEKIT_HOOKS_PATH,
        content: svelteKitHooksFile(input.options.port, input.options.projectId),
      },
      dependsOnInstall: true,
    },
  ];
}
