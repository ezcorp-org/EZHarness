# Gates: extension shipping gap closeout

Scope: validate source `bb80bd21de2eb6c9dbe33454b227ff6887a35563` and publish the reviewed report. Main `bd736438` is merged in `aa248563`. Earlier evidence keeps its exact source and image scope.

- [x] G1: Integrate and independently verify the affected product and test repairs.
  EVIDENCE: The [shipping report](../docs/extension-v4-shipping-validation-report.md) records actual failing controls and repaired behavior. The last search/event changes pass 53 focused local cases with coverage, all four typecheck sections, and lint. Normal source publication passes the expanded scan and hooks.
- [x] G2: Complete current backend, browser, production and resource checks.
  EVIDENCE: All twelve backend shards pass on the first attempt with no retry sweep. Browser setup 3, real-auth 62, mock 255, Firefox/WebKit 3 each, and visual 204 pass. Coverage, web, static, Postgres and dependency checks pass. Current production passes all eight checks and eleven cleanup records. Both independent reviews verify nine current app logs, eleven resource samples and 3,675 descriptor rows; no structured error/fatal or retained worker/stream appears. The earlier 30-minute resource proof retains its recorded image scope; no new 30-minute or 24-hour result is claimed.
- [x] G3: Verify final evidence, exact-index expanded scan and normal publication hooks.
  EVIDENCE: Safe backend and browser records are independently checked against actual private logs. All new evidence has complete checksum membership and inert file modes; authored links resolve. The final documentation publication is gated by an exact-index expanded scan, exact committed-tree verification and all normal hooks. The controller fails before push if any check fails.
- [x] G4: Verify the normal push and technical CI for the tested source.
  EVIDENCE: Remote source bb80bd21 matches its scanned tree. All 34 technical CI jobs complete successfully, with separate Postgres and dependency workflows also successful. The final documentation publication controller requires the normal push to match the remote head. The documentation commit must preserve every runtime, test and configuration file from the tested source; its new CI status must not be substituted for source-scoped evidence.
- [x] G5: Keep external limits and approval decisions explicit.
  EVIDENCE: Gate integrity has 83 unapproved findings. A 4.26-second local replay exactly matches all ordered hosted findings. The report retains six product decisions, missing live provider inputs, historical-image limits, the missing current v4 audit pipeline, and the unrun 24-hour check. No policy override, PR merge, ready-state change or deployment occurs.
