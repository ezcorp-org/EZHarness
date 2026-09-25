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
  Change: `createFactoryOrdinaryStorage(prefix, tenant, owns)` in `tests/postgres/helpers/factory-storage.ts`; its `close()` is now async and permanently removes every version and delete marker under the run's prefix and the run-unique prefixes it owns (the three publication destinations), with a paged listing that fails on a truncated page without a continuation, and DeleteObjects calls of at most 1000 versions that fail on any per-key refusal (validator-3 F3). `factoryRunPrefix` refuses fewer than two path segments. `factory-recovery-storage.ts` uses the same code (its old listing read only the first page). The thirteen callers await `close()`.
  CHECK: `tests/postgres/factory-storage-cleanup.test.ts` under PostgreSQL and the real store (registered in the `db-postgres.yml` storage step)
  EXPECT: a blob, two versions of one key, a version and a delete marker of another, and an owned publication object are all gone after `close()`; a neighbouring run whose prefix starts with the same characters is untouched; the guard and the paging hold against a scripted client
  EVIDENCE: at `a98677a06`: `receipts/pg-storage-cleanup.json` 5/0; the pre-commit hook ran all 14 mapped suites, 0 fail (`logs/commit-hook.log`). Red: with `close()` not removing, the real-store case fails (`logs/cleanup-red.log`). Callers one file per step (`logs/batch-callers.log`, `receipts/pg-caller-*.json`): archive-writer 10, artifact-materials 29, child-artifacts 5, encryption-s3 2, guest-material-broker 23, legacy-workflow 22, package-preparation 22, private-service 5, reference-data 11, run-inputs 5, run-lifecycle-s3 73, s3-publication 18, validator-materials 9; 234 pass, 0 fail. The recovery-helper suites (checkpoint, restore, retention, key rotation) 44/0 and the other storage suites (artifacts, artifact-access, lazy-input, definitions, lazy-commands) 30/0 in `logs/batch-1.log`. One combined step of the 13 callers under coverage hit its 25-minute bound (exit 124, `receipts/pg-storage-callers.json`); run one file per step, each passed well inside it.
  Leftover check: a census before (`census-before-batch.json`, 61,247 keys) and after (`census-after-batch.json`, 61,254) the batches. The only 7 new keys were written 17:21:51Z to 17:22:30Z, before this batch's first storage suite at 17:23:41Z, by the run holding the lock before it; none came from these runs, including s3-publication's 256 MiB export.

- [x] G4b: Static gates at `a98677a06` with `BASE_REF=0a95d765b`: typecheck, lint, boundaries, gate integrity 0; suite registration 5/0; new-file and patch coverage 0 (`logs/batch-1.log`).

- [x] G5: `-volume.max` for the ordinary store stays 400 with its disk basis; the operator prune documented.
  EVIDENCE: validator-3 F1. A raise to 600 (37.5 GiB) would take the host from 106 GB free to about 86 GB, under the 100 GB floor, while the 17.5 GiB backlog exists. The ceiling must keep the host above the floor at recreate time; it rises only after the reviewed-manifest prune lands, with the free space measured then (a one-line follow-up). The archive store stays at 400 (77 volumes, 80 MB). Leftovers are removed only through `scripts/prune-factory-storage-manifest.ts` with a manifest the coordinator authorizes (the W07 rule; no prefix or time-window deletes).

- [ ] G6: The same load reruns without an OOM once the coordinator recreates the stores with the new command. Open until then.

- [x] G7 (validator-3 F2): the red run at 17:00:45Z left 7 versions under its own prefixes; removed.
  CHECK: `removeFactoryRunObjects` on `ordinary/w15d-cleanup/9b128849-b7c8-4fe6-8adb-3b89deeb0834`, its `...x` neighbour, and `ordinary/w15d-cleanup-published/9b128849-...`
  EXPECT: 5, 1, and 1 versions removed; all three empty afterwards; nothing left under `ordinary/w15d-cleanup` or `ordinary/w15d-cleanup-published`
  EVIDENCE: `f2-dry.json` (listing), `f2-applied.json` at 2026-09-25T18:37:48Z (removed 5/1/1, after 0/0/0), `f2-check.txt` (0 under both parents). In the red run `close()` removed nothing by design, so the run left its objects. The census comparison missed them because they were written before the first census and so appeared in both.

- [x] G8 (validator-3 F3): deletions are batched.
  CHECK: `tests/postgres/factory-storage-cleanup.test.ts`, scripted client cases
  EXPECT: 2,345 versions over three listing pages go in DeleteObjects calls of 1000, 1000, and 345, each version named once; a version and its marker share one call; an empty run sends no delete; a per-key refusal fails the cleanup naming the first refusal; the real-store case still passes
  EVIDENCE: at `e5fb31f87` (`logs/batch-2.log`, `logs/batch-callers-2.log`): cleanup suite 7/0 (the pre-commit hook also ran it, 7/0, `logs/commit-hook-f.log`); typecheck, lint, boundaries, gate integrity, new-file and patch coverage 0; suite registration 5/0; recovery suites 44/0; other storage suites 30/0; the 13 callers one per step 234/0 in 13 minutes (22 minutes one delete per version). Nothing left under `ordinary/w15d-cleanup` or `ordinary/w15d-cleanup-published` afterwards (`f3-check.txt`).

