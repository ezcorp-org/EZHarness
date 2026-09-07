# Cross-engine lifecycle evidence: d2222840 checkout on 9ca27583 image

Firefox and WebKit each exited `0` for the three real-auth lifecycle tests. The
checkout was `d2222840cf3d2b4963075ffc0f5cf0bdec5ef621`; the image source was
`9ca275838faf30666da5dba1c0eba141dd053050`. The exact allowed checkout/image
diff, source hashes, and remote WebKit health checks are retained.

Each engine directory contains its 12 extracted `onAttach` PNGs and manifest.
The parent opened all 24 cross-engine PNGs and found no clipping or unreadable
control. `parent-browser-byte-verification.json` records the raw-to-extracted-to-curated
byte match, successful `onEnd`, and three passed/error-free results for each engine.
Firefox PNG 04 was produced after programmatic composer fill; it does not prove a
keyboard path. Raw blobs, traces,
network data, server-state attachments, and credentials are excluded; only blob
hashes and sizes are retained.
