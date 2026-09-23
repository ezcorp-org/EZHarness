# Revised isolated EZHarness → Incus operator Plan review

Date: 2026-09-23. **Historical review only. Do not Apply this digest.** The user approved it, but its first Apply attempt returned HTTP 409 before claiming the plan or changing the server. A later pre-apply check found the bound release declares an all-zero guest image digest, so it cannot pass live qualification. A new release and new plan are required. The prior approved Plan stopped at project creation; see the [first Plan review](2026-09-23-isolated-incus-operator-plan-review.md).

The server runs Incus 6.0.6. Its API does not advertise `projects_restricted_virtual_machines_nesting`, and the exact first project-create command failed with `Invalid project configuration key "restricted.virtual-machines.nesting"`. The revised recipe removes that setting. It still sets `limits.virtual-machines=0`, so the project cannot create VMs. It now requires the API extensions for its image-server restriction and per-pool disk limit. The server advertises both. The [Incus API extension reference](https://linuxcontainers.org/incus/docs/main/api-extensions/) identifies the unsupported setting as a separate feature.

| Bound item | Exact value |
| --- | --- |
| Target | `dev@sandbox-server.taile1c5b0.ts.net` |
| Incus API origin | `https://sandbox-server:8443` (`100.81.181.39:8443` listener) |
| New setup ID | `2e8c3815-fce3-446a-9207-fab9b9429c83` |
| **New Plan digest for Apply** | **`adc0a93ba4a18122ca98ad50f387b06954819b7af8d2ca5f2dfcd039e7a6fb5b`** |
| Plan status | `ready`; no blocked reasons; 15 steps |
| Recipe digest | `4c8d25407ab400cb1615624a61ae9dbd24133e751f060a17d4b881068ca0ff29` |
| Inventory fingerprint | `df7d2cbdca671af76db7b7b635d346923b8c9b67ce67efe6c3d4649642838054` |
| Provider installation | `00bcc640-c430-4c9a-8d97-e35835b8bcf8` |
| Provider release | `0c3bf486-149f-4411-8f17-e4defe0c905e`, digest `eac38067ec5152f4414d053cecedaaf3595d4a6efe10b6b1f5727c03e0891c28`, generation 1 |
| New provider connection | `92e3cf41-10f0-456a-967f-6755215f1120`, revision 1 |
| New client certificate | SHA-256 `de1a3b457a83064156327883a1e41fc55d1685f9959f205547042ecc92ffb062`, restricted to `ezharness` |
| Guest image | `57c0d028e4456a3847fb9822802d6a8f613ba4e6ef03002999e8c957a1f40c6c`, alias `ezharness-guest-0-1-0` |

The [private Plan response](/tmp/ezh-incus-isolated-app.QMhk6Qhv/incus-revised-plan-response.json) has SHA-256 `3b442743eb6f9c3f8c704ac570c53954e617baae2f54317e97b4ae5b66b20bc1`. The [private dry-run receipt](/tmp/ezh-incus-isolated-app.QMhk6Qhv/incus-revised-plan-dry-run.json) has SHA-256 `e67e9bb7c2fffee25f8ef4cdc6bb44e55982706ea4e0633d2d55661686f93206`. The host-owned [private recipe](/tmp/ezh-incus-bootstrap-review-20260923.XUcCYG/reviewed-recipe.json) has SHA-256 `f92551159a76383787b8402f9b40b9ed875bc577dff87c11253402c5f24db740`. The client's private key remains encrypted in the isolated app's provider-connection store.

The fresh dry run was `ready` and `dry_run`, with no blocked reasons. Apply will skip the matching 100 GiB `ezharness-btrfs` pool and `ezharness0` bridge. It then plans these 13 absent steps:

1. Create the restricted `ezharness` project: at most four containers, eight CPUs, 32 GiB memory, 4096 processes, 80 GiB on the approved pool, zero VMs; allow container nesting and only managed NIC/storage access.
2. Create the `compose` profile and set two CPUs, 8 GiB hard memory, 1024 processes, isolated ID map, nesting on, privileged mode off.
3. Add the managed `eth0` and 20 GiB root disk devices to that profile.
4. Bind Incus HTTPS to `100.81.181.39:8443`.
5. Trust only the named client certificate, restricted to project `ezharness`.

The saved Apply state remains `planned` with no receipt. A fresh read-only server inventory found only the `default` project, no instances, and no trusted client certificate. The existing pool and bridge remain unchanged. The one-hour candidate evidence expiry caused the HTTP 409; the separate all-zero image pin makes this release unusable for live qualification even after that lifecycle bug is fixed. Do not reuse this approval for a replacement release or plan. A durable qualification fixture can later test the controller's first real guest. User feature creation still requires host-owned SP01–SP08 qualification. No EZHarness-created sandbox exists yet.
