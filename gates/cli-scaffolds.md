# Gates: Typed CLI scaffolds

- [x] C1: The actual CLI preserves default source and all four explicit SDK scaffold types.
  CHECK: bun test src/__tests__/cli-ext-typed-scaffold.test.ts
  EXPECT: 0 fail
  EVIDENCE: `/tmp/ez-cli-typed-cohort.log`: actual child-process CLI test passes with 53 assertions. Every generated file matches its SDK template.
- [x] C2: Invalid types fail before creating source; all scaffold content comes from the shared SDK.
  EVIDENCE: The actual CLI rejects unsupported and missing type values without creating the target directory. No new scaffold template is copied into the CLI.
- [x] C3: CLI dispatch tests, type checks, and changed-source coverage pass.
  EVIDENCE: Focused CLI host module coverage is 59/59 lines. CLI dispatch coverage includes absent, explicit, and missing type values (20 tests, 36 assertions). `/tmp/ez-types44.log`, `/tmp/ez-coverage-parent-final3.log`, and `/tmp/ez-patch-coverage-final3.log` pass.
