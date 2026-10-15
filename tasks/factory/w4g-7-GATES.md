# W4G-7: the test certificate helper uses OpenSSL options that Ubuntu 24.04 does not have

Brief: /tmp/factory-platform-evidence/w00/briefs/w4g.md, section W4G-7. Base integ/w00 842ad9fe1. Evidence:
/tmp/factory-platform-evidence/w4g-7/ (logs/, content/, flake/, image/Containerfile, container-legs.sh,
importers-run.sh, suites.txt). Hosted log: /tmp/factory-platform-evidence/w00/wave4g/ci-logs/run2/110562263823.log.
The helper src/__tests__/helpers/factory-certificates.ts is coordinator-owned; the coordinator approved this change.

## Cause

The helper gave the expired and not-yet-valid client certificates their dates with
`openssl x509 -req -not_before … -not_after …`. Those options exist only from OpenSSL 3.4. Ubuntu 24.04 ships 3.0.13,
which prints "x509: Use -help for summary" and exits 1, so the W01k cases' beforeAll failed (2 fails). This host has
3.6.1, so the local chain never saw it.

## Mechanism

Every leaf is signed on one path, `openssl ca -batch -notext`, from a config written into the call's temp folder: its
own index file, `rand_serial`, sha256, policy `commonName = supplied`. Validity is `-days 1` or `-startdate/-enddate`,
which `openssl ca` takes on every OpenSSL from 1.1.1 on. No `x509 -req` is left for leaves. Export signatures are
unchanged.

## Gates

| Requirement | Red | Green | Commit |
|---|---|---|---|
| 1. Red in the runner container (Ubuntu 24.04, OpenSSL 3.0.13, pinned uv, CI's Node 24.14.1 checksum-verified, no nix) with the hosted message | at 842ad9fe1: 8 pass, 2 fail, the two W01k `(unnamed)` cases, "x509: Use -help for summary", the same as the hosted job (logs/test-red-node.log). The first red without Node had 2 more fails, both "node" not found (logs/test-red.log) | | |
| 2. One signing path for every leaf (`openssl ca`, per-call config, rand_serial, own index, policy commonName supplied) | (as 1) | helper diff: the two dated leaves use `-startdate/-enddate`; the leaf loop calls `ca` only | 70877e6aa |
| 3. Same certificate contents | | `openssl x509 -noout -text` of all eight certificates (ca, server, client, foreign, expired, notYetValid, serverAuthOnly, selfSigned), old helper against new on this host: identical once serial, keys, signature and key identifiers are masked (content/text-old, content/text-new, content/diff-*.txt, all empty). Both have the same version, signature algorithm and extensions | 70877e6aa |
| 3a. Dates of the dated leaves | | expired: Not Before Jan 1 00:00:00 2020 GMT, Not After Jan 2 00:00:00 2020 GMT in both. notYetValid: Jan 1 and Jan 2 2099 in both. The `-days 1` leaves have one day in both | 70877e6aa |
| 4. Green at the head, there and here | (as 1) | container at b5e42fb5f: 15 pass, 0 fail (logs/test-green.log). Host (3.6.1): 15/0, and the hook ran it at the head | b5e42fb5f |
| 5. Every importing suite, one process per file, here and in the container | | 38 files reach the helper (suites.txt). Host at 70877e6aa with PostgreSQL: 38 files, 808 pass, 0 fail (logs/importers-green.log). Container at b5e42fb5f with PostgreSQL: 802 pass, 6 fail (logs/test-importers.log). 3 of the fails were the pinned-Bun host path; with it mounted, factory-pool-process passes 3/0 (logs/test-importers-four.log). The other 3 fails are the three suites that run a real Podman guest; a probe prints "Executable not found in $PATH: \"podman\"" (logs/test-probe-reason.log). The container has no Podman; all three pass on this host | 70877e6aa |
| 6. Coverage of the changed helper lines | | through private-https.integration.test.ts: DA:38 106, DA:39 112, DA:46 47, DA:47 236, DA:51 264. Lines 44-45 are comments (cov/lcov.info) | 70877e6aa |
| 7. No writable store beyond the call's temp folder | | strace of every open-for-write and rename while the helper makes all certificates: one folder only, the call's `factory-gateway-*` temp folder (content/strace.log, content/write-dirs.txt) | 70877e6aa |
| 8. Typecheck and lint | | `bun run typecheck` exit 0; biome on both changed files exit 0 | b5e42fb5f |

## A flake found on the way (test-only, its own commit)

"an extra request during accepted work closes the connection before any response" wrote its second request 1 ms after
the first. When the server read both in one chunk, the product answered its pipelining refusal (400 invalid_request),
and the test failed on the bytes. Seen 2 times in 130 runs at the head on a loaded host, 0 in 70 at the base. With no
gap it fails 10/10 with that response (flake/nogap-*.log). The test now writes the extra request after the handler is
entered: 50/50 green (flake/fixed-*.log). A product mutant without the close-during-work branch fails it
(logs/flakefix-mutant.log). Commit b5e42fb5f.

## Hook

The hook maps no suite for the helper (it is under src/__tests__/helpers), so row 5 is the importer run. The flake
commit mapped private-https.integration.test.ts: 15 pass, 0 fail.
