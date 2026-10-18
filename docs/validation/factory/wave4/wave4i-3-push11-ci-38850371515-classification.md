# ci 38850371515 (PR 341 at ff8331a70, attempt 1, 2026-10-16 04:23-04:53Z): classification

59 jobs: 55 success, 3 skipped, 1 failure. deps-audit 38850371442: success.

| Job | Result | Class | Reason |
|---|---|---|---|
| Factory runner readiness precheck | failure | A | needs the factory-real runner host and its three secrets (a user item); red on main too |
| Factory deployment and operations | skipped | B | cascade: needs the precheck |
| Factory isolation | skipped | B | cascade: needs the precheck |
| Factory product and domain E2E | skipped | B | cascade: needs the precheck |

Parity: main's own ci 38591921239 on 934531e2e and PR 341 attempt 2 (38525604869, its latest attempt) have the
IDENTICAL failed and skipped set. No new red, none fixed, no job added or gone. Every other job success,
including "Production proof (resources)" on the first attempt (W4H-30), Gate integrity (no label), the per-file
coverage gate, Coverage shard 0 and "Factory image under shipped isolation". No class C, D or E.
