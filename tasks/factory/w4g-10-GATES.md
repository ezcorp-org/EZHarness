# Gates: W4G-10, the context-initialization flake

Brief: the coordinator's order (web/src/__tests__/context-initialization.server.test.ts fails at vitest's 5 s default
when the whole suite runs in one process on a loaded host; fix the root cause, not the timeout). Base integ/w00
`84a9ef717`, branch `wp/w4g-10`. Evidence: `/tmp/factory-platform-evidence/w4g-10/`. Pinned Bun 1.4.2. The load is one
busy process per CPU (32) beside the test, under the heavy lock (`under-load.sh`).

## Root cause, measured

- Why each test re-imports: the suite pins `ensureInitialized()`'s latch, a module-level promise, so each test needs a
  fresh `$lib/server/context` (`vi.resetModules()`, then a dynamic import).
- The re-import is not the cost. Timed per test (`probes/context-initialization-timing.server.test.ts`): on an idle host
  the first import takes 3601 ms and the next three 52 to 59 ms (`timing-idle.txt`); under the load the first takes 6253
  to 8907 ms and the second 1244 to 3894 ms, because it lands behind the first one still running (`timing-red.txt`).
- The cost is the one-time cold load of the server graph `context.ts` imports, transform included, charged to the
  first test's 5 s budget. Traced by added import time (`deps-*.txt`): workflow-approvals-hub-page (1.9 s) >
  workflow-answer-approval > workflow-executor (2.4 s) > workflow-tool-runner (2.0 s) > extensions/registry (1.9 s)
  and extensions/tool-executor (1.3 s); context.ts imports those cores directly as well, so no single import carries it.

| Requirement | Red | Green | Commit |
| --- | --- | --- | --- |
| The flake reproduced under load | The unmodified test file from 84a9ef717, beside the hog: 5 of 5 runs fail, 2 tests each, load 12 to 26 (`logs/red-green-real.out`, `logs/real-base-run*.log`) | The fixed file beside the same hog: 5 of 5 runs pass, load 31 to 35 (`logs/real-fixed-run*.log`) | this commit |
| The fix | — | The cold load is paid once in `beforeAll`, under vitest's default 10 s hook budget; each test still re-imports a fresh module after `vi.resetModules()`. Per-test imports under the load: 89 to 212 ms (`timing-green.txt`, `timing-green-hook.txt`). No timeout is changed. | this commit |
| Nothing else broken | — | typecheck 0, lint 0; web vitest in the hosted shape, three shards: 631 files, 7843 tests | this commit |

## Margin, and the option for the coordinator

- Under the 32-process hog, `beforeAll` itself takes 5996 to 8886 ms (`timing-green-hook.txt`) against the 10 s default
  hook budget: the flake is gone from the tests, but the hook's worst margin under that load is about 1.1 s.
- Option (b), not applied: stub the collaborators `context.ts` reaches only after `initDb` (workflow-executor, the
  extension registry, the tool executor, the agent executor). The cold load then takes 2048 ms idle and 4839 to 5441 ms
  under the hog (`timing-stubbed*.txt`, `probes/context-initialization-stubbed.server.test.ts`). It changes the suite's
  stated design ("Only `$server/db/connection` is replaced here"), so it is the coordinator's call.
