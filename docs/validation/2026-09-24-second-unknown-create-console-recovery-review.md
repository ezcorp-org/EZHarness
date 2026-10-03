# Server console recovery after the v3 no-effect stop

Status: **superseded without execution**. Personal-key `dev` SSH returned; the old-generation switch settled, and the [v3 receipt](2026-09-24-second-unknown-create-recovery-v3-attempt.md) records the completed rollback. This packet remains a record of the proposed console route. It does not authorize another no-effect request or sandbox CREATE. The saved CREATE `016f7e51-60a6-4e19-aa32-77d44b745053` remains `OUTCOME_UNKNOWN`.

## Why console access is required

The old-generation `switch-to-configuration test` began while `user-1000.slice` was frozen and hung after `reloading user units for dev`. That switch removed the temporary root authorized-key file. New root and dev SSH both returned `Permission denied` after the 2026-09-25 01:17:02 UTC rollback timer deadline. The existing root connection is a non-PTY exec of the hung switch, not a shell. Tailscale ping and Incus HTTPS work but cannot read host systemd state. The timer service's execution, server generation, and thaw state are unproved. Use only an existing out-of-band **root console** that remains available independently of SSH and the frozen `dev` slice. If no such console exists, stop; this packet does not create one.

## Console preflight: read only

Keep the AMD runner assertion and TCP ingress hold in place. From the server root console, record time and the following exact observations before changing anything:

```sh
date -u --iso-8601=seconds
readlink -f /run/current-system
readlink -f /nix/var/nix/profiles/system
cat /sys/fs/cgroup/user.slice/user-1000.slice/cgroup.freeze
cat /sys/fs/cgroup/user.slice/user-1000.slice/cgroup.events
systemctl show ezh-admin-route-rollback.timer ezh-admin-route-rollback.service -p ActiveState -p SubState -p Result -p ExecMainStatus
systemctl list-jobs --no-pager
ps -eo pid,ppid,user,stat,etime,args
sha256sum /etc/ezharness/incus-noeffect-observer-policy.json
incus list --project ezharness --format=json
incus operation list --project ezharness --format=json
```

Require the observer policy hash `966d68f791c7fd015a5151a0e9cbba4cba35bda35ed576c3246c003f36a2ee61`. Require zero instances and operations. Check the complete Incus trust list without printing the PEM: it must contain exactly one `engine` client, restricted to `ezharness`, with DER fingerprint `fcd2d46c8f4007cd01098123e6bfbfba0c962b1c9d9f511bf222dfb7a9b3e622`. The certificate and policy were already restored and checked before the hung switch; a mismatch at the console is a stop, not a reason to add another cert or rewrite the policy. Save systemd journal entries for the timer, rollback service, old-generation switch, and SSH from 01:13 UTC onward. Do not infer timer success merely from its expired deadline.

## Conditional host recovery

The old generation is `/nix/store/aqs258f5nhvcksd562jgqcd6phqsk40m-nixos-system-sandbox-server-26.05.20260430.15f4ee4`; the temporary generation is `/nix/store/r4y7zdn7imlb44mg2bmjx5kl1lpr8d5v-nixos-system-sandbox-server-26.05.20260430.15f4ee4`. The server rollback unit was created with `systemd-run --on-active=12m` and runs **thaw first**, then the old-generation switch. Apply these conditions in order:

1. If `cgroup.freeze` is `1`, run `systemctl thaw user-1000.slice` **from the root console**, then verify `cgroup.freeze=0` and `cgroup.events` reports `frozen 0`. This is the missing prerequisite for the pending user-unit reload. If thaw fails or the state does not change, stop and retain the AMD fences. Do not start a second switch while one is running.
2. Observe the already-running old-generation switch or rollback service for at most five minutes after thaw, checking its journal, exit status, `systemctl list-jobs`, and process list at least every 30 seconds. Keep the root console available for these checks. Do not start another switch or kill a stuck process by guesswork. If the switch or rollback service is still active at five minutes, stop this procedure with the AMD fences in place for a separate repair review.
3. Require both the running system and system profile to equal the exact old generation, with no switch process or relevant job. If either path differs, stop for a separate reviewed plan. This packet does not start another generation switch.
4. Only after the old running generation and profile match, confirm `dev` SSH from a fresh AMD connection with the previously used personal key, `sshd -t`, active `sshd`, `incus`, and Tailscale, and repeat the trust/policy/inventory checks. The temporary root route disappearing is expected with the old generation. Inspect the timer and rollback service results; stop or reset an already-completed transient timer only after the old generation and dev route are proven. Do not cancel a timer as a substitute for verifying its action.

The original NixOS server admin-route packet specifies the rollback command as `systemctl thaw user-1000.slice; $OLD/bin/switch-to-configuration test`. The v3 attempt reversed those actions during manual rollback; this packet corrects the order and forbids a second switch while the first is pending.

## Exit evidence and handoff

The console operator must provide exact UTC times; timer and rollback service journal/status; before/after `cgroup.freeze` and `cgroup.events`; the old running/profile paths; successful `dev` SSH; original policy SHA; original restricted cert fingerprint/scope; empty project inventory and operations; and any residual switch jobs. Keep the AMD runner and ingress fenced until those results and the live EZHarness CREATE state are reviewed. After server host recovery, a separate guarded AMD rollback may restore the first-target observer/fence configurations and runner. The v3 attempt's prepared request file was never submitted and must not be reused.
