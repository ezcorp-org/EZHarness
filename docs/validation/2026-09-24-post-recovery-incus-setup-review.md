# Incus 0.1.2 connection after signed CREATE recovery

The isolated EZHarness app repaired saved CREATE `62633686-a1bc-4b93-b87a-54fdbc96c2fd` with one signed no-effect receipt. Its binding is now `ABSENT`; cleanup operation `554cc176-1a3e-427c-b9b3-626478436f27` is `SUCCEEDED`. The server still had zero project instances and active operations at the recovery readback. The exact original `engine` certificate was restored with DER SHA-256 `fcd2d46c8f4007cd01098123e6bfbfba0c962b1c9d9f511bf222dfb7a9b3e622`, restricted to project `ezharness`.

The active approved Incus provider is release `9ec8e626-0a5d-4ed6-9333-a3fd1aa25472`, digest `4c0e2eee0f9105d28a5173ec695bd42c6b84de58233570fb0ffb2dcf03a6ac18`, generation 3. The old connection belongs to release 0.1.1, so it cannot be used for a new 0.1.2 sandbox. A fresh Plan returned HTTP 200 with these exact values:

| Field | Value |
| --- | --- |
| Setup ID | `97edb3a1-80e4-4305-baac-1325930b868d` |
| Plan digest | `d8460b1705715ebebb2596e825cba29d9514d53a2190841336830082d3791fcb` |
| Inventory fingerprint | `45b0f208fbf9e1025fe4a5cacd5ec09a478163fceb3ea64a88b3a5fed0c26bcc` |
| New connection ID | `540e2032-532f-4d8f-9a4e-df50c8e9f43a`, revision 1 |
| Plan state | `ready`, no blocked reasons, 15 reviewed steps |

The 15 steps cover the existing Btrfs pool, managed bridge, restricted project, Compose profile and its limits, isolated NIC/root disk, HTTPS listener, and scoped provider client. Apply must re-read the server and refuse a changed plan. No new pool, bridge, project, profile, or certificate is intended. A changed resource or planned write requires a fresh review before Apply.

The older setup SSH gate still runs Incus with `HOME=/var/empty`, which is immutable on this server. Its read-only `incus version` command failed until a temporary private `/var/empty/.config` was created for `ezh-incus-setup`. The corrected gate source in PR #303 gives each Incus call a private `INCUS_CONF` directory. The temporary directory is only for this isolated test and must be removed after setup. The permanent NixOS setup-gate pin still needs the corrected script.

## Execution and readback

The isolated app recorded approval of digest `d8460b1705715ebebb2596e825cba29d9514d53a2190841336830082d3791fcb`. It exported a 57-command policy with the same digest. The policy's first install used mode 0600, which the restricted setup account could not read. All requests were denied by the SSH gate before execution; server inventory showed no new instances or active operations. Changing only the policy mode to root-owned 0644 made read-only gate calls work. Reapplying the same reviewed plan returned `verified` with no failures. The saved private receipts are `/root/ezh-qualification-stage/post-recovery-setup-apply.json` and `post-recovery-setup-apply-retry.json`.

The app then planned and applied capacity digest `a4124441943808b4311afe333aa59d2b43a52b6623bb39a5a17de8719238ce43`: 32 GiB memory, 8 CPU equivalents, 4096 PIDs, 80 GiB disk, and four slots, with the service's safety margins. The capacity plan and receipt are saved privately under `/root/ezh-qualification-stage/post-recovery-capacity-*.json`.

The first smoke CREATE call was refused before admission because the new connection had no capacity record. An offline copy of the stopped app database reproduced `Host capacity must be configured first`. After capacity Apply, the same smoke fixture created operation `016f7e51-60a6-4e19-aa32-77d44b745053`, which returned `OUTCOME_UNKNOWN` with no provider operation ID. Its binding is `incus-qual-binding-3fd085a2188deff6d167d727d33176e6b78f0ebb6e2ecc50fecbfc68167c31ae`. The expected Incus name `ezh-ec47ebd35d0d508dc3cd269e5b4666c8` is absent and the project has no active operations. This does not, by itself, authorize a retry or cleanup.

The dedicated extension runner artifact directory was empty. The app's release blob contained artifact `2fc8d4c91d0b8ec779451cc6ff0f8fc93e17ddec9085e0d632d65d9bde7008d5`, whose file SHA-256 matched its name. It was installed as a root-verified, runner-owned mode 0400 artifact in the dedicated runner store. Before that copy, a direct read-only worker invocation returned `RunnerError invalid_request`. After it, the same worker started and returned the specific expected helper-version qualification failure. The host's pinned read-only Incus transport also returned Incus 6.0.6 over the new connection.

To separate worker availability from Incus create behavior, a disposable canary used the same pinned host lifecycle transport and reviewed preset with ID `incus-diagnostic-canary-20260924`. Incus returned GET 404 for the name, GET 200 for the profile, and POST 202 for create. The created stopped instance had the expected managed tags and was deleted by exact name. A final project list was empty; the delete operation reported Success. This canary is diagnostic evidence only. It is not an EZHarness-owned feature lifecycle or qualification.

Next: retain the second CREATE as unknown, prepare a fresh signed no-effect recovery with both app and server client authority fenced, then run the real fixture with the now-installed worker artifact. The temporary `/var/empty/.config` workaround remains until the corrected NixOS setup gate is staged and activated. The local TCP ingress hold remains active.
