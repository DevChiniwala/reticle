### Fixed

- **`@reticlehq/engine`: a throttled miss with render evidence is now graded `no`, not `unknown`.** On a throttled tab, every failed assertion was stamped `inconclusive` even when the evidence proved the page rendered: a role+name near-miss listing real elements, or present testids on the page. The throttle annotation now checks the result's evidence for `nearMiss`, `presentTestids`, and `splitText` before blaming starvation. A truly starved tab (no render evidence) stays `unknown`. Closes [#1253](https://github.com/reticlehq/reticle/issues/1253).
