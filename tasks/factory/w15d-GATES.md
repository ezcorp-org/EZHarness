# Gates: W15d store memory and capacity

Scope: the team lead's W15d assignment (2026-09-25) and rulings. Branch `wp/w15d-store-memory` from `integ/w00` at `0a95d765b`. Evidence under `/tmp/factory-platform-evidence/w15d/`: `run1/` and `run2/` (per-second cgroup samples in `memory.csv`), `census-ordinary-01.json`, `logs/`, `receipts/`.

- [x] G1: Measure both stores' memory under the load that killed them, and name the cause of the kills.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 3600 /tmp/factory-platform-evidence/w15d/bin/load.sh run1` (checkpoint and restore suites plus one W19a mock pass, at once) and `W15D_STORAGE_STEP=1 ... load.sh run2` (the same plus the `db-postgres.yml` storage step); `journalctl -k` for the kills
  EXPECT: peaks per store, anonymous memory separately, and whether a kill was the container limit or the host
  EVIDENCE: run1 ordinary 170 MiB, archive 229 MiB; run2 ordinary 1263 MiB (739 MiB anonymous), archive 247 MiB (225 MiB anonymous); no `oom_kill` in either container; host MemAvailable never below 14.1 GiB. Both past kills were host-wide (`CONSTRAINT_NONE`, `global_oom`, swap 0 kB free; 62 `MainThread` processes held 21.6 GiB), the `weed` victims held under 10 MiB resident at `oom_score_adj` 200. Through the Podman socket a container gets 200 whatever it asks for (probe: requested 0 and 100, got 200), so a Compose `oom_score_adj` line cannot help. The 2 GiB limit stays.

- [x] G2: The compose file and the setup documentation state the measured basis.
  CHECK: read `compose.factory-storage.local.yml` and `docs/factory-local-storage.md` ("Memory and the host OOM killer")
  EXPECT: the peaks, the host-wide cause, why compose-created containers inherit 200, and the host-side options (a `podman.service` drop-in with `OOMScoreAdjust=100`, or keeping concurrent work within host memory) named as the host owner's decision; the stale 768 MiB line corrected
  EVIDENCE: this commit.

- [x] G3: Name what fills the ordinary store.
  CHECK: `bun /tmp/factory-platform-evidence/w15d/bin/census.ts ordinary 01 <out>` (read-only ListObjectVersions) and `weed shell fs.du`
  EXPECT: bytes per prefix, live versus deleted-but-retained
  EVIDENCE: `census-ordinary-01.json`: 308 of 400 volumes; tenant-01 holds 16.95 GiB in 59,888 keys, all live, 3 ever deleted. `ordinary/s3-publication` 8.32 GB and `ordinary/s3-published` 8.32 GB (a 256 MiB multipart export per run), `reference-data` 0.89 GB, `factory-material-gateway` 0.39 GB, `factory-lifecycle` 0.18 GB in 33,471 keys, bare digests at the shared root 46 MB (installations and proofs; not a run prefix). Every day since 2026-09-21 added 1.1 to 7.0 GB.

- [x] G4: Proof runs remove what they wrote.
  Change: `createFactoryOrdinaryStorage(prefix, tenant, owns)` in `tests/postgres/helpers/factory-storage.ts`; its `close()` is now async and permanently removes every version and delete marker under the run's prefix and the run-unique prefixes it owns (the three publication destinations), with a paged listing that fails on a truncated page without a continuation. `factoryRunPrefix` refuses fewer than two path segments. `factory-recovery-storage.ts` uses the same code (its old listing read only the first page). The thirteen callers await `close()`.
  CHECK: `tests/postgres/factory-storage-cleanup.test.ts` under PostgreSQL and the real store (registered in the `db-postgres.yml` storage step)
  EXPECT: a blob, two versions of one key, a version and a delete marker of another, and an owned publication object are all gone after `close()`; a neighbouring run whose prefix starts with the same characters is untouched; the guard and the paging hold against a scripted client
  EVIDENCE: `logs/cleanup-test-1.log` 5 pass / 0 fail; the hook and batch receipts at the final head.

- [x] G5: `-volume.max` for the ordinary store raised with its disk basis; the operator prune documented.
  EVIDENCE: 600 x 64 MiB = 37.5 GiB at most; the raise adds at most 18.25 GiB with 145 GB free against the 100 GB floor. The archive store stays at 400 (77 volumes, 80 MB). Leftovers are removed only through `scripts/prune-factory-storage-manifest.ts` with a manifest the coordinator authorizes (the W07 rule; no prefix or time-window deletes).

- [ ] G6: The same load reruns without an OOM once the coordinator recreates the stores with the new command. Open until then.
