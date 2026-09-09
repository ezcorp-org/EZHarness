# Firefox/WebKit real-auth cleanup follow-up

This receipt covers checkout `825dc780bb6e407ef29408fc3b31757d55336048`.
It rechecks the real-auth preview wrapper and browser test configuration. It does
not build or exercise an archived production image; product and production-driver
bytes were required to remain unchanged by the controller.

The canonical four-section typecheck exited 0. The four fixture ownership cases
exited 0. The three lifecycle cases passed in Firefox and WebKit, each with exit
0. The cleanup check after each engine and the terminal cleanup boundary exited
0. `runtime-cleanup-metadata.json` keeps only empty-file counts and hashes for
random fixture-root observations; the root names remain private.

`frozen-inputs/` retains the exact controller and test/configuration inputs.
`frozen-input-verification.json` verifies their bytes against the source receipt.
`png-attachment-manifest.json` binds each of 24 extracted PNGs to its private
raw blob archive, test ID, attachment label, hash, and byte count. The raw blobs,
traces, authenticated data, and server state are not published here.

`cleanup-control/` retains only the inert cleanup function bytes and controlled
rejection/cleanup exits. It does not retain the temporary root path.

The parent independently verified all 24 raw attachment bytes and opened ten
selected images, five per engine. Permission review, transformed output, the narrow
mobile selector, build diagnostics, and removed-release state were readable, with
no visible clipped control. `parent-byte-verification.json` names the ten images.
It does not claim that all 24 images were opened.
