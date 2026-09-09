# Hosted CI checkpoint: 0728184b

This is a **historical failed checkpoint**, not final success evidence.

- Head: `0728184bfec77d6b3a8dba2b38b431bfed2ad5ef`
- CI: [run 34121216099](https://github.com/ezcorp-org/EZHarness/actions/runs/34121216099) — `failure`
- CI jobs: 30 successful, 5 failed.
- Separate workflows: [External Postgres](https://github.com/ezcorp-org/EZHarness/actions/runs/34121216102) passed; [dependency audit](https://github.com/ezcorp-org/EZHarness/actions/runs/34121216039) passed.

## Passed browser jobs

| Job | Hosted result | Job URL |
| --- | --- | --- |
| Real auth + real DB | 59 passed | [101739432157](https://github.com/ezcorp-org/EZHarness/actions/runs/34121216099/job/101739432157) |
| Mock lane | 220 passed, 13 skipped | [101739432278](https://github.com/ezcorp-org/EZHarness/actions/runs/34121216099/job/101739432278) |
| Visual evidence | 181 passed; 10 passed | [101739432102](https://github.com/ezcorp-org/EZHarness/actions/runs/34121216099/job/101739432102) |

## Failed CI jobs

| Job | Job URL | Recorded reason |
| --- | --- | --- |
| Production image extension lifecycle | [101739432125](https://github.com/ezcorp-org/EZHarness/actions/runs/34121216099/job/101739432125) | Stage 2 conmon launch failed because the hosted conmon lacked journald support; workers exited 126. The killed-worker control could not reach its SIGKILL action because launch failed first. |
| Extension lifecycle (firefox) | [101739432126](https://github.com/ezcorp-org/EZHarness/actions/runs/34121216099/job/101739432126) | Global setup required Chromium, but the job installed Firefox only. No lifecycle test result was reached. |
| Extension lifecycle (webkit) | [101739432181](https://github.com/ezcorp-org/EZHarness/actions/runs/34121216099/job/101739432181) | Global setup required Chromium, but the job installed WebKit only. No lifecycle test result was reached. |
| Gate integrity | [101739432227](https://github.com/ezcorp-org/EZHarness/actions/runs/34121216099/job/101739432227) | 84 findings; the downloaded hosted order exactly matched the local order. Maintainer approval was unset. |
| E2E (mock, no Docker) | [101741143426](https://github.com/ezcorp-org/EZHarness/actions/runs/34121216099/job/101741143426) | Aggregate consequence of failed E2E child jobs; not a separate mock test failure. |

## Gate integrity

The parent independently downloaded the completed job log with exit 0, extracted all 84 ordered findings, and compared them to the local result. The equal normalized stream has SHA-256 `36f3837536cb8847f880bfa0fd78a8beebce0b4440942d1c96e0bf1d1bb262ac`. Categories are 28 deleted tests, 24 renamed tests, 31 gutted tests, and 1 removed threshold. This remains a failed policy gate.

## Evidence boundaries

`checkpoint.json` contains safe job metadata. `private-input-hashes.json` identifies private logs by hash only. Raw logs, traces, blobs, and credentials are not published here. This checkpoint does not establish final CI success.
