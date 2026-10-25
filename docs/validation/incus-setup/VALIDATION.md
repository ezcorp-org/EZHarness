# Incus setup validation

> **Historical evidence only.** This folder records the earlier LVM/16 GiB recipe and its blocked plan. The checked-in recipe has since changed to Btrfs/20 GiB. Do not apply `current-plan.json`; its digest is stale. See [the operator flow validation](../2026-09-22-incus-operator-flow.md) for the new read-only server result and remaining live gates.

Date: 2026-09-22
Host: `dev@sandbox-server.taile1c5b0.ts.net`
Result: blocked before apply, as designed

## Current host facts

The final read-only inspection is in [current-inventory.json](current-inventory.json). It first matched the connection fingerprint to the actual entry in the supplied `known_hosts` file. SSH then used `StrictHostKeyChecking=yes`, `IdentitiesOnly=yes` and batch mode.

- Host: `sandbox-server`, NixOS 26.05, kernel 7.0.3, x86_64, cgroup v2 and synchronized time.
- Capacity: 12 CPU threads, 66,878,550,016 bytes of memory and 214,423,474,176 bytes free on `/` at inspection time.
- Incus: client and server 6.0.6, stable API, active service, standalone mode and nftables.
- Incus server certificate: `c8d6afdbaa6b1dc094f9b8b8dcc949861aca21c98b1d736cee981a8cb107a7d1`.
- SSH host key: `SHA256:a3VHX02pT5agIluq6K12E9oCuTg09ErbQ5wK9Vvk8Co`.
- Local Tailscale bind address: `100.81.181.39`.
- Storage support: local Btrfs, directory and LVM drivers. LVM is version 2.03.38.
- Existing Incus state: only the default project and default profile. There are no storage pools, managed networks, instances, trusted client certificates or HTTPS listeners.
- Network check: `10.173.0.0/24` does not overlap any current IPv4 route.

The inventory retains normalized decision inputs only. It does not retain the server certificate body, process IDs, the SSH identity path or private key material.

## Planned state

At the time of this capture, the closed recipe had the settings below. The historical commands and hashes are in [current-plan.json](current-plan.json); they no longer match the checked-in [recipe.json](../../../scripts/incus/recipe.json).

- Recipe digest: `5b82647a77bc75129df66fc08eac47c70fc52e23c3ee2c6e0e30921ef3928719`.
- Inventory fingerprint: `75a813d97037d6b7b8a06037e6ea50c33d827d9feb6f6b1b6419bb61b5b39703`.
- Plan digest: `78d30ee7fa3a76566037bfa307eb4c97efe1155ddbd85662444ea674434f963f`.
- Storage: a 100 GiB loop-backed LVM thin pool with 16 GiB default volumes.
- Network: the managed `ezharness0` bridge at `10.173.0.1/24`, with NAT, managed DNS and IPv6 disabled.
- Project: `ezharness`, restricted to four containers, 8 aggregate CPUs, 32 GiB memory, 4,096 processes, 80 GiB pool storage, no virtual machines and no project-created networks.
- Profile: the unprivileged `compose` profile with isolated ID mapping, nesting, 2 CPUs, 8 GiB hard memory, 1,024 processes, a 16 GiB root disk and the managed bridge.
- Remote API: Incus HTTPS bound to the local Tailscale address only.
- Client access: one restricted TLS client certificate scoped only to the `ezharness` project.

The plan status is `blocked`. Its only planning blocker is `provider_client_certificate_missing`. The provider private key must remain outside this repository. The recipe needs only its public certificate and fingerprint.

## Apply and verify result

[current-dry-run.json](current-dry-run.json) records `dryRun: true`, `state: blocked` and no executed step. The command exited 1. It did not receive `--execute` or an approved digest.

[current-verification.json](current-verification.json) records `ready: false`. It reports the missing provider certificate and every setup postcondition that is still absent. Its post-inspection still shows no pool, managed network, project, instance, trust entry or HTTPS listener. This proves that this validation did not change the server.

The apply implementation inspects before every possible effect. An exact match is skipped. Unexpected existing state stops the run. A successful effect is inspected again. Timeouts, disconnects, conflicts and “already exists” results require reconciliation and are not repeated. A bounded transient result is labeled retryable, but the command still stops so a fresh inspection can prove the state before another attempt.

## Verification commands

All repository commands used `/home/dev/.bun/bin/bun`, version 1.3.14. `/run/current-system/sw/bin/bun` is version 1.4.2 and was rejected by the repository runtime-skew gate, so its results are not validation evidence.

```text
PATH=/home/dev/.bun/bin:$PATH bun test ./scripts/incus/setup.test.ts
11 pass, 0 fail, 48 expect() calls

PATH=/home/dev/.bun/bin:$PATH bun x tsc --project scripts/incus/tsconfig.json
exit 0

PATH=/home/dev/.bun/bin:$PATH bun x biome check scripts/incus docs/validation/incus-setup gates/pluggable-wave1-incus-setup.md
exit 0
```

The repository-wide typecheck was also run. The two Incus errors it first reported were fixed. The remaining failure comes from incomplete dependencies and concurrent contract/host changes outside this task; the focused Incus TypeScript check passes.

## Steps before apply

1. Generate the provider TLS key and certificate. Keep the private key in the provider secret store.
2. Add the public certificate and its SHA-256 fingerprint to the reviewed recipe input.
3. Run `inspect` and `plan` again. Review the new exact plan digest and every command.
4. Authorize one `apply --execute --approved-plan-digest <digest>` invocation for that exact plan.
5. Run `verify`, then run the separate live Compose workload and recovery qualification. This setup validation does not claim SP04 or SP06 live qualification.
