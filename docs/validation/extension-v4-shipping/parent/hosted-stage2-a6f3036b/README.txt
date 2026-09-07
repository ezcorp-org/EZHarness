# Hosted Stage 2 repair — a6f3036b

CI job 101739432125 failed before Stage 2 namespace assertions because the pinned custom conmon rejected the default journald container stdout log driver. The existing runner convention uses `--log-driver=none`; the repair applies that exact argument only to the owned Stage 2 proof container.

The isolated repair commit is `a6f3036b1996ceb056e8062fe1160d64c6b8e611`, based on `0728184bfec77d6b3a8dba2b38b431bfed2ad5ef`. Parent cherry-picked it as `0aa3567ec07640345f4a8787c33cd08c59a057db`. The isolated diff changes one file and one podman argument.

The local baseline used an exact production image from the base source, the same pinned conmon SHA, rootless Podman, `event_logger=journald`, and `default_log_driver=journald`. It exited 126 with the same conmon error and emitted no proof JSON.

The fixed candidate image was built from a6f3036b and its image label matched that commit. The unchanged Stage 2 suite passed all four tests and 27 assertions: direct TCP plus nft omission control, IPv6 plus omission control, a four-worker 400-request five-minute conntrack soak, and the killed-worker control. The run recorded zero conntrack table-full messages and an explicit zero-byte owned-container result.

This directory is a safe summary. Full CI, build, Podman-load, and proof logs remain private. It contains no raw request records, credentials, journal records, or temporary runtime data. Frozen controller text replaces only the audit worktree path and UUID-shaped values. `SHA256SUMS` covers every curated file except itself.
