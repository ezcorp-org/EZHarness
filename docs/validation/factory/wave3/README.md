# Wave 3 integration receipts

Each `wave3*-staging-results.json` records one combined run of `combined-integration.py.txt`
on `integ/w00` at the head it names, one line per producer with its exit code, start and end.
The matching `-coverage-results.json` and the `new-file` and `patch` logs record the two
coverage gates against the pre-feature bases `644987ada` and `c6ac529d2`. The
`*-validation-results*.json` files are the independent validators' verdicts for the packages
merged in this wave.

Correction. `wave3d` (head `332bec1bc`) was recorded as green when its two patch gates were red
on four executor lines (`src/runtime/workflow-executor.ts` 1296, 1322, 1404 and
`src/runtime/workflow-capability-hash.ts` 567). The lines were covered by W13's legacy regression
suites, which the runner's focused set did not include, and the runner's final verdict did not
fold the gate exit codes in. Both defects are fixed in the runner (it now always runs those suites,
fails on a red gate, and refuses a dirty tree before taking the lock); `wave3e` proved three of the
four lines and `wave3f` (head `3d7fed172`, after the W01e merge and the runner corrections) is green on every producer and
both gates. The `wave3d` files are kept as recorded.
