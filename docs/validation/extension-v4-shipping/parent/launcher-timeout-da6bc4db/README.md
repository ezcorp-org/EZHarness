# Launcher timeout evidence from `da6bc4db`, with diagnostics committed at `480f7c71`

The complete backend residual lane had one transient timeout. It ran
`env CONMON=/tmp/ez-audit-ci-conmon EZCORP_RUN_PODMAN_TESTS=1 RESIDUAL_ONLY=1 /tmp/ez-extension-bun-1.3.14/bun-linux-x64/bun run test`.
The affected test was `src/__tests__/production-image-lifecycle-launch.integration.test.ts`.
The original lane reported `178 pass | 1 fail | 15 files`; the affected test reached its 20,983 ms duration while its fixture deadline is 20,000 ms. The original failure did not retain child output.

This is unresolved as a transient timeout. No timeout, launch, or isolation predicate was changed.

## Reproductions

- `replays/direct`: one exact test invocation at source `da6bc4db`, exit 0; 1 pass, 13 assertions; test duration 1,228 ms.
- `replays/residual`: the same residual selector at source `da6bc4db`, exit 0; 179 pass, 0 fail, 15 files.
- `replays/concurrency`: six simultaneous exact test invocations at source `da6bc4db`, all exit 0; each had 1 pass and 13 assertions. Test durations were 2,299–3,280 ms; process durations were 7.25–8.23 s.
- `replays/diagnostic-direct`: the diagnostic-only test source, exit 0; 1 pass, 13 assertions; 1,216 ms.
- `replays/diagnostic-residual`: the same residual selector with diagnostic-only test source, exit 0; 179 pass, 0 fail, 15 files.

All replays used the pinned Bun 1.3.14 and Node 22 environment. The exact command recorded by the original residual controller is in `original-failure/residual.command.txt`; each replay keeps its recorded provenance and output.

## Committed diagnostic-only source change

`inputs/production-image-lifecycle-launch.integration.test.ts.txt` is the committed test-only input at `480f7c71bc9e23839a6b526ccbfe453ea426ce17`, SHA-256 `4f12443f404f829c12c4de18b9c0683bd14f50d4f748cd1e6c541df36fc4ced0`.
It preserves the 20-second timer and command. If that timer fires, the assertion now includes `runner.log`, `command.log`, and collected child stdout/stderr before the temporary receipt is deleted. This change improves a later failure report; it does not establish or fix a root cause.

`inputs/verify-production-image-lifecycle.sh.txt` and `inputs/start-extension-runner-e2e.sh.txt` are inert copies of the launcher inputs inspected for cancellation behavior.
