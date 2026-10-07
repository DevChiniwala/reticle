### Fixed

- **`@reticlehq/engine` — `compare { as: "number" }` preserves the negative sign on formatted currency.** When the minus sign was separated from the digits by a currency symbol (`-₹11.87`, `-$50.00`, `-€123.45`), `numberOf` matched only the unsigned digits and graded the comparison against a negative server value as a mismatch. The token regex now matches unsigned numbers and resolves the sign from the prefix, so `Refunded -₹11.87` correctly compares equal to `-11.87`. Closes [#1309](https://github.com/reticlehq/reticle/issues/1309).
