# Sandbox server validation

Status: SSH access and Incus installation verified. Incus 6.0.6 is running. Storage, managed networking, a restricted feature profile and the planned provider connection are not configured yet.

Checked: 21 September 2026, approximately 21:38 America/New_York (`2026-09-22T01:38:35Z`). All server checks were read-only.

## Latest check after installation

Checked at `2026-09-22T01:58:17Z` (21 September, 21:58 America/New_York). All checks were read-only; no guest, storage pool, network or profile was created.

| Check | Observed result |
| --- | --- |
| Incus client and server | Both report `6.0.6`; binary is `/run/current-system/sw/bin/incus` |
| Service | `loaded`, `active`, `running` |
| Operator access | `dev` now belongs to `incus-admin`; local API inspection succeeds over SSH |
| Instances / cached images | Both empty |
| Storage pools | None |
| Managed Incus networks | None; listed `lo`, `eno1` and `docker0` are unmanaged |
| Projects | Only `default`; no dedicated restricted feature project |
| Default profile | Empty config and devices; no root disk, NIC or resource limits |
| Remote Incus API | `core.https_address` is unset; server advertises no addresses |
| Trusted remote clients | None |
| Available drivers | Server reports `lxc` and `qemu`; this does not prove guest workloads run |
| Firewall backend | Server reports `nftables`; guest policy has not been qualified |

The new active system is `/nix/store/ghjiv0k3ss806riw0hrykdwi7jz2zxb9-nixos-system-sandbox-server-26.05.20260430.15f4ee4`. The booted generation remains the earlier one recorded below. The Incus service is running in the active system; no reboot requirement is inferred from the generation difference.

Installation passes. Sandbox provisioning and the planned direct Incus connection from AMD remain untested and unconfigured. SSH operator access is not the planned scoped provider identity.

## Initial inspection before installation

| Check | Observed result |
| --- | --- |
| Host | `sandbox-server`, reached from `nixos-amd` through the supplied SSH address |
| Login | `dev` with `/home/dev/.ssh/id_ed25519_personal`; authentication now succeeds |
| Authorized public key | AMD personal key appears once; two total key fingerprint records exist. No before-state was captured, so this does not prove the other key is unchanged. |
| OS | NixOS 26.05, build `26.05.20260430.15f4ee4` |
| Kernel / architecture | `7.0.3`, `x86_64` |
| CPU | Intel Xeon W-2135 at 3.70 GHz; 6 cores / 12 logical CPUs |
| Memory | 62.3 GiB total; 54.7 GiB available at inspection |
| Root storage | ext4 on `/dev/nvme1n1p2`; 199.6 GiB available, 77% used; `/var` and `/home` share this filesystem |
| Swap | 53,676,769,280 bytes configured; unused at inspection. Not counted as sandbox memory capacity. |
| Control support | cgroup v2; CPU reports VT-x; `/dev/kvm` exists. This is not a VM qualification test. |
| Existing container tools | Docker client `29.4.1`; Podman `5.8.2`. Neither current-user listing showed running containers. |
| Incus executable | Absent from the login PATH and checked system/user profile locations |
| Incus service | `LoadState=not-found`; no Incus/LXD units or unit files listed |
| Active system packages | Successful `nix-store --query --requisites /run/current-system` returned no Incus/LXD package paths |
| Incus state/socket | Root read-only checks found no `/var/lib/incus`, `/run/incus` or `/var/lib/incus/unix.socket`; no `/var/lib/lxd` either |
| Standard management port | No TCP listener on port 8443 at inspection |
| Active / booted system | Both refer to the same NixOS generation below |

```text
/nix/store/7giw08kq3fhb2lwqzrwysmil0w8n2wz3-nixos-system-sandbox-server-26.05.20260430.15f4ee4
```

These initial checks found Incus absent from the then-active system and normal deployment paths. They did not search every arbitrary directory, other machine or inactive Nix generation for old downloads. The later installation check above supersedes this result.

## Confirmed

- This session runs on `nixos-amd`.
- Tailscale reports `sandbox-server` online at `100.81.181.39`.
- The configured SSH target is `dev@sandbox-server.taile1c5b0.ts.net`, port 22.
- The short SSH alias selects `/home/dev/.ssh/nixdevbox`, which is absent on AMD. The full hostname supplied by the user does not match that short-alias configuration.
- No SSH authentication agent is available to this session.
- Herdr reports no saved SSH machines in this local session.

## Connection attempts

1. Normal SSH with batch mode, an eight-second connection timeout and strict host-key checking failed with exit 255: no known ED25519 host key for the destination.
2. `tailscale ssh dev@sandbox-server` also failed with exit 255 at host-key verification. This attempt did not establish a shell or run the remote inspection commands.
3. Retried the user's exact destination, `dev@sandbox-server.taile1c5b0.ts.net`. Accepted its first-seen ED25519 host key using `StrictHostKeyChecking=accept-new`; this is first-use trust, not independent fingerprint verification. The personal AMD identity was rejected with `Permission denied (publickey,password,keyboard-interactive)` and exit 255.
4. Retried with strict host-key checking and the work AMD identity. It was also rejected with the same authentication error and exit 255.
5. Retried after the user's “now try?” message. Personal, work and default SSH identity selection all failed with exit 255. Verbose diagnostics confirm both explicit public keys were offered and neither was accepted. The default identity paths are absent. The personal key fingerprint on AMD is `SHA256:AGcVXzWLsTZAqrQ7OBz0eAukLUp4IoWwGdDn0xJFEew`; use it to compare the installed public key with the intended source machine. No Incus check ran.
6. After the user reported one key added, the same personal identity authenticated successfully. The subsequent host checks produced the results above. The first compound remote command returned exit 4 because the final Incus service check failed; it was not an SSH authentication failure. Later structured checks recorded individual results.

The host key is saved locally; changed-key rejection remains enabled. The user installed the public key. The agent did not change server settings or existing guests.

## Working access

```sh
ssh -i /home/dev/.ssh/id_ed25519_personal dev@sandbox-server.taile1c5b0.ts.net
```

There is no need to run `ssh-copy-id` again for this AMD key.

## Remaining setup and qualification

- Incus installation and service/version checks now pass. Initialize the required storage and networking before a guest test.
- Configure reviewed storage, restricted projects, networking and provider identity before granting engine access.
- Configure and inspect the intended feature profile, nesting, mounts and outer resource limits.
- Qualify the real nested Compose fixture, workload limits, private networking, retained storage and restart recovery. No live guest was created by this validation.
- Complete the planned EZHarness provider/transport/workspace integration. Host installation alone will not implement it.

No resource pool or admission budget was approved from this single capacity snapshot. Storage capacity and the existing broadly accessible `/dev/kvm` mode need review during host provisioning. No load, filesystem containment or security qualification is claimed.

Result: access, host inventory and Incus installation validated; storage, network, profile, provider connection and live-workload qualification remain open.
