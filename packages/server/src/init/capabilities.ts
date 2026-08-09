/**
 * What the app can be driven by: its `data-testid` values, and which state library holds its truth.
 *
 * `init` wired none of this, so every app came up with `hasCapabilities: false`, empty capabilities,
 * and a `reticle_state` holding nothing but `__reticle_renders` — the state-truth read that SKILL.md
 * calls the highest-value line was unavailable on every app out of the box. Measured across six.
 *
 * Testids are scanned rather than asked for. Stores are NAMED but not wired: detecting that an app
 * depends on zustand is easy, knowing which module exports the store instance is not, and generating
 * a wrong import would break the dev module that everything else now hangs off.
 */

/** `data-testid="foo"` / `data-testid='foo'` / `data-testid={"foo"}` — the forms people actually write. */
const TESTID_ATTR = /data-testid\s*=\s*[{]?\s*["'`]([^"'`]+)["'`]/g;

/** Cap the generated list. A capabilities block is a hint for an agent, not an inventory. */
export const MAX_TESTIDS = 60;

/** Every distinct `data-testid` literal in the given sources, in first-seen order. */
export function scanTestids(sources: readonly string[]): string[] {
  const found = new Set<string>();
  for (const src of sources) {
    for (const m of src.matchAll(TESTID_ATTR)) {
      const id = m[1];
      if (id !== undefined && id.length > 0) found.add(id);
      if (found.size >= MAX_TESTIDS) return [...found];
    }
  }
  return [...found];
}

/**
 * State libraries the browser SDK has an adapter for, in the order we would recommend registering
 * them. TanStack Query is first on purpose: a stale cache served as fresh fires NO network request,
 * so the network log shows silence and the DOM shows a plausible number — the cache is the only
 * witness, which makes it the highest-value store in the list and the least obvious one to add.
 */
const STORE_LIBRARIES: readonly (readonly [dep: string, hint: string])[] = [
  ['@tanstack/react-query', "registerStore('queries', tanstackQueryStore(queryClient))"],
  [
    'zustand',
    "registerStore('app', useStore) // pass the store itself, not () => store.getState()",
  ],
  ['@reduxjs/toolkit', "registerStore('app', store)"],
  ['redux', "registerStore('app', store)"],
  ['jotai', "registerStore('app', jotaiStore(getDefaultStore(), { cart, user }))"],
  ['valtio', "registerStore('app', valtioStore(state))"],
  ['mobx', "registerStore('app', mobxStore(state))"],
  ['xstate', "registerStore('machine', xstateStore(actor))"],
  ['pinia', "registerStore('cart', piniaStore(useCartStore()))"],
  ['svelte', "registerStore('cart', svelteStore(cartStore))"],
];

/** The store libraries this app depends on, as ready-to-uncomment registration lines. */
export function storeHints(deps: ReadonlySet<string>): string[] {
  return STORE_LIBRARIES.filter(([dep]) => deps.has(dep)).map(([, hint]) => hint);
}
