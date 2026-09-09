# Independent candidate evidence: Chromium and container verifier

Candidate source is recorded in `source_commit_sha`; image metadata is in
`image-inspect.json`. `container-verifier.log` records the rootless-Podman v4
checks, and `exits.tsv` records their exits.

The Chromium test title map was derived from the blob report's `onProject`
test-ID mapping. Only safe `onAttach` PNGs and client diagnostics were copied.
The blob archive, raw report JSON, trace, network, and server-state attachment
are intentionally excluded.

This directory covers the independent container verifier and Chromium only.
Firefox and WebKit outcomes are recorded separately in the sibling
`engines-adbba8a6` evidence directory after their controller writes exits.

The parent opened all 12 retained PNGs at full size. `parent-visual-review.json` records the reviewed bytes and findings.
