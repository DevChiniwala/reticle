### Fixed

- **`@reticlehq/next` — `withReticle(nextConfig, { sourceMapping: false })` now skips the Turbopack stamping loader.** The two-argument form `withReticle(nextConfig, options)` gates webpack source mapping on `options.sourceMapping`, but the Turbopack branch was unconditional — a project that opted out of source mapping still got the Turbopack loader injected, breaking builds that rely on unmodified Turbopack config. The Turbopack key is preserved (user config, if any, is kept), and only the loader rules are omitted. Closes [#1248](https://github.com/reticlehq/reticle/issues/1248).
