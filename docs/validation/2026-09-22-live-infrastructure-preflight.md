# Live infrastructure preflight — 2026-09-22

This is a read-only check of the current EZHarness worktree and `sandbox-server`. No Incus resource, trusted certificate, listener, guest, or secret was created or changed.

| Gate | Result | Evidence |
| --- | --- | --- |
| SSH and Incus daemon | Pass | Strict-known-host SSH with the supplied personal key succeeds. Incus client and server both report 6.0.6. |
| Server resources | Not ready | Storage pools `[]`, instances `[]`, only the `default` project, and no managed network. The default profile has no root disk or NIC. |
| Deterministic setup plan | Blocked | `scripts/incus/cli.ts inspect` and `plan` completed against the real server. A fresh 14-step plan reports `provider_client_certificate_missing` plus four preset incompatibilities: the checked-in 16 GiB root disk is below the 20 GiB preset minimum, and LVM does not match the presets' Btrfs/ZFS requirement. Its dry-run receipt is `blocked` with zero steps dispatched; `verify` reports `ready: false`. |
| Incus provider transport | Read-only probe built; live blocked | The initial adapter declared `POST /api/sandbox-providers/incus/transport`; production `validateHostApiRequest` denied it. The current adapter uses a dedicated release-bound provider RPC and host-owned mTLS probe. No client identity or configured server endpoint exists yet, and sandbox mutations remain unsupported. |
| Infisical provider transport | Blocked | The adapter declares `POST /api/secret-providers/infisical/transport`. The same production broker returns `api_route_denied`; no live Infisical connection was attempted. |
| Guest, Compose, restart, and secret qualification | Not run | These require approved server resources, provider identity, host transport, and backend dispatch. Offline tests are recorded separately in the Astra review. |

The read-only `/1.0` response from Incus 6.0.6 reports `environment.kernel_architecture: "x86_64"` and no `server_architecture`. Astra reproduced a failed probe against this response shape; the parser and both mock fixtures were corrected to use `kernel_architecture`. This verifies protocol parsing, not a live mTLS connection.

The checked-in recipe proposes a 100 GiB LVM pool, a managed bridge, a restricted project, an 8 GiB/2 CPU Compose profile, and an HTTPS listener. Its provider certificate is intentionally absent. The fresh blocked plan digest is `e99d6a89cfe3bb3e335acf05649e7af57905cab238964314fdf559fc2520f7c7`; it is **not** an approval target because the recipe and certificate must change. The setup tool requires an exact reviewed digest before execution. No live setup was attempted.

Next verification sequence: add an authorized operator setup entrypoint and host-owned client identity issuance; choose a recipe compatible with a qualified preset; create and retain the provider key in the approved host store; rerun inspect/plan for the resulting certificate and review that exact plan; apply and verify restricted server resources; implement the remaining transport actions and run a real guest clone → edit → Compose → test → retain → reconnect flow; then test restart, denial, cleanup, and secret scope. A raw Incus guest alone would not prove the EZHarness integration.

Official Incus documentation confirms that restricted projects need explicit resource configuration and that TLS clients can be scoped to projects: [projects](https://linuxcontainers.org/incus/docs/main/howto/projects_create/), [project confinement](https://linuxcontainers.org/incus/docs/main/howto/projects_confine/), [storage pools](https://linuxcontainers.org/incus/docs/main/howto/storage_pools/).
