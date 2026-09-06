# Final runtime and policy cross-audit

Final source freeze: `29d145cf222255de4110c067e2c07ca1ee42d405` (tree `357e88be9f8efd7b779110de88fbfe4d89d38953`). Base: `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`.

Gate integrity ran with Bun 1.3.14, `BASE_REF` set to the base above, and `GATE_CHANGE_APPROVED` unset. It exited 1 with exactly 84 findings: 1 removed threshold, 27 deleted files, 25 renamed files, and 31 files gutted in place. The numbered reconciliation still has 84 rows: 66 `verified`, 1 `fixed and verified`, 1 `blocked`, and 16 `product decision pending`.

The final discovery pools are P=1,564, C=1,550, W=221, residual=14, and critical backend=38. The weather/city integration, memory management-list regression, and File Organizer journal-authority regression are discovered by the applicable pools. `C ∖ P` remains empty and `P ∖ C` remains the documented 14-file residual pool.

All evidence indexes verify: 47 runtime entries from the runtime artifact directory, 15 top-level policy entries from the repository root, and 7 nested policy artifacts from the repository root. The installed keyless test checks semantic payloads as well as `isError: false`: GitHub identity/repository count, Weather location/current/daily data, City Conditions success/weather/pollen, and Price Chart symbol/points. All four passed. The weather controlled fault restores early global-fetch capture and makes both authority tests fail because no `ezcorp/network.fetch` denial is observed. The restored tests require a broker denial record and then semantic recovery in the same session; both pass.

The optional-host test helper treats `networkHosts: undefined` as no fixture allowlist while retaining dynamic denial. An explicit empty or populated list still enforces the fixture allowlist. No false pass or locally runnable gap mislabeled as an external blocker was found. The local Ollama installed-release authority and persistence check remains correctly assigned as a local follow-up.
