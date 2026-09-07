Final R4 duration-soak receipt

Source and image
- Source: 2c542bace8f13c58eefa2db715fe54aab4111a62.
- Image: ezcorp:embedding-cache-final-2c542bace8f1.
- OCI image ID: sha256:c0941c22a713f343eee54e846c01fe630fe6ac7f8831b58afc3fd4155508fa95.
- OCI revision: 2c542bace8f13c58eefa2db715fe54aab4111a62.

Terminal outcomes
- The outer wrapper ended with main_exit=0 at 2026-09-07T19:33:39Z.
- All phase command exits are zero: canonical-eight, independent-container, and runtime-resources-soak.
- The soak launcher recorded command_exit=0, app_log_exit=0, owned_cleanup_exit=0, and verifier_cleanup_exit=0.
- review/parent-soak-app-log-review.json reviewed all 299 app-log lines: 291 info, one expected embedding-init degraded warning, and seven plain lifecycle lines. It found no error, fatal, unknown, or malformed records.

Observed resource proof
- The explicit R4 review passed with --minimum-ms 1800000 and --observed-console-prefix-bytes 65536. Its full report is review/parent-full-resource-review.json.
- The terminal R4 projection reports 272 completed cycles, 2,720 authenticated SSE reconnects, and 1,803,391 ms.
- The authoritative persisted series, samples/r4-resource-samples.json, contains baseline plus 272 completed-cycle samples and reports 1,803,347 ms at its final write.
- The review checked all 273 samples and 100,350 relation-descriptor rows. It checked every cycle’s zero remaining SSE connections, zero owned workers, runner FDs at 24, descriptor classes, relation backing identity, and the unchanged 64 MiB post-warm memory limit.
- Warm memory was 857,315,738 bytes; observed post-warm maximum was 910,163,968 bytes; growth was 52,848,230 bytes, below 67,108,864 bytes. Final memory was 750,780,416 bytes.

Observed-console boundary
- logs/observed-console-prefix.log.txt is the actual 65,537-byte console file: 65,536 bytes of JSON projection plus LF. It ends during cycle 199.
- The review validates that every observed prefix byte equals the matching prefix of the full persisted-series projection. The missing console tail is not treated as observed output, and its cause is unestablished. review/console-truncation-findings.json retains the independent diagnosis scope.
- The complete persisted series is authoritative for resource measurements. This curation does not claim that it reconstructs the unobserved console tail.

Identity boundary
- This local production soak ran the app as UID 1001 and GID 100, matching the local verifier credentials required for strict /proc FD readlink checks.
- It does not replace the separate cache proof that ran the app as UID/GID 1001:1001.

Contents and safety
- inputs/ retains exact driver, wrapper, launcher, accounting, config, cycle, and helper inputs as inert .txt files.
- review/ contains the exact v2 reviewer and its eight control outcomes. The controls reject a missing explicit incomplete-console option, altered unprinted descriptor or final-memory data, a changed prefix, and invalid duration claims.
- samples/r4-resource-samples.json is the complete safe descriptor-sample receipt. Its raw hash is in review/parent-full-resource-review.json and SHA256SUMS.
- Raw compose logs, runner logs, cookies, API keys, runtime state, and archive payloads remain private.

Sanitization
No copied file was transformed. SHA256SUMS covers every curated file except itself.
