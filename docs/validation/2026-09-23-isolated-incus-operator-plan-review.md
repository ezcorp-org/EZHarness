# Isolated EZHarness → Incus operator Plan review

Date: 2026-09-23. This is a review of a saved Plan. **No full operator Apply has run.** The live feature-sandbox acceptance test is still open.

The test app runs on AMD at `http://127.0.0.1:4301` with its own embedded database under `/tmp/ezh-incus-isolated-app.QMhk6Qhv/db`. The existing EZHarness app and database were not changed. The test app built and activated the Incus extension through the v4 runner, candidate checks, and local admin review.

| Bound item | Exact value |
| --- | --- |
| Target | `dev@sandbox-server.taile1c5b0.ts.net` |
| Incus API origin | `https://sandbox-server:8443` (`100.81.181.39:8443` listener) |
| Setup ID | `bbfa3f94-96d6-497d-87f3-b451e4ae7a5d` |
| **Plan digest to approve for Apply** | **`4faf8f2e0fb2b1242892df75fdbbb0e79ca205aec77fe6d55b049eefa2293fca`** |
| Plan status | `ready`; no blocked reasons; 15 steps |
| Recipe digest | `91e0b09c08e6a6594a8fdf81c80f92e3a0f2da99eb357258dce093bfea1dae5a` |
| Inventory fingerprint | `13993a24b729160c61d2f26678036ad5f370d91c819e66a9b9960a02256d335c` |
| Provider installation | `00bcc640-c430-4c9a-8d97-e35835b8bcf8` |
| Provider release | `0c3bf486-149f-4411-8f17-e4defe0c905e`, digest `eac38067ec5152f4414d053cecedaaf3595d4a6efe10b6b1f5727c03e0891c28`, generation 1 |
| Provider connection | `0199bf3b-1935-4a5d-868e-f5244d14d19a`, revision 1 |
| New client certificate | SHA-256 `AC:83:47:99:CB:C3:B0:D6:48:CE:D4:A3:A8:8B:6A:DA:00:29:17:89:ED:EC:68:D1:15:02:F8:8D:22:33:DB:D3`; restricted to project `ezharness` |

The exact [private Plan response](/tmp/ezh-incus-isolated-app.QMhk6Qhv/incus-plan-response.json) has SHA-256 `68fddeb4cd4cddb26c4a02280aed4f703daa981592a57b618cdcdf7014cbde4f`. It contains the public client certificate and every command. The client private key stays encrypted in the isolated app's provider-connection store. The [dry-run receipt](/tmp/ezh-incus-isolated-app.QMhk6Qhv/incus-plan-dry-run.json) was generated from a fresh server inspection and this exact Plan; it reports `ready`, `dry_run`, and no drift. The reviewed image fingerprint is `57c0d028e4456a3847fb9822802d6a8f613ba4e6ef03002999e8c957a1f40c6c`.

The dry run observed the first two resources as matches, so Apply will skip their create commands:

1. `storage-pool`: existing `ezharness-btrfs`, 100 GiB Btrfs pool, skipped.
2. `managed-network`: existing `ezharness0`, `10.173.0.1/24` managed bridge, skipped.

The other 13 steps were absent and are planned in this order:

3. Create restricted project `ezharness` with container count 4, project CPU 8, memory 32 GiB, processes 4096, disk pool 80 GiB; allow nesting, managed NIC and only `ezharness0`/`ezharness-btrfs`; block VMs and privileged-device overrides.
4. Create profile `compose` in that project.
5–8. Set profile limits: CPU 2, memory 8 GiB with hard enforcement, processes 1024.
9–11. Set isolated ID map, nesting enabled, privileged mode disabled.
12. Attach managed `eth0` on `ezharness0`.
13. Attach a 20 GiB root disk on `ezharness-btrfs`.
14. Bind Incus HTTPS to `100.81.181.39:8443`.
15. Add only the named public client certificate with `--projects ezharness --restricted`.

Apply re-inspects every step. Matching resources are skipped; drift stops the run. It reads each written resource back. A timeout or uncertain response stops for reconciliation rather than repeating the command. The isolated app must remain available with its database and encryption keys for this saved setup ID. If the server, recipe, release, or plan changes, make a new Plan and review its new digest.

After approved Apply, verify the project, profile, listener, and trust restriction; then use EZHarness to probe the provider and run a real create → edit → Compose → test → reconnect → destroy feature flow. The current dry run does not prove that sandbox workflow works.
