# W11b — Image pack egress through the guest material mount

Leaf of W11. Closes the two rows W11 left open on the platform's byte path:
G15 (a variant larger than one mebibyte could not leave an isolated guest) and
G18b (the accepted 1,024-pixel variant could therefore not be published).

Branch `wp/w11b-image-egress`, cut from `integ/w00` at `f30da62fa`, with
`integ/w00` at `7d99dc75b` merged in.
Evidence `/tmp/factory-platform-evidence/w11b/`.

`integ/w00` at `7d99dc75b` is merged in, bringing W01d: the runner performs the
material directory handover itself at launch, setting mode `0o770` and giving
ownership to the mapped guest uid. This branch adds no `chmod` and no `chown` of
its own; it creates the directory and passes the path. B1, B6 and B7 are closed
against that contract below, on runs made at the merged head.

**Production GPU isolation stays unmet**, on all eight criteria in
`docs/factory-local-gpu.md`. Every generation below ran on this host's AMD
Radeon RX 7900 XTX under `flock $XDG_RUNTIME_DIR/ezcorp-factory-local-gpu.lock`,
held for the whole run. Nothing here reconfigured the GPU or reimaged anything,
and no `compose up` or store management was run.

## What changed

`src/factory/reference-image/materials.ts` is the host-side read-back. The guest
gained an `emit` tool that writes a held image into the mount and declares what
it wrote. The journey script passes `StartRequest.materials`, reads back after
the worker is confirmed stopped, and the deferred-variant path is gone.

## Gates

- [x] B1: The guest writes a 1,024-pixel variant into the mount and the host
      reads it back whole. This is what G15 said was impossible.
      CHECK: `flock $XDG_RUNTIME_DIR/ezcorp-factory-local-gpu.lock flock /tmp/ezcorp-validation-heavy.lock timeout 6600 bun scripts/verify-factory-image-pack.ts --label w11b-mount-egress --fixtures`
      EXPECT: exit 0; every seed `sealed-from-material-mount`; no
      `deferred-over-budget` anywhere.
      EVIDENCE: `logs/journey-w01d.json` and `logs/journey-w01d-round2.json`,
      both exit 0, both at the merged head with the runner performing the
      handover and this script performing none of it. Round one produced
      2,368,441, 998,625, 2,428,174 and 2,436,450 bytes; round two produced
      1,646,345, 1,236,981, 2,402,616 and 2,474,191. Every one of the eight left
      through the mount as `sealed-from-material-mount`, and seven of the eight
      exceed the 1,048,576-byte control-channel lifetime budget outright. Every
      file on disk digests to the value the journey recorded.
      The earlier `logs/journey-mount.json` is retained and does NOT prove this
      gate: it ran against a directory the script chowned itself, which is the
      step W01d moved into the runner.

- [x] B2: Bytes leave only through the shared helpers, never a raw walk or open.
      CHECK: `grep -n "readdir\|[^n]open(" src/factory/reference-image/materials.ts`; `bun scripts/check-factory-boundaries.ts`
      EXPECT: no `readdir` and no bare `open`; the boundary inventory passes.
      EVIDENCE: `materials.ts` imports `listRunnerMaterials` and
      `openRunnerMaterial` from `@ezcorp/extension-runner` and calls nothing
      else against the filesystem, so `O_NOFOLLOW`, the regular-file check and
      the non-blocking open stay in one implementation. The C13 row
      `{ factoryPath: "src/factory/reference-image/materials.ts", sharedModule:
      "packages/@ezcorp/extension-runner/src/index.ts" }` is added to
      `REQUIRED_SHARED_IMPORTS`, and `check-factory-boundaries.ts` exits 0.

- [x] B3: A guest cannot smuggle bytes past the read-back. Every refusal is
      measured, not assumed.
      CHECK: `bun test --timeout 30000 ./src/factory/reference-image/materials.test.ts`
      EXPECT: 18 pass / 0 fail.
      EVIDENCE: the suite. A symlink the guest planted is refused by the shared
      walk. A file it never declared is refused as undeclared. A declared file
      it never wrote is refused as missing. The same path claimed twice is
      refused. A truncated write is refused by byte count, and a lying digest is
      refused after the bytes are read. Nothing reaches the store before the
      bytes verify: on a digest mismatch the store recorded no `begin`, no
      `writeChunk` and no `seal`.

- [x] B4: The read-back happens only after the guest is confirmed stopped.
      CHECK: read the journey's per-seed block.
      EXPECT: `sealGuestMaterials` is called after `worker.close()`, outside the
      `try` that holds the worker.
      EVIDENCE: the seal runs in the loop body after the `finally` that closes
      the worker. The shared helper's own doc states the reason: a running guest
      can swap a directory component between the walk and the open, and no check
      on the host side can close that race.

- [x] B5: The bounds are W04's own, not a second set.
      CHECK: `bun test --timeout 30000 ./src/factory/reference-image/materials.test.ts`
      EXPECT: the walk's entry and byte ceilings equal
      `FACTORY_MATERIAL_LIMITS.maxObjectsPerOperation` and `.maxTotalBytes`.
      EVIDENCE: the suite asserts the equality rather than repeating the
      numbers, so a tree the walk accepted can never be one the store refuses.
      Chunking also respects `maxChunkBytes`: a file one chunk plus seven bytes
      long reaches the store as two chunks of exactly that size and seven.

- [x] B6: The accepted variant publishes through W08 with the digest recomputed
      from the bytes read back out of the real store. This closes G18b for a
      1,024-pixel variant.
      CHECK: `EZCORP_FACTORY_STORAGE_SECRETS_DIR=<secrets> flock /tmp/ezcorp-validation-heavy.lock bun scripts/verify-factory-image-publication.ts --variant <png>`
      EXPECT: exit 0; both files re-fetched and re-hashed; a repeat refused.
      EVIDENCE: `logs/publication-w01d.json`, exit 0, on the variant round two
      produced at the merged head. It is seed 23, the first seed in input order
      that passed every deterministic claim, **1,236,981 bytes**, digest
      `sha256:5a53155fa896377969a9bbe1086f11dff035ff69889380b70d62666bfe39b10a`.
      That is comfortably above the control-channel lifetime budget, so these
      are bytes the previous path could not have carried at all. The digest
      recomputed from what was fetched back out of the local SeaweedFS store is
      the same value, `matchesReceipt` and `matchesSource` are both true for it
      and for the 2,603-byte evidence document, a second publication of the
      confirmed set was refused with `factory_s3_manifest_published`, and the run
      deleted exactly the two object keys and the manifest key it created.

- [x] B7: The claims still discriminate on real output; the mount changed the
      byte path and nothing else.
      CHECK: same journey
      EXPECT: the byte-level claims pass on conforming variants, the caption
      fixture fails only the OCR claim, and the blank control passes all five.
      EVIDENCE: `logs/journey-mount.json`, from the superseded run in B1. All
      four seeds passed the four byte-level claims. Seed 23 passed `ocr-no-text` with its candidate tokens
      below the threshold; seeds 11, 37 and 53 failed it on marks the model
      painted. The drawn caption fixture failed `ocr-no-text` alone and passed
      the other four; the blank control passed all five. The round is
      `round.unmeasured`, correctly, because the semantic quorum never ran.

- [x] B8: The repository gates stay green and the new file is fully covered.
      CHECK: `bun run typecheck`; `bun run lint`; `bun scripts/check-factory-boundaries.ts`;
      `bun scripts/gate-integrity.ts`; `bun test --coverage ./src/factory/reference-image/`;
      `bash scripts/python-quality.sh all`; the `BASE_REF=integ/w00` coverage gates
      EXPECT: all exit 0; 100% of `materials.ts`.
      EVIDENCE: `logs/gates-w01d.log`, measured at the merged head. TypeScript
      194 pass / 0 fail / 447 assertions across 7 files, with `materials.ts` at
      72/72 and the six files W11 added still at 100%. Python 183 test cases and
      100% of 691 statements and 212 branches for this project. typecheck, lint,
      `check-factory-boundaries` and `gate-integrity` all exit 0, and with
      `BASE_REF=integ/w00` the new-file gate passed over 1 new source file and
      the patch gate over 2 changed files. The earlier `logs/gates.log` is
      retained as the pre-merge measurement.

- [x] B9: A round in which nothing passes is rejected, and the second round uses
      a revised prompt. This is C10's own remedy, exercised rather than assumed.
      CHECK: the two journey receipts above.
      EXPECT: round one `round.rejected` with every variant visible; round two
      run with a revised prompt and no third round.
      EVIDENCE: round one with the reference brief produced no passing variant
      and the pack said so: `round.rejected`, "All 4 variants were measured and
      none satisfied the contract", with all four recorded and their OCR
      findings named. C10's remedy for that is a second round with a revised
      prompt, and only in the second, so round two ran once with
      "One green oak tree on a plain white background. No text, no letters, no
      numbers, no watermark, no signature." It produced an accepted variant and
      no third round was run. The same prompt was NOT retried to get a different
      draw; the revision addresses the failure the first round measured, which
      is what makes it remediation rather than a reroll.
      Round two is `round.unmeasured` rather than accepted, correctly, because
      the semantic quorum has no credential to run under (G16).

## Deviations and findings

1. **Making the mount writable is the runner's job, and this branch no longer
   does it.** An earlier revision of the journey script chowned the directory
   itself, and it took two failing runs to get right: a host-created directory
   leaves the guest with `EPERM` on its first write, and once the directory
   belongs to the guest's subuid a host-side `chmod` is itself `EPERM`. Both
   runs are kept. The coordinator then corrected the design: W01d has the runner
   set mode 0o770 and hand ownership over at launch, so a caller creates the
   directory and passes the path and nothing more. The caller-side chown is
   removed rather than left as a belt-and-braces duplicate, because a second
   implementation of an ownership rule living in a script is where a mistake
   spells `0o777`. The script now fails closed against a runner that has not
   handed the directory over, which is what it should do.

2. **The driver's material store reset its buffer on every chunk.** Its
   `writeChunk` returned `begin(...)` for convenience, and `begin` clears the
   part list, so each chunk erased the ones before it and the store sealed
   nothing. The only symptom was a zero-byte file beside a correct-looking
   digest, because `sealGuestMaterials` computes its digest from the bytes it
   read rather than from the store. The driver now re-checks the digest on the
   way in and on the way out, so a store that lost bytes says so instead of
   handing back an empty file. This was a defect in the driver's test double,
   not in `materials.ts`, and it is exactly the failure the digest binding
   exists to catch.

3. **The material store in the journey is in-script and says so in its own
   receipt field.** `FactoryAttemptMaterials` needs a live admitted attempt with
   its journal and authority rows, which is the production dispatch path rather
   than a standalone driver; standing one up here would measure W01's admission
   instead of this pack's egress. The sealing contract is measured against the
   real interface in `materials.test.ts`, and the durable store is W04's.

4. **`sealGuestMaterials` depends on three methods, not the whole service.**
   `FactoryMaterialService` also lists and reads, and sealing needs neither.
   `GuestMaterialSink` names exactly `begin`, `writeChunk` and `seal`;
   `FactoryAttemptMaterials` satisfies it structurally, so the production path
   passes one unchanged and no double has to implement methods the code never
   reaches.

## What stays open, unchanged from W11

1. **G16, the model credential.** `ANTHROPIC_API_KEY` is not set on this host
   and no configured provider reference was supplied. The three semantic
   evaluations' rules, strict answer reader and claim shapes are implemented and
   fully covered; only the live provider leg is missing. The round is therefore
   `round.unmeasured` rather than accepted, which is the correct verdict.
2. **G17, the human-reviewed fixture verdicts.** No verdict in this package or
   in W11 was recorded by a human. C10 asks for a retained human-reviewed tree
   fixture and the reviewer was an agent. Treat the retained verdicts as
   unreviewed until a human signs them.
3. **A mount-time byte bound.** `FACTORY_MATERIAL_LIMITS.maxTotalBytes` is
   enforced on read-back, so an oversized tree never becomes durable, but
   nothing bounds the mount while the guest is running and a guest can still
   fill the host disk. W11 and W12 both asked the Terra runtime owner for this.

## Receipts

`/tmp/factory-platform-evidence/w11b/receipts.json` indexes every record.

**One recorded digest drifted, and the index is now sealed last.** A validator
found `logDigest` for `logs/gates.log` recorded as `sha256:9106502f…` where the
file digested `sha256:f0a55e3b…`. The cause was ordering, not tampering: the
gates producer APPENDS, and after the W01d correction the delta-gate reruns
appended to that log while the correction script updated the commit and the
result fields without recomputing the digest beside them. A digest nobody can
reproduce is worth less than no digest, so the index is regenerated from the
files on disk as the final step, after the last producer has run and after the
commit it names. Every `*Digest` field is now derived by pairing it with its
path field rather than written by hand, so an appended log cannot leave a stale
value behind, and `generatedAt` records when the sealing happened.
`logs/journey-mount.json`, `logs/publication.json`, `logs/gates.log`, and the
two kept failing runs described in Deviations 1 and 2.
