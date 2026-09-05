# Direct screenshot review

I inspected all 67 clean selected-run PNGs in six contact sheets, then opened the high-risk images at original resolution. The final three canvas images were opened again after the label-spacing repair. `screenshots/SHA256SUMS` identifies the reviewed final files.

The final `hub-tab-bar-after-disable` capture shows the remaining Briefing tab,
the host-owned unavailable-page message, and no stale Notes Dashboard content.
Its full-run source is `artifacts/final2-blob/extracted/`.

## Results

- Canvas desktop light, desktop dark, and 393 × 851 mobile dark: iframe content fits; controls do not clip or overflow; theme backgrounds and headings are legible; primary and secondary colors show the seeded values; range labels read `Spacing scale (0%)` and `Border radius (12px)`; no false modified marker appears.
- Exact-release approval and project authority: desktop and mobile cards remain inside the viewport. The release identity, declared permission JSON, human approval action, and project changes are visible.
- Opaque scanner and unauthorized session boundary: trusted-camera desktop and protected/final mobile states fit their cards. The preview remains isolated and the user-facing state is legible.
- Disable and uninstall: disabled cards and hidden Hub states are visible. The uninstall dialog explicitly states that release history, settings, secrets, stored data, and files remain, and that deletion requires a separate review.
- Failed operations and history: failed authoring and Hub action errors are visible without replacing the retained page state. GitHub proposal history and rerun-pending states remain visible.
- Permission evidence: the install-granted, bundled, MCP, and workflow screenshots now include the actual declaration/current-grant blocks instead of ending above them.

## Defects found during review

1. Payload knob values were absent from form state, which rendered black color controls and false dirty markers. The component now initializes both form and applied state.
2. Metadata-only rerenders reset user edits, and already-parsed object outputs caused a proxy identity loop. The raw output identity guard preserves edits and reseeds only for a new output.
3. Undefined theme tokens made the light controls dark and made headings too dim. The controls now use the defined surface and text tokens.
4. Range labels joined the name and value. Explicit whitespace now separates them.
5. Two permission captures ended above their claimed evidence. Full-page framing now includes declared permissions and current grants.

No remaining clipping, overlap, illegible text, empty color control, or incorrect captured state was found in the final reviewed set. The old mutable per-capability controls are absent from v4; that product decision remains explicit and is not presented as restored parity.
