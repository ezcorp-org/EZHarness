# Migration policy reconciliation

This report audits the 84 Gate integrity findings against final source freeze `29d145cf`. `verified` means the cited replacement exists, is in the required runner, and retains the stated invariant. `fixed and verified` means this audit corrected a concrete ledger defect and verified the correction. `blocked` identifies the external maintainer approval required by policy. `product decision pending` means a maintainer must decide whether the removed behavior is acceptable. Gate integrity remains red until a maintainer separately approves the migration dispositions.

Proof keys: B = bundled bootstrap/source identity; L = lifecycle; I = source import/cutover; A = authoring; D = isolated definition/runtime; V = candidate verification; M = MCP staging; P = lazy worker delivery; R = required runner discovery. Each row has the same number as the direct old path and replacement mapping in `src/__tests__/extension-v4-migration-coverage.md`. Detailed old/new assertion and fixture comparisons for rows 2, 3, 5, 6, and 28–52 are in `docs/validation/extension-v4-independent/policy/moved-assertions.md`. Direct positive/denied-path replacement files for rows 54–84 are in `docs/validation/extension-v4-independent/policy/condensed-assertions.md`.

## Finding rows

| # | Result | Independent evidence and limit |
| ---: | --- | --- |
| 1 | blocked | Removed threshold belongs to retired mutable drift-healing source. B/L cover canonical grants, exact approval, and rollback. Human gate approval is still required. |
| 2 | verified | Adapted auto-note suite is in P and C and retains framing, malformed-input, concurrency, and state checks through fresh isolated workers plus durable state. |
| 3 | verified | Adapted docs-updater worker suite exists under first-party integration and is discovered by P and C. |
| 4 | product decision pending | A/I/V cover workspace/build/review; old child draft composition and discard behavior maps to C2/C4. |
| 5 | verified | Adapted github-stats denial/recovery/concurrency suite exists and is discovered by P and C. |
| 6 | verified | Adapted repo-activity suite exists and is discovered by P and C. |
| 7 | verified | P covers real lazy worker delivery, reverse RPC, persistence, and restart under the v4 worker model. |
| 8 | verified | B/L cover capability change and exact-grant mismatch without a critical exception. |
| 9 | verified | B covers unreadable critical source with authority revocation and no candidate. |
| 10 | verified | B preserves disable and release state and proves source change cannot obtain automatic acceptance. |
| 11 | verified | B covers once-only revocation, user choice, snapshot reuse, and immutable active release state. |
| 12 | verified | B/L cover canonical comparison, exact review, races, and audit rollback. |
| 13 | verified | B covers the subscription candidate matrix and proves automatic union/backfill cannot alter approved grants. |
| 14 | verified | B/A cover stale-grant revocation and host-only authoring without granting child draft authority. |
| 15 | verified | B/L replace automatic clamping with exact human-reviewed grants. |
| 16 | verified | B/L cover all-source determinism, containment, blob tamper, and approval binding. |
| 17 | product decision pending | B preserves the active immutable release and creates a candidate; mutable hot reload is absent under C1. |
| 18 | verified | B covers six disable cases, user choice, and idempotent legacy revocation. |
| 19 | product decision pending | I/L cover supported import and containment. Generic Git/update and purge map to C4/C5. |
| 20 | verified | I/L cover deputy declaration without grant and deny caller-approved shortcuts. |
| 21 | verified | I/B/L cover identity preservation, candidate build reuse, and activation fencing without mutating the active release. |
| 22 | verified | I rejects caller-supplied executable metadata and stages collected source. |
| 23 | verified | B/L cover canonical hashes, catalog mismatch, and immutable release binding. |
| 24 | product decision pending | I/D cover v4 validation and immutable marketplace releases; automatic v2 promotion and old executable metadata are absent under C6. |
| 25 | product decision pending | I covers local/GitHub admission and pinned runner dependencies; generic Git is C5. |
| 26 | verified | B covers all eight candidate cases and proves checkout drift cannot heal active grants. |
| 27 | verified | I/D cover source collection, isolated discovery, nested GitHub directory, and missing entry point. |
| 28 | verified | Rename retains 3/3 titles; destination is in P and C. |
| 29 | verified | Rename retains 2/2 titles; destination is in P and C. |
| 30 | verified | Rename retains 4/4 titles; destination is in P and C. |
| 31 | verified | Rename retains 4/4 titles; destination is in P and C. |
| 32 | verified | Rename retains 1/1 title; destination is in P and C. |
| 33 | verified | Rename retains 1/1 title; destination is in P and C. |
| 34 | verified | Rename retains 4/4 titles; destination is in P and C. |
| 35 | verified | Rename retains 2/2 titles; destination is in P and C. |
| 36 | verified | Rename retains 6/6 titles; destination is in P and C. |
| 37 | fixed and verified | Destination is in P and C. This audit corrected the ledger: 31 old titles became 32; definition-only release consent changed and agent-capability drift coverage was added. Direct assertion count changed from 92 to 99. |
| 38 | verified | Rename retains 25/25 titles; destination is in P and C. |
| 39 | verified | Rename retains 115/115 titles; destination is in P and C. |
| 40 | verified | Rename retains 39/39 titles; destination is in P and C. |
| 41 | verified | Rename retains 39/39 titles; destination is in P and C. |
| 42 | verified | Rename retains 2/2 titles; destination is in P and C. |
| 43 | verified | Rename retains 2/2 titles; destination is in P and C. |
| 44 | verified | Rename retains 2/2 titles; destination is in P and C. |
| 45 | verified | Rename retains 20/20 titles; destination is in P and C. |
| 46 | verified | Rename retains 16/16 titles; destination is in P and C. |
| 47 | verified | Rename retains 7/7 titles; destination is in P and C. |
| 48 | verified | Rename retains 2/2 titles; destination is in P and C. |
| 49 | verified | Rename retains 6/6 titles; destination is in P and C. |
| 50 | verified | Rename retains 2/2 titles; destination is in P and C. |
| 51 | verified | Rename retains 5/5 titles; destination is in P and C. |
| 52 | verified | Rename retains 3/3 titles; destination is in P and C. |
| 53 | product decision pending | New editor component covers immutable authoring. Old visual composition and mutable toggles are absent under C2. |
| 54 | product decision pending | Real handler/error tests exist; shared SDK covers framing. `preuninstall` host execution is absent under C6. |
| 55 | verified | Real chained handler, optional failure, exact read error, and no-second-invocation assertions exist; SDK owns framing. |
| 56 | product decision pending | A covers supported authoring. Child draft RPC and destructive discard are absent under C4. |
| 57 | verified | Current table covers response mappings and HTTP failures; host integration covers denial/recovery/concurrency. |
| 58 | product decision pending | Prompt and tool references remain. Legacy `subAgents` metadata is absent under C6. |
| 59 | verified | V4 manifest naming and negative camelCase checks remain; sealed definition is separately tested. |
| 60 | verified | Opt-out and sealed catalog coverage exists. Scoped host API authority replaces raw environment/localhost grants. |
| 61 | verified | Owner/foreign/state-preservation coverage exists, and old modifiable settings cannot authorize execution. |
| 62 | verified | Presentation exclusion, source tamper fidelity, and tool add/remove hash cases remain. |
| 63 | verified | Identity/helpers remain; host non-execution and isolated data/handler validation replace executable stripping. |
| 64 | product decision pending | Canary proves no host import or unsafe reload. Automatic watcher/debounce/shutdown is absent under C1. |
| 65 | verified | Scoped disable/uninstall, validation, conflict, legacy refusal, redaction, and atomic lifecycle publication are covered. |
| 66 | verified | M covers candidate-only MCP staging, credential boundaries, and unchanged active catalog until approval. |
| 67 | verified | Registration/declaration, bootstrap, and real SQL isolated scratchpad behavior are covered. |
| 68 | verified | The old endpoint only refuses, while L/A provide separate positive human approval and agent/API-key denial assertions. |
| 69 | verified | The old install endpoint only refuses, while I provides separate positive local/GitHub admission and owner/admin checks. |
| 70 | product decision pending | L covers exact grants; mutable submit-and-clamp permissions and related UI are absent under C2/C3. |
| 71 | verified | Host-evaluation canaries and isolated manifest/handler/CLI validation cover the supported path. |
| 72 | verified | V covers smoke success and failure, text mismatch, catalog drift, invalid output, absent smoke, and worker close. |
| 73 | verified | Sealed tool declaration and disabled staging/no-backfill cases are covered. |
| 74 | verified | Real handler has allowed and denied paths, and B proves startup cannot restore search authority. |
| 75 | product decision pending | L/A cover exact consent. Mutable per-capability controls and TTL UI are absent under C2/C3. |
| 76 | verified | B/L cover source integrity, exact review, and refusal of live disk preview/healing authority. |
| 77 | verified | M runs the shared matrix for update and tests origin-bound encrypted credentials. |
| 78 | verified | M runs the shared matrix for refresh; L covers atomic audit rollback. |
| 79 | verified | M runs the shared matrix for install with auth, validation, bounds, redaction, and no legacy spawn. |
| 80 | product decision pending | Banner/auth/404 remain. Renewal now refuses; configurable TTL/Never issuance is absent under C3. |
| 81 | product decision pending | A/I/V/D cover the supported workspace/build/review flow. Old child install and destructive draft movement are absent under C2/C4. |
| 82 | verified | Safe filenames and editing remain; immutable revision build/verification replaces host draft verification. |
| 83 | product decision pending | Listing, redaction, disable/uninstall, supported import, and exact approval exist. Purge and generic update map to C4/C5. |
| 84 | product decision pending | Refusal and redaction exist; exact approval is covered by L. Custom TTL/Never issuance is absent under C3. |

## Product decisions

| Decision | Status | Required decision |
| --- | --- | --- |
| C1 Development watcher | product decision pending | Accept removal of watcher, debounce, reload, and development-session shutdown, or require a safe replacement. |
| C2 Permission UI | product decision pending | Accept removal of inline composition and mutable capability toggles, or require a reviewed replacement flow. |
| C3 Grant expiry | product decision pending | Accept removal of per-capability TTL and Never issuance, or define the v4 grant-expiry model. |
| C4 Data removal | product decision pending | Accept immutable history and retained data without destructive discard/purge, or define a separately authorized purge. |
| C5 Imports and updates | product decision pending | Accept supported exact-source imports without generic Git and automatic updates, or define the additional source policy. |
| C6 Host execution | product decision pending | Accept removal of host lifecycle scripts and legacy `subAgents`, or define safe supported semantics. Unsafe host execution must not be restored for nominal parity. |

## Current conclusion

The numbered ledger accounts for all 84 Gate integrity findings and the moved tests are correctly discovered and coverage-measured. The final pools are P=1,564, C=1,550, W=221, residual=14, and critical backend=38. It is not a blanket equivalence proof. Rows 4, 17, 19, 24, 25, 53, 54, 56, 58, 64, 70, 75, 80, 81, 83, and 84 depend on unresolved product decisions. Row 37's ledger defect is corrected in this branch.

Technical tests cannot make Gate integrity green without the separate maintainer decision and label. No acceptance is inferred from the migration document or passing tests.

## Your Actions:

- Decide C1 through C6.
- After review, apply `gate-change-approved` only if all 84 dispositions are acceptable.
