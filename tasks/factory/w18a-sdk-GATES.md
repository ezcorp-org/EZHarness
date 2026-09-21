# W18a-sdk gates — split the twenty high-complexity workspace functions

Status: in progress (heavy producers queued on the shared lock)

Branch `wp/w18a-sdk`, from `integ/w00` at `bf010dece`, merged `integ/w00` again at `c1377122b`.
Scope: `packages/@ezcorp/factory-sdk/src/{validation,compiler,schema,kernel,expressions}.ts`,
`packages/@ezcorp/factory-orchestrator/src/workflow.ts`,
`packages/@ezcorp/extension-runner/src/{service,podman}.ts`.
Evidence: `/tmp/factory-platform-evidence/w18a-sdk/`.

## Complexity, before and after

Measured with the AST rules of `scripts/crap-score.ts` (McCabe plus `&&`, `||`, `??`; nested
functions scored separately). At 100 percent coverage CRAP equals complexity, so the gate's
ceiling of 30 is a ceiling on these numbers.

| function (at `integ/w00`) | before | after |
|---|---|---|
| `factory-sdk/src/validation.ts:474 validateCompiledFactory` | 86 | 8 |
| `factory-sdk/src/validation.ts:869 validateFactoryApiRequest` | 82 | 11 |
| `factory-sdk/src/validation.ts:101 validateSchemaNode` | 71 | 9 |
| `factory-sdk/src/validation.ts:400 validateNodeSemantics` | 69 | 6 |
| `factory-sdk/src/validation.ts:984 validateFactoryApiResponse` | 68 | 10 |
| `factory-sdk/src/validation.ts:251 contained` | 50 | 9 |
| `factory-sdk/src/validation.ts:640 validateFactoryRunnerRequest` | 43 | 8 |
| `factory-sdk/src/validation.ts:189 validateValueNode` | 39 | 19 |
| `factory-sdk/src/compiler.ts:400 <anonymous>` (graph pass one) | 86 | 1 |
| `factory-sdk/src/compiler.ts:476 <anonymous>` (graph pass two) | 51 | 1 |
| `factory-sdk/src/compiler.ts:689 compileFactory` | 51 | 9 |
| `factory-sdk/src/compiler.ts:309 inferExpressionSchema` | 36 | 13 |
| `factory-sdk/src/schema.ts:56 validate` | 52 | 14 |
| `factory-sdk/src/kernel.ts:538 applyRepair` | 49 | 20 |
| `factory-sdk/src/kernel.ts:102 advanceKernel` | 32 | 17 |
| `factory-sdk/src/expressions.ts:112 evaluate` | 46 | 9 |
| `factory-sdk/src/expressions.ts:52 inspect` | 31 | 12 |
| `factory-orchestrator/src/workflow.ts:145 factoryWorkflow` | 47 | 25 |
| `extension-runner/src/service.ts:40 handle` | 34 | 6 |
| `extension-runner/src/podman.ts:400 build` | 33 | 15 |

The two graph passes were the anonymous `graph.nodes.forEach` callbacks inside `walkGraph`; each is
now a one-statement callback delegating to a named function (`declareGraphNode` at 7,
`checkGraphNode` at 1). `walkGraph` itself is unchanged at 22.

No function introduced by this package is above 30. The highest remaining in the eight files are
`kernel.ts applyUsage` and `kernel.ts progressMap`, both at exactly 30 and both untouched here.

## Gates

- [ ] G1: No function in the eight files exceeds complexity 30.
  CHECK: `bun /tmp/w18a-cc.ts <the eight files> --min 24`
  EXPECT: `0 function(s) over 30`
  EVIDENCE: `/tmp/factory-platform-evidence/w18a-sdk/complexity-after.txt`

- [ ] G2: Every existing test passes unchanged. No test file was modified, added, or removed.
  CHECK: `git diff --stat integ/w00...HEAD -- '*.test.ts' 'packages/**/test/**'`
  EXPECT: empty
  EVIDENCE: `/tmp/factory-platform-evidence/w18a-sdk/test-diff.txt`

- [ ] G3: Factory SDK suite green at the same counts as before the split.
  CHECK: per-file `bun test --coverage --coverage-reporter=lcov` over `factory-sdk/**/*.test.ts`
  EXPECT: 196 pass, 0 fail across 29 files
  EVIDENCE: `/tmp/factory-platform-evidence/w18a-sdk/sdk-coverage.log`

- [ ] G4: Orchestrator suite green, including the Temporal test-server replay.
  CHECK: `scripts/factory-orchestrator-coverage.sh` under the heavy lock
  EXPECT: exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w18a-sdk/heavy-run.log`

- [ ] G5: Extension-runner suite green, including `tests/podman.integration.test.ts`.
  CHECK: per-file `bun test --coverage` over the runner and contract suites under the heavy lock
  EXPECT: every file exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w18a-sdk/heavy-run.log`

- [ ] G6: The generated JSON schemas are byte-identical.
  CHECK: `bun scripts/check-schema-generate-drift.ts`
  EXPECT: exit 0, 13 schemas match
  EVIDENCE: `/tmp/factory-platform-evidence/w18a-sdk/schema-drift.log`

- [ ] G7: Static gates green.
  CHECK: `bun run typecheck`, `bun run lint`, `bun scripts/check-factory-boundaries.ts`, `bun scripts/gate-integrity.ts`
  EXPECT: all exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w18a-sdk/{typecheck,lint,boundaries,gate-integrity}.log`

- [ ] G8: Patch and new-file coverage over the merged lcov.
  CHECK: `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts && BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`
  EXPECT: both exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w18a-sdk/{new-file-coverage,patch-coverage}.log`

- [ ] G9: CRAP over the merged lcov: every function in the eight files reads at most 30.
  CHECK: `BASE_REF=origin/main bun scripts/crap-score.ts --changed`
  EXPECT: no violation in the eight files
  EVIDENCE: `/tmp/factory-platform-evidence/w18a-sdk/crap-after.txt`

- [x] G10: No gate was weakened. No threshold lowered, no `EXCLUDES` entry, no `.skip/.only/.todo`,
  no `biome.json` opt-out, no new source file (so no new `coverage-thresholds.json` key).
  CHECK: `bun scripts/gate-integrity.ts` and `git diff integ/w00...HEAD --stat`
  EXPECT: gate integrity exit 0; the diff touches only the eight sources plus `tasks/`
  EVIDENCE: `/tmp/factory-platform-evidence/w18a-sdk/gate-integrity.log`
