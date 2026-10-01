# Gates: W4G-6, the gate-integrity parser in every job that runs the backend suites

Brief: `/tmp/factory-platform-evidence/w00/briefs/w4g.md` (W4G-6, amendment 21:55Z). Base integ/w00 `842ad9fe1`, branch
`wp/w4g-6`. Evidence: `/tmp/factory-platform-evidence/w4g-6/`. Pinned Bun 1.4.2.

Cause: `scripts/gate-integrity-rule11.test.ts` spawns `scripts/gate-integrity.ts`, which fails closed without the
locked TypeScript parser in `.github/gate-integrity-deps`. The coverage shards run that test (it is in
`coverage_host_files`), but only the Gate integrity job installed the parser.

| Requirement | Red | Green | Commit |
| --- | --- | --- | --- |
| Reproduce in the job's shape | `logs/container-red-842ad9fe1.log`: ubuntu 24.04, Bun 1.4.2, git, the root install the setup action does, no parser: 10 pass, 2 fail, both "Gate integrity ERROR (fail-closed): TypeScript AST parser is unavailable" | `logs/container-green-26f6a8ddd.log`: the same container after the shared action's command: 12 pass, 0 fail | `26f6a8ddd` |
| One definition of the install | — | `.github/actions/gate-integrity-deps/action.yml`, a composite action with the one command; the Gate integrity job uses it in place of its own step | `26f6a8ddd` |
| Every job that runs the backend suites installs it | `logs/guard-red.log`: the new registration test at 842ad9fe1, 0 pass, 3 fail; it lists the six jobs that reach the gate without the action | `logs/guard-green.log` 3/0: Factory schema and kernel, Coverage shard, Coverage extras, Backend critical, Residual integration tests and Gate integrity use the action before the step that needs it | `26f6a8ddd` |
| The rule holds | — | `scripts/gate-integrity-deps-registration.test.ts` (in the guard set). Mutants, each red: no `shell` in the action (`logs/guard-mutant-noshell.log`), the shard without the action (`logs/guard-mutant-shard-without.log`), a copied install step (`logs/guard-mutant-copied-step.log`) | `26f6a8ddd` |
| actionlint | `logs/actionlint-base.log`: 3 findings at 842ad9fe1, all the self-hosted labels `factory-gpu` and `factory-real` | `logs/actionlint-head.log`: the same 3 findings, line numbers aside; with those two labels declared (`tools/actionlint-labels.yaml`), 0 errors in 9 workflows (`logs/actionlint-head-labels.log`). actionlint 1.7.7, release checksum verified | `26f6a8ddd` |
| The job graph is unchanged | — | `job-graph.json`: 39 jobs before and after, with the same names, needs, runners, conditions and matrices | `26f6a8ddd` |
| Repository legs | — | lint 0; guard set 13 files, 63/0 (`logs/guard-set.log`); hook: the registration test 3/0 | `26f6a8ddd` |

Note: actionlint reads a local action's inputs but not its steps (a mutant with `shell` removed passed it), so the
registration test holds the action's own shape.
