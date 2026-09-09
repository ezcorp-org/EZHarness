# Parent verification receipts

Current product source: `9ca275838faf30666da5dba1c0eba141dd053050`. The request-body repair and archived image build pass their focused checks. The canonical resource run passes 317 cycles and 3,170 reconnects in 1,800,154 ms. Test/verifier source `d2222840` passes the complete production suite, independent container checks, and all three lifecycle cases in each browser engine. The complete backend and web regressions also pass. Final evidence/secret checks and hosted CI remain pending. Earlier results below identify their actual source and do not certify the latest product change. The final status belongs in [the shipping report](../../../extension-v4-shipping-validation-report.md).

| Latest repair evidence | Result and scope |
| --- | --- |
| [Current image build](candidate-image-9ca27583/README.md) | Build and transfer pass; Docker and native Podman IDs and source labels match. Raw image healthcheck attribution is retained. |
| [Canonical resource duration](r4-canonical-9ca27583/README.md) | The unchanged driver passes 317 cycles and 3,170 reconnects in 1,800,154 ms, with 26.2 MiB maximum post-warm memory growth against the 64 MiB limit. |
| [Body formats](payload-formats-d4ffe706/README.md) | Real HTTP multipart and empty-body checks pass. Parent passes all 13 payload cases and the full typecheck follow-up. |
| [First complete checkpoint](candidate-suite-d4ffe706-first/README.md) | Seven of eight production checks pass. R1 fails at the obsolete runner inspection path before app death; later browser stages did not run. |
| [Runner inspection repair](r1-runner-transport-d2222840/README.md) | The actual consumer fails with the old paths and passes with the exported transport. Parent verifies all four typecheck sections, normal hooks, and exact committed input bytes. The complete app-recovery replay now passes in the current production suite. |
| [Current production suite](candidate-suite-d2222840/README.md) | All eight leaves pass. Parent verifies exact effects, all 28 bootstrap builds after each crash, eleven cleanups, historical limits, and complete app logs. |
| [Current independent verifier](independent-d2222840/README.md) | Container verification and Chromium lifecycle pass; parent reviews and byte-verifies all 12 images. |
| [Current Firefox and WebKit](engines-d2222840/README.md) | Both engines pass all three cases; parent reviews and byte-verifies all 24 images. |
| [Current complete backend](backend-d2222840/README.md) | 25,980 passes, zero failures; 179 residual passes and all coverage gates pass. Parent verifies actual terminal logs and archived LCOV bytes. |
| [Current complete web/browser](web-browser-d2222840/README.txt) | All static, component, unit, broad browser and visual lanes pass. Parent verifies all 294 PNG bytes and opens eight selected full-auth images. Mock-server error attribution remains under review. |
| [Current policy findings](gate-integrity-d2222840/README.md) | The same 84 findings remain; no new or removed finding. Maintainer approval remains external. |
| [Archive expansion controls](scan-expansion-controls/README.md) | Nested archive members and duplicate filenames retain distinct bytes. Corrupt archives and unsafe paths fail. These controls do not replace the pending staged secret scan. |
| [Request-body repair](payload-retention-repair-9ca27583/README.md) | Actual HTTP regression passes with the repaired stream and fails with former native admission. Parent typechecks pass. |
| [Heap diagnosis](r4-heap-retention-473f955a/README.md) | Private observation records 59 memory-limit breaches, then stops at the conversation quota. HTTP isolation supports the body-handling repair. No passing duration result. |

The following receipts precede the latest product repair.

| Earlier receipt | Result and scope |
| --- | --- |
| [Production suite](candidate-suite-adbba8a6/README.md) | All eight leaves pass; exact effects, historical limits, and parent app-log review are retained. |
| [Independent verifier](independent-adbba8a6/README.md) | Container eight checks and Chromium three cases pass; parent reviewed all 12 screenshots. |
| [Final engine repair](webkit-reload-causal-e65a18a4/README.md) | Chromium, Firefox and WebKit each pass three cases; strict red control and full typecheck pass their expected predicates. Parent verified and opened all12 final WebKit screenshots. |
| [Resource diagnostics](r4-memory-diagnostics-156fd9a4/README.md) | Both sustained runs fail the unchanged64MiB memory budget. Process and container measurements attribute growth to private anonymous memory; the later heap diagnosis above isolates a supported cause. |
| [Earlier engine replay](engines-adbba8a6/README.md) | Firefox three pass; WebKit two pass and reload diagnostics fail. This failure is repaired by the final receipt above. |
| [Candidate build](candidate-adbba8a6/README.md) | Archived source build and identical Docker/Podman image IDs. |
| [Embedding red](embedding-repair-red/README.md) and [green](embedding-http-green-adbba8a6/README.md) | The same HTTP check fails on the defective image and persists a real vector on the repaired image. |
| [Web and browser](web-browser-adbba8a6/README.txt) | Full component/web tests, 210 mock, 59 authenticated and 180+10 visual cases pass. Original evidence-file type-check failure and corrected focused passes remain separate. |
| [Final backend](final-backend-156fd9a4/README.md) | 25,975 passes, zero failures; residual and all coverage gates pass. Parent verified actual exits and LCOV. |
| [SDK transport repair](sdk-tarball-transport-adbba8a6/README.md) | Original complete-run timeout reproduced; the owned offline tarball fixture passes both the SDK leg and the final complete backend run. |
| [Backend failure](backend-adbba8a6-first/README.md) | Full coverage fails the SDK tarball hook; no authoritative LCOV is published from this run. |
| [SDK full environment](sdk-full-env-adbba8a6/) | All 1,029 SDK cases pass alone, including the Podman case. Concurrent canonical legs also pass. These early subsets did not resolve the complete-run timeout; see the later transport repair. |
| [Coverage diagnostic](vitest-generated-exclusion-adbba8a6/README.md) | Generated Svelte inputs are excluded; this concurrent preliminary run lacks a captured test exit. The final backend receipt above supplies the later complete proof. |
| [Dependency path review](dependency-audit-path-review-adbba8a6/README.md) | Existing audit policy passes; matches and expiry dates remain unchanged. |

The following entries describe earlier checkpoints and failed intermediate images.


The parent independently reviewed the Terra changes and repeated the focused
import, recovery, proxy, and mock cleanup checks. These four files passed
14, 18, 31, and 16 tests respectively, with zero failures. The logs and exact
test-file hashes are retained here. The files are unchanged since `e121969e`.

The parent compared the retained canonical LCOV byte for byte with the active
coverage input, then repeated all three coverage gates at `9b541ff5` against
main `537f074e`. All 1,249 thresholds, 131 new files, and 385 changed files
passed. `coverage-gates/` records the inputs, actual exits, and complete output.

The archived image build used committed product source
`29eefc057be55c114761762a1fd4d3b9aa55c1fc`. Build and transfer both exited zero.
Docker and native rootless Podman contain the same image:
`sha256:ce6f2a71d22ba2d5f0ebd0e9701fc5ac55c4a714bfd9ac3c14ccdc876d3b9754`.
The build log, transfer log, complete image inspection, and source receipt are
retained. This intermediate image still has the File Organizer first-use defect and the runner-contention defect. It is not the final shipping image.

The old-image suite reported seven successful exits, but parent state inspection invalidated its broad success claim: File Organizer accepted a failed proposal and restart bootstrap left 28 failed builds. The strict File Organizer test now reproduces the failed effect; focused repair evidence is in `file-organizer-repair/`. A new image, strengthened recovery assertions, and final replays remain pending.

`candidate-60a3421b/` records the next image build and exact engine IDs.
`candidate-suite-60a3421b/` retains the completed intermediate suite at driver
`890df5405dd1b2a59a0eba16acce013a639696dd`. Its overall exit is 1: File Organizer
fails the actual file effect and R2 times out waiting for bootstrap. R1 verifies
all 28 bundled builds; revocation, bounded resource checks, historical upgrade
and restore, and legacy adoption pass. Each leaf retains its command and cleanup
exit. Raw authenticated browser traces remain private. Final proof remains open.

Current follow-up evidence: [review navigation and CI wiring](review-navigation-2d7e2e87/README.md), [real-auth fixture cleanup](real-auth-cleanup-30031f43/README.md), [scoped mock SSR request diagnostic](mock-ssr-diagnostic-d2222840/README.md), [raw browser artifact quarantine](evidence-quarantine-d2222840/README.md), and [Zstandard archive controls](scan-expansion-zstd-controls/README.md). The [full b5 web run](web-browser-b5d2d691/README.txt) retains its test-only typecheck failure and thirteen successful lanes. The [825 type and engine follow-up](engines-cleanup-825dc780/README.md) passes every check. The [outgoing-history review](outgoing-history-825dc780/README.md) classifies seven operation UUID matches; the [expanded staged scan](staged-secret-scan-825dc780/README.md) passes with zero findings after [coverage archive publication](coverage-archive-publication-825dc780/README.md). Final publication hooks and hosted results remain pending.
