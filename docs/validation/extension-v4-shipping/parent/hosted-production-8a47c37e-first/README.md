# Hosted production checkpoint: 8a47c37e

This is a **historical failed checkpoint**, not final success evidence.

- Pushed head: `8a47c37eb62773ed8ad72d632bc6a65f878c98dd`
- CI: [run 34126606100](https://github.com/ezcorp-org/EZHarness/actions/runs/34126606100) — `failure`
- CI result: 32 successful jobs and 3 failed jobs.
- External Postgres: [run 34126606103](https://github.com/ezcorp-org/EZHarness/actions/runs/34126606103) passed.
- Dependency audit: [run 34126606175](https://github.com/ezcorp-org/EZHarness/actions/runs/34126606175) passed.

## Browser jobs

All five browser jobs passed according to independently parsed private logs.

| Job | Job | Passed | Skipped |
| --- | --- | ---: | ---: |
| Extension lifecycle (firefox) | [101756645552](https://github.com/ezcorp-org/EZHarness/actions/runs/34126606100/job/101756645552) | 3 | 0 |
| Extension lifecycle (webkit) | [101756645537](https://github.com/ezcorp-org/EZHarness/actions/runs/34126606100/job/101756645537) | 3 | 0 |
| E2E (real auth + real DB) | [101756645427](https://github.com/ezcorp-org/EZHarness/actions/runs/34126606100/job/101756645427) | 59 | 0 |
| E2E mock lane | [101756645053](https://github.com/ezcorp-org/EZHarness/actions/runs/34126606100/job/101756645053) | 220 | 13 |
| Visual evidence | [101756645590](https://github.com/ezcorp-org/EZHarness/actions/runs/34126606100/job/101756645590) | 181 + 10 | 0 |

## Failed CI jobs

| Job | Job | Reason |
| --- | --- | --- |
| Production image extension lifecycle | [101756645307](https://github.com/ezcorp-org/EZHarness/actions/runs/34126606100/job/101756645307) | The production artifact has seven passing leaves and one failing embeddings leaf: an embedding-cache `EACCES` error. |
| E2E (mock, no Docker) | [101770385142](https://github.com/ezcorp-org/EZHarness/actions/runs/34126606100/job/101770385142) | Aggregate consequence of the production image lifecycle failure, not a separate mock browser failure. |
| Gate integrity | [101756645209](https://github.com/ezcorp-org/EZHarness/actions/runs/34126606100/job/101756645209) | 84 unchanged findings; approval was unset. Ordered finding hash: `36f3837536cb8847f880bfa0fd78a8beebce0b4440942d1c96e0bf1d1bb262ac`. |

## Production artifact

The candidate OCI image was `sha256:870c4c4cc52bafc01bd6ecc9e3c86119379e83615d112df3e42290144c03d290`. GitHub built it from synthetic merge `df82bdf844ec53938963262bae443c5c45ab4863`. The parent fetched that merge and confirmed its tree `fb4771465c8b195204710b7cd2147a6c30502cc5` equals the pushed head tree.

The downloaded production artifact contains eight leaves: seven command exits were 0 and embeddings exited 1. All eleven retained command receipts report log collection exit 0 and owned cleanup exit 0; these cleanup results do **not** mean application logs were error-free. The safe structured-log summary contains the candidate embedding cache `EACCES` and a separate historical seed `GITHUB_TOKEN` manifest refusal.

## Evidence boundaries

`checkpoint.json` and `private-input-hashes.json` contain safe metadata and hashes. Raw hosted logs, production artifacts, request data, persistent state, traces, blobs, and credentials are not published in this directory. This checkpoint does not establish a successful hosted production run.
