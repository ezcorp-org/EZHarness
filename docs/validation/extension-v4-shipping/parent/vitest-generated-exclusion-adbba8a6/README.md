# Concurrent diagnostic: generated SvelteKit coverage exclusion

This is a focused diagnostic, not serialized backend validation.

The Vitest command started at `2026-09-07 00:36:16 -0400`, while the shared
`validation-heavy.lock` holder `2010839` was active. The pre-run process check
looked only for image-build process names and did not inspect the lock. The
result must not support a final backend or candidate claim.

`vitest.log` retains Vitest's own summary: 3 test files and 117 tests passed.
The command wrapper used zsh and stopped after Vitest when `PIPESTATUS` was
unavailable. Therefore no durable child exit code exists. Do not infer a
recorded command exit from the summary. `verification.exit` is only the later
Bash artifact check: it confirmed no generated parser warning in the retained
log, exactly two real route records in `lcov.info`, and no `.svelte-kit/` LCOV
record.

The intended source repair is in `config.diff`: `coverage.exclude` adds
`**/.svelte-kit/**`. Vitest merges configured exclusions with its built-in
coverage exclusions; source routes remain selected by the two CLI include
globs. `source-commit.txt` and `source-sha256.txt` record the exact dirty
source used by this diagnostic.

The existing `coverage-leg-lcov-guard` test was observed through the tool
console as 40 pass, 0 fail, 152 expectations under Bun 1.3.14. Its stdout was
not retained. It is not represented as a durable receipt and must be rerun
under the serialized canonical backend controller before it can support a
final claim.
