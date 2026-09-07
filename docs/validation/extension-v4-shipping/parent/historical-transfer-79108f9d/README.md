# Historical image transfer

This receipt records the controller transfer of three retained historical images from native Podman (`--remote=false`) into rootful Docker's default Unix-socket context. All three fixed image IDs match at source and target. Each save and load exited zero; the controller and owned temporary archive cleanup exited zero.

The frozen controller and pinned Podman wrapper are inert `.txt` copies. The retained images remain in both engines. OCI archive payloads are private and are not part of this evidence.
