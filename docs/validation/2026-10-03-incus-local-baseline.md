# Local command baseline — 2026-10-03

One local run passed the same bounded Python, Git and Compose commands used by the native proof driver. This is an overlapping-command baseline. It is not a current-app benchmark, a deployment acceptance result, or proof that Incus is faster or slower.

The [machine-readable receipt](2026-10-03-incus-local-baseline-receipt.json) records exact fixture contents, shell commands, command output, exit codes, timestamps, elapsed times and raw `/proc` observations. SHA-256: `f26de0520941788b712645710687fa8dc41249b85cd981e9204acec53551c003`. It contains no credentials or provider error material. The private checkout path is omitted; the checkout was retained for review.

## Exact inputs

- Approved enhanced native driver SHA-256: `624ee9873b433d4f8570890d9d62d3850be4d8be6464702de5c0571b4026c4d2`.
- Driver test SHA-256: `5d9acf1cec48657b5ff2c6e5ad5db888c69eb29122d8cfdda4f59dc65c2f5669` (separate driver test receipt: 8 passed, 62 assertions).
- Baseline plan generator SHA-256: `f07a41e0642b02ff9c602acdee3a80b67da6933504de67ee58b94d68e7cd1f90`; runner SHA-256: `dd5d0c2ee99c1f44181b1e423079386167ac4a45c0cc054e94d4e58ce1d02a28`. These operator artifacts are ignored under `.cache/incus-native-project/`.
- Image: `docker.io/library/busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e`. The one approved exact-digest pull preceded measurement. Resolved Linux/amd64 matches host x86_64. Platform RepoDigest: `sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4`.
- Python 3.13.15, Git 2.55.0, Docker Compose 5.5.1. Existing rootless Podman socket; engine security readback includes `name=rootless`. No daemon or host configuration change.
- Nonce `849b49531d7cbfbd`; Git commit `58817820396f70f02b9a45e268fca65f06d0a750`.

## Observations

| Stage | Elapsed ms | Result |
| --- | ---: | --- |
| Rootless engine readback | 645.60 | Pass |
| Directory and Git initialization | 29.42 | Pass |
| Exact fixture writes | 0.14 | Pass |
| Python unittest | 49.97 | 3 tests passed |
| Compose run and down | 1603.80 | Exact marker; `--pull never` |
| Tests, Git commit and clean checkout read | 210.53 | Pass |
| Retained checkout tests and HEAD read | 113.16 | Same HEAD; 3 tests passed |
| Exact Compose-project container inspection | 127.42 | No containers retained |

Elapsed times are single-run monotonic observations. Each command had a bounded timeout and no retry. Work ran in a new mode-0700 private temporary directory as the operator user. Compose used only the exact pinned image and unique project. The receipt includes the exact command arguments and raw outputs; fixture writes were measured separately.

Raw host samples were taken before work, during work, after work and immediately afterward under the name `idle`. That last sample is **not a stabilized idle measurement**. No numeric acceptance thresholds exist in this record.

The local operator user and rootless engine differ from guest user `sandbox` and the guest engine. A comparison must retain these differences. Only matching command stages can be compared with native guest observations. Incus provisioning, bootstrap, model inference, tool approvals, HTTP latency, retention across an engine restart, host pressure acceptance and the ten-cycle fault requirements are not measured by this baseline.
