# Gates: Incus operator control probes

- [x] G1: Four distinct AMD canaries and exact user-project inputs are required. Missing or changed inputs fail closed.
  EVIDENCE: `IncusLiveControlProbes` validates four separate canonical regular files. Focused tests change one canary, remove a project, and reject a duplicate canary path.
- [x] G2: Denied paths use actual feature and admission code. A missing project quota and stale generation are rejected by `SandboxAdmissionStore`; unsupported and unqualified presets are rejected by `IncusFeatureService.prepare`.
  EVIDENCE: Focused PGlite tests run real stores and verify `PROJECT_QUOTA_NOT_CONFIGURED` and `STALE_GENERATION` rows. A deliberate unreviewed image alias is checked through `HostIncusLiveReadback.image` in production.
- [x] G3: Before and after snapshots read durable reservation and operation IDs, a scoped Incus instance inventory, and exact AMD canary bytes.
  EVIDENCE: The production inventory uses `HostIncusLifecycleTransport` with the reviewed connection, release, preset, project, and server certificate pin. It is bounded to 100 pages and errors on invalid replies. Focused tests prove changed inventory and canary bytes are visible.
- [ ] G4: A live isolated-app run uses four operator-provisioned user projects, two allocation-free bindings, four AMD canary files, a configured host budget, one deliberately absent project quota, and an unqualified second declared preset. No such controlled inputs are provisioned yet. Do not claim SP01 or full qualification.
- [ ] G5: Integrate this probe into the witness and run the complete repository checks. This file supplies the probe only; witness integration belongs to its owner.

## Review

Focused tests: 6 passed, 44 assertions. Isolated LCOV: 24/24 functions and 203/203 lines (100% each). Biome: clean. Full repository typecheck: passed. Server state was not changed.
