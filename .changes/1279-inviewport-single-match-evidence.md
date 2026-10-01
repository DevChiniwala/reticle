### Fixed

- **`@reticlehq/browser`: `inViewport` is now listed in the evidence when a single element matched.** A predicate asserting `state: "inViewport"` on one button passed correctly, but the evidence descriptor's states were `[present, visible, enabled]` — the pass looked unproved. The describe step now stamps `inViewport` whenever the caller's state filter is `inViewport`, not only when multiple elements matched. Closes [#1279](https://github.com/reticlehq/reticle/issues/1279).
