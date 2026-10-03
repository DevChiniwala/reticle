### Fixed

- **`@reticlehq/server` — unrelated duplicate POSTs no longer downgrade verdicts in `act_and_wait` and replay.** `act_and_wait` now passes the caller's declared `namedNetUrls` to the contradiction engine, and `verify_change`'s replay path separates advisory findings from verdict-deciding ones. An unrelated background duplicate (analytics beacon, retry loop) is reported as `duplicate-request-unrelated` but no longer forces `verified: "no"`. Duplicates on a predicate-named endpoint still downgrade the verdict. Closes [#1235](https://github.com/reticlehq/reticle/issues/1235).
