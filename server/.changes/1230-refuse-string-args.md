### Fixed

- **`@reticlehq/server` — string `args` at tool boundaries now parsed or refused instead of silently discarded.** MCP clients that stringify tool arguments (#1117) sent `"{\"confirmDangerous\":true}"` where the surface expected an object; `asRecord` returned `{}`, silently dropping the agent's input. `coerceRecord` at the three tool-surface boundaries (`act-tools`, `act-sequence-tool`, `dynamic-tools`) now parses valid JSON strings or throws a descriptive type error. Closes [#1230](https://github.com/reticlehq/reticle/issues/1230).
