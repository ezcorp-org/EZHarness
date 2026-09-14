# W11b — Image pack egress through the guest material mount

Leaf of W11. Closes the two rows W11 left open on the platform's byte path:
G15 (a variant larger than one mebibyte could not leave an isolated guest) and
G18b (the accepted 1,024-pixel variant could therefore not be published).

Branch `wp/w11b-image-egress`, cut from `integ/w00` at `f30da62fa`, which
carries the Terra runtime owner's canonical material mount.
Evidence `/tmp/factory-platform-evidence/w11b/`.

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
      EVIDENCE: `logs/journey-mount.json`, exit 0. All four seeds generated at
      1,024 by 1,024 on the real card (`torch 2.12.0+rocm7.14.1`,
      `hip 7.14.60850`) and all four left through the mount: 2,364,124, 998,116,
      2,425,299 and 2,434,845 bytes. Three of those are more than twice the
      entire control-channel lifetime budget of 1,048,576 bytes, so each one is
      a case the previous path could not carry at all. Every file on disk
      digests to the value the journey recorded.

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
      EVIDENCE: `logs/publication.json`, exit 0. The published variant is seed
      23, the first seed in input order that passed every deterministic claim in
      this run, 998,116 bytes, digest
      `sha256:21b0fa6177170166a0c882a4039bfa27227a7d4db5e920fb2c9255f9e8d109a9`.
      The digest recomputed from the bytes fetched back out of the local
      SeaweedFS store is the same value, and `matchesReceipt` and
      `matchesSource` are both true for it and for the 2,602-byte evidence
      document. A second publication of the confirmed set was refused with
      `factory_s3_manifest_published`. The run deleted exactly the two object
      keys and the manifest key it created.

- [x] B7: The claims still discriminate on real output; the mount changed the
      byte path and nothing else.
      CHECK: same journey
      EXPECT: the byte-level claims pass on conforming variants, the caption
      fixture fails only the OCR claim, and the blank control passes all five.
      EVIDENCE: `logs/journey-mount.json`. All four seeds passed the four
      byte-level claims. Seed 23 passed `ocr-no-text` with its candidate tokens
      below the threshold; seeds 11, 37 and 53 failed it on marks the model
      painted. The drawn caption fixture failed `ocr-no-text` alone and passed
      the other four; the blank control passed all five. The round is
      `round.unmeasured`, correctly, because the semantic quorum never ran.

- [x] B8: The repository gates stay green and the new file is fully covered.
      CHECK: `bun run typecheck`; `bun run lint`; `bun scripts/check-factory-boundaries.ts`;
      `bun scripts/gate-integrity.ts`; `bun test --coverage ./src/factory/reference-image/`;
      `bash scripts/python-quality.sh all`; the `BASE_REF=integ/w00` coverage gates
      EXPECT: all exit 0; 100% of `materials.ts`.
      EVIDENCE: `logs/gates.log`. TypeScript 169 pass / 0 fail / 417 assertions
      across 6 files, with `materials.ts` at 72/72 and the six files W11 added
      still at 100%. Python 183 test cases and 100% of 691 statements and 212
      branches. typecheck, lint, boundaries and gate integrity all exit 0.

## Deviations and findings

1. **The mount must be chowned into the user namespace, and the mode must be
   set first.** A host-created directory is owned by the host user, so the guest
   at uid 65534 gets `EPERM` on its first write; that was the first failing run
   and it is kept. `podman unshare chown 65534:0` performs the chown inside the
   namespace, which is what maps the guest uid to the right host subuid. The
   second failing run is kept too: once the directory belongs to that subuid, a
   host-side `chmod` is itself `EPERM`, so the mode is set while the host still
   owns it. Mode is 0770 rather than 0777, so the guest owns it, the host reads
   back as group, and other gets nothing. W12 hit the same two and their
   validator made them correct the same 0777.

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
`logs/journey-mount.json`, `logs/publication.json`, `logs/gates.log`, and the
two kept failing runs described in Deviations 1 and 2.
