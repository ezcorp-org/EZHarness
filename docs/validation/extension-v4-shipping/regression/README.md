# Backend and coverage regression evidence

This bundle preserves the final canonical backend coverage controller and the
small focused test added after review. It contains no browser artifacts.

## Canonical full run

The controller ran `bash scripts/test-coverage.sh` from
`/home/dev/work/EZCorp/extension-v4-independent-audit` at source
`5133652d6ba7f598aa2e896139fd399526647ea6` with Bun 1.3.14, Node v22.22.2,
`CONMON=/tmp/ez-audit-ci-conmon`, and six workers. Its controller and `tee`
exit codes are both zero.

The retained controller output reports 25,898 passing assertions, zero
failures, and 1,552 shards. The per-file gate passed for 1,249 enforced files.
The SDK, Vitest, harness-client, AI-kit, and security coverage legs exited
zero. The suggest leg exited zero and remains a documented non-gating leg.

- `full-final-5133652d.provenance.txt` records source and tool versions.
- `full-final-5133652d.result.txt` records the two controller exit codes.
- `full-final-5133652d.coverage.log.gz` is the compressed complete controller
  log.
- `full-final-5133652d.lcov` is the merged LCOV input to the gates. Its SHA-256
  is `1f623266bc030cdaba4820ca67d8f17434d5cbf720690e88f58a7a14aad654c3`.

Individual per-shard coverage directories and raw producer output were cleaned
by the canonical controller and are not claimed as retained evidence.

## Post-run gates and focused supplement

The focused assertion change is source-test-only commit
`e121969eac2f39fda4ed56e9ac640d90e888df36`. It verifies that the deferred
recovery callback invokes lifecycle recovery once with the service actor and
the installation identifier, then contains the failure. Its focused result is
18 passing tests and 62 assertions.

The retained LCOV was checked at HEAD `e121969e` against
`origin/main` (`537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`):

- Per-file thresholds: 1,249 enforced files passed.
- New-file coverage: 131 source files gated.
- Patch coverage: 385 changed source files passed.
- Focused lifecycle supplement: passed.

`gate-provenance.txt`, `gate-results.txt`, and the four corresponding logs
preserve those commands and outcomes.

## Credential scan

`secret-scan.txt` records a content-safe scan of all retained text and the
uncompressed controller log. It reports only whether a candidate was found;
it never records matched content.
