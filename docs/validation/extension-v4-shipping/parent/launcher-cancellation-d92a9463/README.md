# Launcher cancellation repair evidence

This receipt records a separate reproduced cancellation defect in the production
image lifecycle launcher. It does not identify the root cause of the earlier
20-second residual timeout recorded in `launcher-timeout-da6bc4db`.

## Reproduced defect

The red integration case started the real lifecycle launcher with its normal
extension-runner setup and a verifier that kept both itself and a TERM-ignoring
descendant alive. Sending SIGTERM to the launcher left the verifier, descendant,
runner, and captured stdout/stderr live; Docker Compose had not run `down`.
`diagnosis/e2e-red/` records that 1-pass/1-fail execution, exit 1.

The repair starts the verifier in an owned `setsid` process group, records its
leader, and makes launcher cleanup stop that group with bounded TERM then KILL.
It keeps verifier status and `tee` status propagation. The tests prove both a
cancellation after group readiness and cancellation before readiness; the latter
never releases the verifier command.

## Failed repair attempts

`diagnosis/failed-attempts/first-group-cleanup/` retains the first group cleanup
attempt: the launcher and runner stopped, but the verifier group and pipes stayed
live.

`diagnosis/failed-attempts/marker-format/` retains the next failed attempt. The
outer single-quoted `bash -c` script contained `printf '%s\n'`. That nested quote
ended the outer quote and made the inner format `%sn`; the marker contained a PID
followed by `n` (for example `2184143n`). It was not an empty-file race. The
validated group parser rejected the malformed marker, so cleanup fell back to the
starter PID. The repair writes the marker with inner double quotes:
`printf "%s\n" "$group_pid"`.

## Successful checks

- `results/focused/`: exact focused command, exit 0; 4 tests passed, 39
  assertions, 10.46 seconds. It proves normal lifecycle behavior, cancellation
  cleanup, immediate pre-ready cancellation, and verifier/tee failure status.
- `results/residual/`: canonical `RESIDUAL_ONLY=1` command, exit 0; 182 passed,
  0 failed, 15 files.

No matching owned launcher, lifecycle verifier, or extension-runner process
remained after either successful run. `inputs/` contains exact tested source
bytes as inert `.txt` files. `source-mapping.txt` states their relation to the
current audit checkout. `reproduce.sh.txt` is the bounded two-command replay.
