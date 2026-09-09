# Cross-engine extension lifecycle evidence

The controller wrote terminal exits: Firefox `0`, WebKit `1`, controller `1`.
`source_commit_sha` and `source-files.sha256` provide provenance. `command.txt`
records the two actual browser invocations.

Test titles are derived from each Playwright blob report's `onProject` test-ID
mapping. The child directories retain only direct `onAttach` PNGs and client
diagnostic attachments. They exclude all raw Playwright reports, traces,
network data, server-state attachments, error contexts, blob archives, and raw
logs. The raw logs are not copied because they contain environment credential
text.

WebKit has a recorded failure, not a missing exit. See `webkit/outcome.txt`.
