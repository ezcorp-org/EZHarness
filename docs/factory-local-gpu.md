# Local AMD GPU tests

Two proofs cover this host. Both hold the user-scoped lock
`$XDG_RUNTIME_DIR/ezcorp-factory-local-gpu.lock` for their whole run, so two
copies never use the GPU at once. Neither changes the GPU configuration and
neither reimages anything.

```
bash scripts/verify-factory-local-gpu.sh          # real ROCm computation
bun scripts/verify-factory-attempt-gpu.ts         # the per-attempt device grant
```

`verify-factory-local-gpu.sh` runs ten seeded matrix calculations in ten fresh
rootless Podman containers from a digest-pinned image. A final container has no
devices and must fail with `GPU_REQUIRED`.

`verify-factory-attempt-gpu.ts` drives the factory's own launch path through the
shared Podman runner. The host runner is configured with the full local device
list, which is exactly the host-global list a factory start must never inherit,
and each case then states what its held allocation authorized and observes what
the kernel gave the guest. It writes a JSON verdict with one case per rule.

## The supported local profile

This profile is for trusted local fixtures only. It is not a production profile
and does not become one.

| Fact | Value |
| --- | --- |
| Device | AMD Radeon RX 7900 XTX, 25,753,026,560 usable VRAM bytes |
| Kernel | Linux 7.0.3 |
| Runtime | PyTorch 2.12.0, ROCm HIP 7.14.60850 |
| Container runtime | rootless Podman 5.8.2, cgroups v2 |
| Authorized device nodes | `/dev/kfd`, `/dev/dri/renderD128`, `/dev/dri/renderD129` |
| CDI device names | none; the Container Device Interface is not available on this host |
| Capabilities | compute, utility |
| Selector | `ROCR_VISIBLE_DEVICES=0` |
| Isolation | non-root user, read-only root filesystem, `--network=none`, `--cap-drop=ALL`, no-new-privileges, private IPC, fixed CPU, memory and PID limits |

This ROCm runtime fails initialization when only `renderD128` is mapped, and its
memory-policy setup also touches the integrated GPU on `renderD129`. The local
probe therefore maps both render devices and selects the discrete card with
`ROCR_VISIBLE_DEVICES=0`. **That environment variable is a selector, not an
access control**: it does not restrict a hostile process, which can simply unset
it. Keep this GPU assigned to one trusted local tenant.

No credentials are needed for either proof. The local S3 credential references
are described in [the storage guide](factory-local-storage.md).

## What the per-attempt grant proof establishes

Each case is a rule with its own verdict in the emitted JSON.

| Case | Rule |
| --- | --- |
| `cpu-attempt-has-no-device` | A CPU attempt sees no GPU device, although the host runner configures three |
| `allocated-attempt-has-exactly-its-grant` | A held `gpu-host` allocation reaches exactly the devices its grant names, and `/dev/kfd` opens inside the guest |
| `narrower-grant-is-exact` | A grant naming one render node reaches that node and no other |
| `unapproved-grant-denied` | A device grant without a held `gpu-host` allocation is denied before any launch |
| `unsupported-profile-denied` | A device outside the supported node pattern is refused by the shared validator |
| `cdi-profile-unavailable` | A grant naming CDI devices cannot start an attempt on this runtime |

Two further rules are proved by the durable fence rather than by this script:
no second live attempt on this host can hold a device node another grant already
names (`src/factory/runner/attempt-devices.test.ts`), and a build or discovery
guest is denied a device whatever the host configures
(`packages/@ezcorp/extension-runner/tests/podman-devices.integration.test.ts`).

## Unmet criteria for the production GPU profile

The contract's GPU profile is **not satisfied** by anything above. Each row is an
explicit unmet criterion with its own verdict. Hardware being absent is not a
pass, and none of these may be inferred from the local AMD result.

| Criterion (C05) | Verdict | Why |
| --- | --- | --- |
| CDI injection of one whole GPU | **unmet — not implemented** | The shared runner injects raw device nodes only. A CDI grant is refused at start rather than launched with no device, so the gap fails closed instead of passing silently. |
| Tenant-dedicated GPU VM or host | **unmet — not available** | This is a shared development workstation running other agents' workloads. Host assignment and reoffer are C03 pool operations that W16 provisions. |
| No host-plane or other-tenant co-location | **unmet — not available** | Same host runs the harness, the proof PostgreSQL, and other agents. |
| An explicitly supported NVIDIA driver and toolkit pair | **unmet — hardware absent** | No NVIDIA device, driver, or container toolkit exists on this host. The measured device is an AMD Radeon RX 7900 XTX. |
| Capabilities limited to compute and utility | **unmet — unverifiable** | The grant carries `compute` and `utility`, but ROCm has no driver-capability mechanism to enforce them against, so the field is recorded and not applied. |
| Device reset before reuse | **unmet — not implemented** | No reset is performed between attempts. Nothing in this repository resets an AMD or NVIDIA device. |
| Supervisor-verified reimage before tenant reassignment | **unmet — not implemented and deliberately not attempted** | Reimaging this development machine is forbidden by the plan. There is no reimage receipt and no verifier for one. |
| Strict single-device isolation | **unmet — profile conflict** | This ROCm runtime requires both render nodes, so a single-device grant cannot initialize. `ROCR_VISIBLE_DEVICES` selects but does not confine. |

Consequences that follow from those rows, and that the code enforces today:

- A host that lacks these controls stays unavailable to untrusted factory GPU
  work. The GPU stays assigned to one trusted local test tenant; every other
  installation runs CPU journeys.
- Cross-tenant GPU reassignment requires real fencing and a verified reset and
  reimage path. Neither exists.
- An AMD production replacement would require an explicit supported-profile
  revision and equivalent measured controls. The local probe alone does not
  establish one.

W19 closes the production GPU certification after W16 provisions a dedicated
host. Until then these rows stay unmet with their measured verdicts.
