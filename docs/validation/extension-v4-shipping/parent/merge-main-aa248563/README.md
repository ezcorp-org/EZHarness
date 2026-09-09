# Merge-main checkpoint: `aa248563`

This is a historical merge checkpoint. It records the resolution of incoming main
commit `bd736438` into v4 parent `86017768`; it is not the complete merged-source
regression or production-image validation.

## Provenance

- Merge commit: `aa2485639e052569f997a30ff36a93d3436e1daa`
- Merged tree: `aa18ac61ab491d110af8f98209491fa208f00bfd`
- First parent: `860177681f5ca2eb5b4c2a58cfa32cdb63bcf155`
- Second parent / latest main / PR 248 squash merge commit: `bd7364388d0106364864e18a3d321b13ba978c36`
- PR intent: author-contract ownership, audit repairs, browser lanes, setup
  cleanup, and contributor checks. `metadata/pr248-metadata.json` retains only
  the PR number, title, URL, and the source hash of the private PR payload.

## Merge decisions

- Author declarations remain canonical in
  `@ezcorp/extension-contract/legacy`; the SDK type module re-exports them.
  The host composes author declarations with host-only MCP metadata.
- The host accepts schema versions `2 | 3 | 4`; the public legacy SDK contract
  remains `2 | 3`. The parity input asserts both the legacy boundary and that
  the contract V4 manifest fits the host type.
- The host keeps all 27 granted permission fields, including `hostApi`,
  `networkTcp`, and `secretRead`. Parent field proof records no lost host
  fields and no lost v4 browser lanes.
- GitHub Projects retains `bootSpawn: true` for bundled startup.
- `finalizeSetupError` keeps local controller and subscription cleanup in its
  `finally` path even when durable terminal persistence fails. The committed
  regression test checks that failure path.
- Two obsolete legacy fixture changes are recorded in
  `metadata/parent-resolutions.json`: the v4 source-snapshot test stays, and
  the obsolete bundled auto-grant fixture remains deleted.

## Recorded controllers

The first frozen index tree `048cfb25…` failed unexpectedly: all checks except
TypeScript and one focused test passed; the type cause was missing host schema
version 4. It is a failed historical checkpoint, not a green result.

The second frozen index tree is the merge tree. Its controller exited 0:

| Check | Exit | Seconds |
| --- | ---: | ---: |
| SDK build | 0 | 0 |
| All four typecheck sections | 0 | 28 |
| 36-file focused set | 0 | 23 |
| Lint and source boundaries | 0 | 1 |
| Manifest lock | 0 | 1 |

The focused second receipt reports 657 passing tests in 36 files. It is the
final premerge green evidence. Raw test, typecheck, and runtime logs remain in
the private cache receipt; this directory retains only safe summaries and their
hashes.

## Limits

This checkpoint does not replace the later complete backend, web, browser, or
production-image lanes. It does not publish raw logs, database state, cookies,
or authenticated traces.
