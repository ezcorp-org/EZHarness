# R1 runner transport repair evidence

Commit: `d2222840cf3d2b4963075ffc0f5cf0bdec5ef621`.

The canonical production chain at source `d4ffe706` and image `shipping-9ca27583`
failed R1 before app restart because R1 rebuilt the runner token and socket below
persistent state. The launcher had moved runner transport to its short private root.
The repair reads the launcher-exported socket and token file, validates the runner
inspection wire response and exact operation ID, and keeps the paused-worker cleanup
and evidence sequence explicit.

`old-path-red.*` is a controlled temporary replacement of only the helper transport
lookups. It exits 1 with the expected missing long-state token. `green.*` runs the
actual shared helper against the real launcher runner with the same deliberately long
persistent state; it exits 0 with 1 passing test and 13 assertions. `typecheck.*` is
`bun run typecheck`, whose log records backend, web, backend-test, and web-E2E type
sections; it exits 0. `controller.exit` is 0, and both input-check files confirm the
final bytes were restored after the red control.

The final controller receipt predates the commit, so its provenance names the source
checkout used to prepare the staged repair. `final-inputs.sha256` and
`final-input-check.txt` bind its tested bytes to the committed copies in
`committed-inputs/`; these copies were reconstructed with `git show` from the commit
and are named `.txt` so evidence is inert.

`preliminary-hook-note.txt` records an earlier rejected pre-commit attempt:
`noUnsafeFinally` found cleanup could mask the primary failure. The final commit
replaced that `finally` with ordered error collection; its normal hooks exited 0 with
no warnings, as recorded by the parent.

No authenticated cookies, API keys, traces, or production app logs are included.
The full canonical production suite is the later R1 recovery proof.
