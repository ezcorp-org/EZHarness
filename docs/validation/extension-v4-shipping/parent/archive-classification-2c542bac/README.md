# Archive classification controls — 2c542bac

This safe receipt covers the private staged-secret scanner classifier only. It
uses the final controller, expansion helper, and archive configuration bytes
shown in `inputs/`.

An original private control proved the real gap: a ZIP renamed `.payload` was
not expanded, and the pinned Gitleaks command exited `0`. The earlier suspicion
that extracted members were outside the mounted scan root was disproved. The
helper already writes `expanded-validation-review` inside the staged root. The
repair classifies supported archive formats from bounded bytes, so neutral
extensions are expanded, and rejects unsupported compression signatures before
a partial scan can pass.

Parent replayed the final controls at `2026-09-07T19:55:56Z`: all 16 existing
controls and six classifier controls reached their expected results. A separate
pinned Gitleaks replay at `2026-09-07T19:56:47Z` found exactly one synthetic
GitHub-PAT control in the expanded staged member and found none in the clean
control. The synthetic generator, archive, raw findings, and scan logs remain
private.

This is a classifier/control receipt. It does not claim that the final staged
secret scan has completed. `metadata/` maps every conclusion to private raw
hashes. `SHA256SUMS` covers every published file except itself.
