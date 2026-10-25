# Revised isolated Incus setup plan review (release 0.1.1)

The approved provider release `dcde361cc4fe348743c1aafc5272ac5104b025046b1c96273e58dc0b8d6e8bdd` is active in the isolated EZHarness app. This packet requests approval for a **new server plan**. It does not approve the plan by itself.

| Item | Exact value |
| --- | --- |
| Setup ID | `93c1db15-4515-43a0-aa5d-78326bc30c78` |
| Plan digest | `fd430d6aece7cad6bdac995bd4417bf3b0c663ae37a3671d127c98a4ea21be43` |
| Provider installation | `00bcc640-c430-4c9a-8d97-e35835b8bcf8` |
| Provider release | `02ce233e-ccbf-4b19-a93f-4e6ee63a926a` |
| Provider connection | `9be7969a-0319-4cd7-8b85-d6e034f0f226`, revision `1` |
| Scoped client certificate fingerprint | `fcd2d46c8f4007cd01098123e6bfbfba0c962b1c9d9f511bf222dfb7a9b3e622` |
| Server | `dev@sandbox-server.taile1c5b0.ts.net` (SSH host key `SHA256:a3VHX02pT5agIluq6K12E9oCuTg09ErbQ5wK9Vvk8Co`) |
| Guest image | `57c0d028e4456a3847fb9822802d6a8f613ba4e6ef03002999e8c957a1f40c6c` |

The earlier approved plan digest `b3e3a491775f8679e35b4606f67cd1ca6043e0d28ff40d911dbc9d99e313bd4d` failed at its first write. Incus 6.0.6 reported `Invalid project configuration key "restricted.storage-pools.access"`. The same exact project command failed in a controlled replay. Server inventory confirmed that the `ezharness` project does not exist and there are no instances. No later setup step ran.

This revision removes only that unsupported project key from the generated project command. The server has exactly one storage pool, the reviewed `ezharness-btrfs` pool. New planning now blocks if any other pool is present; this is a setup-time check, **not** a server-enforced project pool allowlist. An operator adding another pool later must treat this deployment as needing review. The `limits.disk.pool.ezharness-btrfs=80GiB` project limit remains. All other project, profile, network, resource, and trust settings stay in the plan.

The replacement plan is `ready`. A fresh read-only server preflight was `ready` with no blocked reasons. Its dry-run receipt was `dry_run`: the existing 100 GiB `ezharness-btrfs` pool and `ezharness0` bridge matched and will be skipped. The `ezharness` project, `compose` profile and settings, `100.81.181.39:8443` HTTPS listener, and new restricted `engine` client certificate are absent and planned. The provider client trust is restricted to the `ezharness` project. The profile has the isolated `eth0` NIC and fixed 20 GiB root disk, 8 GiB memory, 2 CPUs, 1024 processes, unprivileged nesting, and `security.port_isolation=true`.

As an additional compatibility check, every remaining project configuration key in the revised recipe was found in the [Incus v6.0.6 source documentation](https://github.com/lxc/incus/blob/v6.0.6/doc/config_options.txt). This is a version-matched document check; only Apply and server readback can prove this exact server accepts the full configuration.

The pinned SSH host key, inventory fingerprint, plan digest, and individual step readbacks are checked at Apply. A concurrent change can still stop a partially applied plan; the receipt must then be reconciled before retry. Existing host firewall rules block guest traffic to TCP 8443, but TCP 22 remains globally allowed. A separate [reviewed host firewall change](2026-09-23-incus-host-management-firewall-review.md) is required before claiming full guest-to-management isolation; it has **not** been deployed. A live guest test must verify both ports and cross-guest isolation.

Local focused setup tests passed (25 tests, 213 assertions), and Biome checked the changed setup files. The real server setup, EZHarness-created guest, Compose workflow, and full qualification remain unverified.

**Approval requested:** Apply only setup ID `93c1db15-4515-43a0-aa5d-78326bc30c78` with exact digest `fd430d6aece7cad6bdac995bd4417bf3b0c663ae37a3671d127c98a4ea21be43` on the named server. This approval covers only the listed setup steps, not the separate host firewall change or later guest operations.
