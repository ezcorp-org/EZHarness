# Browser regression receipt

Source tested: `e121969eac2f39fda4ed56e9ac640d90e888df36`.

Tools: Bun 1.3.14; Node v22.22.2; Chromium.

The later delta through `29eefc057be55c114761762a1fd4d3b9aa55c1fc` contains the extension failure-text color and the AI-kit package-lock and manifest-lock repair. The final three-engine lifecycle browser run covers the UI delta; final production-image checks cover the frozen dependency repair. This receipt does not claim to test a later source revision.

| Lane | Exit | Result |
| --- | ---: | --- |
| Full mock gate | 0 | 210 passed; 13 skipped; 94 s |
| Full real-auth | 0 | 59 passed; 343 s |
| Visual selection | 0 | `__ALL__` |
| Canonical visual capture | 0 | 180 mock evidence tests; 10 real-auth evidence tests; 319 s |
| Blob-image extraction | 0 | 294 safe PNG attachments |
| CI runner install | 1 | NixOS is intentionally rejected by the ephemeral Debian/Ubuntu installer guard; this is not a product test result. A separate `--probe` receipt is stored with the static checks. |

The controller exit is 1 only because it preserves the installer guard exit. Each browser lane above exited 0.

Retained safe screenshots show the visible marketplace-import form, completed real tool output, and lifecycle workspace. The raw blobs, traces, cookies, and server logs remain private in the ignored validation cache.
