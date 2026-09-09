# Independent image and Chromium evidence: d2222840 checkout on 9ca27583 image

The immutable image is source `9ca275838faf30666da5dba1c0eba141dd053050`; the
checkout used only the four permitted test/verifier changes at
`d2222840cf3d2b4963075ffc0f5cf0bdec5ef621`. Provenance and the exact name-status
diff are retained here.

`container-verifier.log` and `exits.tsv` record a rootless-Podman production boot,
real isolated build, human approval, invocation, disable denial, and retained
history; both container verifier and Chromium exited `0`.

`png/` retains the 12 parent-opened Chromium `onAttach` PNGs and their source
manifest. The parent found no clipping or unreadable controls. The raw browser
blob, traces, network data, server-state attachments, and credentials remain
private. Only the private blob hash and byte count are retained.
