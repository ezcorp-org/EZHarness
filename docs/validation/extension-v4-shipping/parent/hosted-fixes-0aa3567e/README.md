# Hosted-fix controller evidence

The parent controller at source `0aa3567ec07640345f4a8787c33cd08c59a057db` ran from `2026-09-07T12:59:15Z` to `2026-09-07T13:09:23Z`. Its terminal controller and cleanup exits are both zero. `results.tsv` records zero exits for the Stage 2 TCP/IPv6 proof, four-section typecheck, 59-case authenticated Chromium suite, its cleanup, 10-case visual suite, and its cleanup.

`controller.sh.txt` and `inputs/` are inert copies of the frozen controller and checked source inputs. `source-inputs.sha256` binds them to the source files captured before execution. The two private Playwright blob archives remain outside this directory. `private-blob-identities.json` retains only their paths, hashes, byte counts, and parsed status/retry/error counts. `png-attachment-manifest.json` binds each retained PNG to one private blob hash, its safe spec and label, hash, and byte count.

No raw blob reports, traces, authentication state, browser result JSON, or runtime logs from the authenticated suites are copied. The full and visual terminal counts and reporter metadata are represented only in `terminal-results.json` and the private-blob summaries.

The earlier restricted Firefox/WebKit proof is limited to the setup change committed as `d4ec18c4`; it established that real-auth setup no longer requires Chromium in selected-engine jobs. This controller instead validates the integrated source above with Chromium, Stage 2, typecheck, full authentication, visual evidence, and fixture cleanup.

The parent independently verified the terminal controller and cleanup exits, all eleven frozen inputs against Git source `0aa3567e`, and the controller bytes. The visual blob reporter has 10 passed tests, zero errors, and ten `onTestBegin` entries with retry zero. The parent opened eight original visual PNGs named in `parent-ui-review.json`: lifecycle review, live output, mobile-narrow tool selection, browser diagnostics, source-import mobile, source-import output, source-import permission update, and uninstall retention. Those eight had no visibly clipped or unreadable control. This is a selected-image review, not a claim that every retained PNG was opened.

Parent independently compares all 63 PNG attachments with their published copies, all eleven frozen source inputs, and eleven exact controller/receipt files. `parent-byte-verification.json` records the result.
