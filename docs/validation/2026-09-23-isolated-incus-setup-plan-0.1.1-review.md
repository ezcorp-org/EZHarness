# Isolated Incus setup plan review (release 0.1.1)

The isolated EZHarness app approved and activated the reviewed Incus provider release `dcde361cc4fe348743c1aafc5272ac5104b025046b1c96273e58dc0b8d6e8bdd`. Its activation operation `0caf1629-2191-4744-ae5d-c73270766689` is active. This did not write to the Incus server.

| Item | Exact value |
| --- | --- |
| Setup ID | `bc1abe7e-7aa7-471c-87ea-cf6597a5aebe` |
| Plan digest | `b3e3a491775f8679e35b4606f67cd1ca6043e0d28ff40d911dbc9d99e313bd4d` |
| Provider installation | `00bcc640-c430-4c9a-8d97-e35835b8bcf8` |
| Provider release | `02ce233e-ccbf-4b19-a93f-4e6ee63a926a` |
| Provider connection | `f5aa7967-7d8d-488d-863b-81ace63fdb6d`, revision `1` |
| Scoped client certificate fingerprint | `1aa7ee45a559cb8c1a44499e5b76c3108b297549ee3e5c186ad25049df3bd71c` |
| Server | `dev@sandbox-server.taile1c5b0.ts.net` (SSH host key `SHA256:a3VHX02pT5agIluq6K12E9oCuTg09ErbQ5wK9Vvk8Co`) |
| Guest image | `57c0d028e4456a3847fb9822802d6a8f613ba4e6ef03002999e8c957a1f40c6c` |

The plan is `ready`. The read-only dry run returned `dry_run` with the same digest. It found the reviewed 100 GiB `ezharness-btrfs` pool and `ezharness0` bridge already present, so those two steps will be skipped. It found no `ezharness` project, no `compose` profile, no Incus HTTPS listener, and no `engine` client certificate. Those steps are planned.

Apply will create the restricted `ezharness` Incus project (at most four containers, 32 GiB total project memory, 80 GiB pool disk), create its bounded `compose` profile (8 GiB memory, 2 CPUs, 1024 processes, 20 GiB root disk, unprivileged nesting), attach its NIC to `ezharness0` with `security.port_isolation=true`, bind Incus HTTPS to the server's Tailscale address on port 8443, and trust only the new engine certificate restricted to `ezharness`. It does not create a feature sandbox. The separate local credential connection was prepared by the isolated app during Plan.

The plan fails closed on known preflight drift: it rechecks server inventory before Apply and checks each step when reached and after a change. Concurrent drift in a later step can stop a partially applied plan; the receipt then needs operator review or reconciliation. A lost or ambiguous result remains `reconcile_required` for inspection. The prior setup digest `adc0a93ba4a18122ca98ad50f387b06954819b7af8d2ca5f2dfcd039e7a6fb5b` is obsolete and must not be retried.

Approval requested: execute only this setup ID and exact plan digest on the named server. A successful Apply must be followed by server readback, an EZHarness-created guest fixture, and the remaining live qualification checks. Neither the plan nor its dry run proves those checks yet.
