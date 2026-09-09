Focused R4 resource repair check

Source and image
- Source: 2c542bace8f13c58eefa2db715fe54aab4111a62.
- Image: ezcorp:embedding-cache-final-2c542bace8f1.
- OCI image ID: sha256:c0941c22a713f343eee54e846c01fe630fe6ac7f8831b58afc3fd4155508fa95.
- OCI revision: 2c542bace8f13c58eefa2db715fe54aab4111a62.
- The app ran as UID 1001 and the local verifier group GID 100. The runner UID was 1001.

Result
- Exit: 0. The launcher recorded command_exit=0, app_log_exit=0, owned_cleanup_exit=0, and verifier_cleanup_exit=0.
- The terminal verifier reported 10 completed lifecycle cycles, 100 authenticated SSE reconnects, and 65,213 ms.
- The retained JSON has 11 samples: baseline cycle 0 and cycles 1 through 10. Each completed cycle records SSE cleanup from one established connection to zero in one poll.
- Runner containers stayed at zero and runner FDs stayed at 24 in all samples.
- The unchanged 64 MiB post-warm memory bound remains in the frozen verifier. The warm baseline was 882,481,562 bytes, so the bound was 949,590,426 bytes; cycles 7 through 10 were at or below 896,847,053 bytes.
- The retained JSON records 65,211 ms because it is written just before the terminal verifier reports 65,213 ms.

Scope boundary
This is a focused 10-cycle repair check after aligning the app group with the local verifier group for proc-FD observation. It is not a 30-minute soak and not the complete eight-proof production suite.

Contents
- inputs/: exact executed controller and frozen source inputs, stored as inert .txt files.
- logs/: safe command, provenance, and verifier output.
- samples/: full safe R4 sample JSON.
- The raw compose log, runner log, and authentication state remain private.

Sanitization
No copied file was transformed. SHA256SUMS covers every curated file except itself.
