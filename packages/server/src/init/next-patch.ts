/**
 * Pure, conservative patchers for the two files a Next app needed edited BY HAND: `next.config.*`
 * (wrap the export in `withReticle`) and `app/layout.tsx` (mount `<ReticleDev />`). Same contract as
 * the Vite patcher — recognise the obvious shape, bail to `manual` on anything ambiguous, never
 * half-edit. Leaving these manual is why Next connected 0% of the time: both edits are silent when
 * skipped, and one of them is JSX.
 */

import { PatchKind, type SourcePatch } from './patch-kind.js';

const RETICLE_NEXT_PACKAGE = '@reticlehq/next';
export const NEXT_CONFIG_IMPORT = `import { withReticle } from '${RETICLE_NEXT_PACKAGE}';`;
export const NEXT_CONFIG_REQUIRE = `const { withReticle } = require('${RETICLE_NEXT_PACKAGE}');`;

const RETICLE_DEV_COMPONENT = 'ReticleDev';
const RETICLE_DEV_BASENAME = 'reticle-dev';
/** Default import specifier: the component sits beside the file importing it (App Router). */
const RETICLE_DEV_SIBLING = `./${RETICLE_DEV_BASENAME}`;
const reticleDevImport = (specifier: string): string =>
  `import { ${RETICLE_DEV_COMPONENT} } from '${specifier}';`;
export const RETICLE_DEV_IMPORT = reticleDevImport(RETICLE_DEV_SIBLING);

/** Where the generated connect component goes, and how the mount file should import it. */
export interface ReticleDevLocation {
  /** Project-relative path to write. */
  path: string;
  /** What the mount file (`app/layout.*` or `pages/_app.*`) should import. */
  importSpecifier: string;
}

/**
 * Decide where the connect component lives, from the file that will mount it.
 *
 * Two things this gets wrong if hardcoded, both of which broke real apps:
 *
 * - **Pages Router routes on presence.** EVERY file under `pages/` is a route, so a component
 *   dropped there has no default export: `/reticle-dev` 500s and `next build` fails. It has to go
 *   somewhere that is not a route directory. App Router routes on FILENAME (`page`/`layout`/
 *   `route`), so an extra file beside the layout is inert and can stay there.
 * - **The extension is not cosmetic.** A `.tsx` file in a JavaScript project makes Next auto-install
 *   TypeScript on the next `next dev` — and on Next 13 that takes its require-hook down with it, so
 *   the dev server never starts. The install then looks like it broke the app, because it did.
 */
export function reticleDevLocation(mountPath: string, typescript: boolean): ReticleDevLocation {
  const ext = typescript ? '.tsx' : '.jsx';
  const slash = mountPath.lastIndexOf('/');
  const dir = slash === -1 ? '' : mountPath.slice(0, slash);
  const isPagesRouter = /(^|\/)pages$/.test(dir);
  if (!isPagesRouter) {
    return {
      path: `${dir === '' ? '' : `${dir}/`}${RETICLE_DEV_BASENAME}${ext}`,
      importSpecifier: RETICLE_DEV_SIBLING,
    };
  }
  // Siblings of `pages/`, so `src/pages/_app.js` → `src/components/…` and `pages/_app.js` → `components/…`.
  const parent = dir.slice(0, Math.max(0, dir.length - 'pages'.length));
  return {
    path: `${parent}components/${RETICLE_DEV_BASENAME}${ext}`,
    importSpecifier: `../components/${RETICLE_DEV_BASENAME}`,
  };
}
/** The dev-guarded mount. Production strips it — `process.env.NODE_ENV` is inlined at build time. */
const RETICLE_DEV_MOUNT = `{process.env.NODE_ENV === 'development' ? <${RETICLE_DEV_COMPONENT} /> : null}`;

/** `export default <expr>;` — the ESM shape every `create-next-app` config uses. */
const ESM_DEFAULT_EXPORT = /export\s+default\s+([\s\S]+?);?\s*$/;
/** `module.exports = <expr>;` — the CJS shape older configs use. */
const CJS_EXPORT = /module\.exports\s*=\s*([\s\S]+?);?\s*$/;
/** The opening `<body ...>` tag, whose first child is where the mount goes. */
const BODY_OPEN_TAG = /<body(\s[^>]*)?>/g;

const NO_EXPORT_REASON = "couldn't find an `export default` or `module.exports` to wrap";
const NO_BODY_REASON = "couldn't find a single <body> tag to mount <ReticleDev /> inside";

export function patchNextConfig(source: string): SourcePatch {
  if (source.includes(RETICLE_NEXT_PACKAGE)) return { kind: PatchKind.ALREADY };

  const esm = ESM_DEFAULT_EXPORT.exec(source);
  if (esm?.[1] !== undefined) {
    const wrapped = source.replace(ESM_DEFAULT_EXPORT, `export default withReticle(${esm[1]});\n`);
    return { kind: PatchKind.APPLY, code: `${NEXT_CONFIG_IMPORT}\n${wrapped}` };
  }

  const cjs = CJS_EXPORT.exec(source);
  if (cjs?.[1] !== undefined) {
    const wrapped = source.replace(CJS_EXPORT, `module.exports = withReticle(${cjs[1]});\n`);
    return { kind: PatchKind.APPLY, code: `${NEXT_CONFIG_REQUIRE}\n${wrapped}` };
  }

  return { kind: PatchKind.MANUAL, reason: NO_EXPORT_REASON };
}

/** `<Component {...pageProps} />` — the one element every `pages/_app` renders. */
const PAGES_APP_COMPONENT = /<Component\b[^>]*\/>/g;
const NO_PAGES_COMPONENT_REASON =
  "couldn't find a single <Component {...pageProps} /> to wrap in pages/_app";

/**
 * Pages Router has no root layout to mount into — `app/layout.tsx` does not exist — so the connect
 * rides in `pages/_app` instead, wrapped in a fragment alongside the page. Without this, `init`
 * wrote `app/reticle-dev.tsx` into a directory the app does not have and nothing ever connected,
 * with no error to say so.
 */
export function patchPagesApp(
  source: string,
  importSpecifier: string = RETICLE_DEV_SIBLING,
): SourcePatch {
  if (source.includes(RETICLE_DEV_COMPONENT)) return { kind: PatchKind.ALREADY };

  const matches = [...source.matchAll(PAGES_APP_COMPONENT)];
  const match = matches.length === 1 ? matches[0] : undefined;
  if (match?.index === undefined)
    return { kind: PatchKind.MANUAL, reason: NO_PAGES_COMPONENT_REASON };

  const wrapped = `<>${RETICLE_DEV_MOUNT}${match[0]}</>`;
  const code = source.slice(0, match.index) + wrapped + source.slice(match.index + match[0].length);
  return { kind: PatchKind.APPLY, code: `${reticleDevImport(importSpecifier)}\n${code}` };
}

export function patchRootLayout(source: string): SourcePatch {
  if (source.includes(RETICLE_DEV_COMPONENT)) return { kind: PatchKind.ALREADY };

  const tags = [...source.matchAll(BODY_OPEN_TAG)];
  // Exactly one <body> or we cannot tell which one actually renders — and mounting into the wrong
  // one is the same silent no-connect as not mounting at all.
  const tag = tags.length === 1 ? tags[0] : undefined;
  if (tag?.index === undefined) return { kind: PatchKind.MANUAL, reason: NO_BODY_REASON };

  const insertAt = tag.index + tag[0].length;
  const mounted = `${source.slice(0, insertAt)}${RETICLE_DEV_MOUNT}${source.slice(insertAt)}`;
  return { kind: PatchKind.APPLY, code: `${RETICLE_DEV_IMPORT}\n${mounted}` };
}
