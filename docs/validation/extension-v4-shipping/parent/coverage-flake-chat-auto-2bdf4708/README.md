# Chat and auto-note coverage-flake repair

Source baseline: `2bdf4708594db3e27e25269e7c4fbb7cf0dc87f7`.

The hosted first coverage passes reported one failure in each owned file, then passed their isolated plain retries. The hosted logs retained only file-level results; they did not retain an assertion, stderr, or stack trace. This receipt therefore does not attribute either hosted failure to a specific assertion.

The final inputs replace fixed sleeps with typed bounded waits. The chat event waits register before sending, are consumed in `Promise.all`, unregister on timeout or abort, and the persistence request is cancelled at its deadline. The auto-note notification wait is bounded and abortable. Its owned child records `close` at spawn, preserves spawn errors, and `close()` waits for that `close` event and stdio destruction.

`old-close-control.log.txt` is an actual red control. During that run, only the former fire-and-return termination and close behavior was restored in the current test fixture. The close assertion observed `closeObserved=false` after `close()` returned (exit 1). `auto-note-old-close-control-reconstructed.ts.txt` reproduces those exact temporary control substitutions from the frozen final WIP source; it was regenerated after the control, so it is labeled reconstructed rather than a pre-run capture.

The final covered focused command exited 0: 17 pass, 0 fail, 53 expectations, 9.91 seconds. The original and final test inputs are inert `.ts.txt` copies. No production source changed. The local generated-web typecheck was not a valid check in this new worktree and is intentionally absent; parent runs typechecks from its prepared tree.
