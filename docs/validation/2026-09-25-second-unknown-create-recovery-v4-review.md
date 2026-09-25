# Second UNKNOWN CREATE: v4 exact recovery review

Status: **proposed for new human review; no v4 live action authorized or executed**. The [v3 attempt](2026-09-24-second-unknown-create-recovery-v3-attempt.md) stopped before its signed request because the 12-minute server rollback timer no longer exceeded the request deadline plus the required margin. Its manual rollback ran an old-generation switch while `dev` was frozen; that switch hung until thaw and removed the temporary root SSH key. The server and isolated AMD app/runner have since returned to their prior state. This packet changes only the authority window and rollback order for **one** new attempt against the same saved CREATE. No sandbox CREATE is authorized.

## Exact current pins

| Item | Required value before any write |
| --- | --- |
| Fixture / CREATE | `incus-smoke-post-recovery-20260924` / `016f7e51-60a6-4e19-aa32-77d44b745053` |
| Binding | `incus-qual-binding-3fd085a2188deff6d167d727d33176e6b78f0ebb6e2ecc50fecbfc68167c31ae`, generation 1, `STOPPED`/`UNKNOWN` |
| Installation / release | `00bcc640-c430-4c9a-8d97-e35835b8bcf8` / `9ec8e626-0a5d-4ed6-9333-a3fd1aa25472` |
| Connection / preset | `540e2032-532f-4d8f-9a4e-df50c8e9f43a`, revision 1 / `incus-compose-v1` |
| Server project / derived instance | `ezharness` / `ezh-ec47ebd35d0d508dc3cd269e5b4666c8` |
| Old restricted client certificate | `engine`, type `client`, restricted to only `ezharness`, DER SHA-256 `fcd2d46c8f4007cd01098123e6bfbfba0c962b1c9d9f511bf222dfb7a9b3e622` |
| AMD generation | `/nix/store/i3d2l0ybkrlqaksa504k956bcd09j8y8-nixos-system-nixos-amd-26.05.20260430.15f4ee4`, NAR `sha256-ibIELcrZrx90zvywn4RiNFgMY64fGmM+CZv8BeFQw3U=` |
| Installed isolated app bundle | Git SHA `1ad9d81742fd9a49027c1fa58a3c1b0ee28c1c55` |
| Server running/profile generation | `/nix/store/aqs258f5nhvcksd562jgqcd6phqsk40m-nixos-system-sandbox-server-26.05.20260430.15f4ee4` |
| Temporary server generation | `/nix/store/r4y7zdn7imlb44mg2bmjx5kl1lpr8d5v-nixos-system-sandbox-server-26.05.20260430.15f4ee4`, NAR `sha256-bx0dyLlp+ioAuhURHqszyuH+1KW4wdy5xuZQHEepkHI=` |
| Server policy old / second-target SHA-256 | `966d68f791c7fd015a5151a0e9cbba4cba35bda35ed576c3246c003f36a2ee61` / `37b5c4ad0805bd3d40f2876646705b66f08198fb47fb5b02f8c63d785c66050c` |
| Second-target policy source | `/home/dev/work/nixos/.worktrees/ezh-second-noeffect-observer-target/policies/incus-noeffect-observer-policy-second-create.json` on AMD and `/root/ezh-admin-fence-b52efbc/second-policy-source-v3.json` on server; rehash both before use |
| AMD observer / composed fence candidate SHA-256 | `6a1cf1fbb59e3a60c6cee5efcb7f090fdbd5a59713ef4d3995b3ae139c449bcb` / `dcaaf5cd3b871d28744ee6073792ebf734d0e76731a4057da9b1f53f430b4025` |
| Temporary runner assertion | `/run/systemd/system/ezharness-qual-runner.service.d/hold.conf`, exact bytes `[Unit]\nAssertPathExists=/run/ezharness-qual-runner-allow-start\n`, SHA-256 `1d53feea8db4d5dae288619de1bcb7e7b08f5b71761101e011114f4fc91d4fdc`; allow-start path absent |
| Server audit / forced observer script SHA-256 | `612e01761586d4f76fa573f1e9875e1f9e4767e3f28342b88e48ce5f5343942e` / `e0b32cdcef1228bfbbecc41494cf26f49b6bfba1aa1cbe3d0df93e4ae557253a` |

The last stopped-app copy (private SHA-256 `ab2814cbfca72138a8d4657bd74d49935749b30e6755b10cd754d46ea2bece94`) showed one fixture/CREATE/binding/reservation/admission, no workspace or active run, CREATE `OUTCOME_UNKNOWN` with null provider operation ID, binding `STOPPED`/`UNKNOWN`, both reservations `RESERVED`, and admission `ADMITTED`. This is a checkpoint, **not** a live preflight for v4. The old client cert, original policy, and empty Incus project inventory were rechecked at 01:35 UTC on 25 September; recheck them again immediately before v4.

## Authority-window rule

Use a **25-minute** server timer, armed before testing the temporary generation. Its rollback command must **thaw before switching**:

Run this whole block in one dedicated root shell; do not paste individual lines. A failed guard must exit before the temporary generation test:

```sh
/run/current-system/sw/bin/bash -euo pipefail <<'SH'
OLD=/nix/store/aqs258f5nhvcksd562jgqcd6phqsk40m-nixos-system-sandbox-server-26.05.20260430.15f4ee4
NEW=/nix/store/r4y7zdn7imlb44mg2bmjx5kl1lpr8d5v-nixos-system-sandbox-server-26.05.20260430.15f4ee4
test "$(readlink -f /run/current-system)" = "$OLD"
test "$(readlink -f /nix/var/nix/profiles/system)" = "$OLD"
test "$(nix hash path --type sha256 "$NEW")" = 'sha256-bx0dyLlp+ioAuhURHqszyuH+1KW4wdy5xuZQHEepkHI='
jobs=$(systemctl list-jobs --no-legend --no-pager)
test -z "$(printf '%s\n' "$jobs" | sed -n '/^[[:space:]]*[0-9]/p')"
systemd-run --unit=ezh-admin-route-rollback --on-active=25m --property=Type=oneshot "$OLD/sw/bin/bash" -ec "$OLD/sw/bin/systemctl thaw user-1000.slice; $OLD/bin/switch-to-configuration test"
systemctl is-active --quiet ezh-admin-route-rollback.timer
"$NEW/bin/switch-to-configuration" test
SH
```

Before arming, require no switch jobs or processes, the exact old generation/profile, empty Incus inventory/operations, and the original cert/policy. The v3 transient rollback service finished with `Result=exit-code`, status 11. Inspect its journal and confirm the old-generation switch has settled, then use `systemctl reset-failed ezh-admin-route-rollback.service` and require both old transient units are unloaded or inactive before reusing the name. Do not reset a live timer or service. If the name remains occupied, stop for review; do not choose another unit name. The 25-minute change is **new authority**; v3 approved only 12 minutes. Capture the timer's actual monotonic deadline immediately after arming and at every gate. Do not infer it from `systemctl list-timers` rounded `LEFT` text. An expired timer, a failed rollback service, or a timer with insufficient margin is a stop. Never rearm it during an attempt.

Before certificate revocation, require at least **18 minutes** remaining on that active timer, with the server `dev` slice frozen and audited. This reserves the operator's 65-second observation gap, one 170-second request, a 10-minute post-deadline authority margin, and execution/rollback overhead. If this gate fails while the old certificate remains trusted, restore the old observer policy and perform the thaw-first rollback; do not revoke or construct a request. Immediately before the one signed request, require its actual deadline to be at least **10 minutes before** the timer deadline. Repeat that margin check before the supervisor call. The existing `frozen-until` server audit still requires its own 120-second margin and must also pass; it does not replace this stronger operator gate.

To compute the exact timer margin, use systemd's `NextElapseUSecMonotonic` for `ezh-admin-route-rollback.timer` and a same-host monotonic clock sample, as the installed root audit already does. Convert a proposed wall-clock request deadline to remaining milliseconds at the same sample. Record both values and require `timer_remaining_ms > request_remaining_ms + 600000` (strictly more than ten minutes). Before revocation, require `timer_remaining_ms >= 1080000`. A root-run read-only verifier for both gates is:

```python
import re, subprocess, sys, time

unit = "ezh-admin-route-rollback.timer"
def busctl(*args):
    return subprocess.check_output(["busctl", *args], text=True, timeout=4).strip()
path_response = busctl("call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
                       "org.freedesktop.systemd1.Manager", "GetUnit", "s", unit)
path_match = re.fullmatch(r'o "(/org/freedesktop/systemd1/unit/[A-Za-z0-9_]+)"', path_response)
assert path_match, "timer unit path mismatch"
path = path_match.group(1)
assert busctl("get-property", "org.freedesktop.systemd1", path,
              "org.freedesktop.systemd1.Unit", "ActiveState") == 's "active"'
elapse = busctl("get-property", "org.freedesktop.systemd1", path,
                "org.freedesktop.systemd1.Timer", "NextElapseUSecMonotonic")
elapse_match = re.fullmatch(r"t ([0-9]+)", elapse)
assert elapse_match, "timer deadline unavailable"
now_wall_ms = time.time_ns() // 1_000_000
now_mono_us = time.monotonic_ns() // 1_000
remaining_ms = (int(elapse_match.group(1)) - now_mono_us) // 1_000
assert len(sys.argv) in (1, 2), "unexpected arguments"
if len(sys.argv) == 1:
    assert remaining_ms >= 1_080_000, "less than 18 minutes before revocation"
else:
    request_remaining_ms = int(sys.argv[1]) - now_wall_ms
    assert 145_000 < request_remaining_ms <= 180_000, "request deadline out of range"
    assert remaining_ms > request_remaining_ms + 600_000, "ten-minute margin missing"
print({"nowMs": now_wall_ms, "timerRemainingMs": remaining_ms,
       "requestRemainingMs": request_remaining_ms if len(sys.argv) == 2 else None})
```

Run it without an argument immediately before revocation and with the new request's `deadlineMs` immediately before sending. Stop if the unit path, active state, clock sample, or numeric deadline cannot be read. Do not use a manually estimated deadline.

The inline verifier compiled and passed seven read-only fixture cases: 18-minute pre-revoke pass, one millisecond short rejection, request deadline with more than ten-minute margin pass, exact ten-minute margin rejection, overlong request deadline rejection, expired timer rejection, and inactive timer rejection. Against the deployed server at 2026-09-25 01:36 UTC, the pinned root audit script SHA-256 was `612e01761586d4f76fa573f1e9875e1f9e4767e3f28342b88e48ce5f5343942e`; its `running` check passed, its `frozen-until` check rejected the unfrozen slice, and the new verifier rejected the unloaded timer. These are negative/live-baseline checks. A positive live comparison of both timer readers is an **execution gate immediately after the newly approved timer is armed and before certificate revocation**, not a result claimed now.

## Bounded execution stages

1. **Fresh read-only preflight.** The prior private admin session is unavailable. Use only the audited stopped-app copy/readback method from the v3 receipt: stop the isolated app behind the TCP hold, copy PGlite while stopped, restart, then query the copy; never open the live PGlite directory concurrently. Require the checkpoint fixture/CREATE/binding/admission states above and no competing qualification run. After restart, record stable supervisor/app PIDs and verify AMD generation and loaded supervisor `Requires` excludes runner, exact installed app bundle, root-only health/readiness, active runner/private socket, absence of recovery hold, and full TCP ingress hold. Verify all candidate hashes and root-owned 0600 configuration files. On the server, verify old generation/profile, `dev` route, original policy/cert, zero project instances/operations, no timer/job/switch process, and the reviewed root SSH identity and forced observer script. Any drift requires a new review.
2. **Local client fence.** Install only the exact second-target AMD observer and composed fence candidate. Install the exact temporary runner assertion drop-in with absent allow-start path, stop the dedicated runner, disable its linger and terminate only UID 62041 after inventory. Require a real start attempt to fail, no runner PID/UID process/socket, and the **same** supervisor PID/app child/operator socket as before. Keep TCP ingress hold. Stop if any of those change.
3. **Server admin fence and policy.** Arm the exact 25-minute timer and test the temporary server generation. From a fresh root SSH route, verify candidate running system, old profile, active timer, denied new dev/setup SSH, healthy Incus/SSH/Tailscale, and empty inventory. Freeze `user-1000.slice`; require `cgroup.freeze=1`, `frozen 1`, all dev processes inside it, setup UID absent, and the pinned root audit passing. Save the original policy, atomically install only the second-target policy SHA above, then require restricted observer denial while the old cert is still trusted. The **18-minute pre-revoke gate** must pass here.
4. **Certificate fence and observations.** Under the frozen audit, save the exact old PEM to a new root-owned 0600 file with exclusive creation; verify DER fingerprint, client type, name, and project restriction. Recheck empty inventory/operations and the 18-minute gate, then remove only the exact fingerprint. Verify trust now empty. Run the restricted forced-command observer twice, at least 65 seconds apart, with fresh frozen audit and timer checks around each. Both exact JSON results must name the **second** instance, report `absent:true`, `activeOperations:[]`, and `oldCertificateRevoked:true`. Preserve the two timestamps and responses privately. Any mismatch is a stop; restore the exact cert and old policy under freeze, then thaw-first rollback.
5. **One fresh signed request.** Recheck the preflight copy's immutable IDs and all current host fences; do not depend on an unavailable private admin session. The supervisor must perform its own validation against the stopped **live** database during recovery. Create a **new** root-owned 0600 request with `O_EXCL`, a fresh nonce and review ID, and a deadline 170 seconds ahead. Use only the pinned IDs above, `allClientsFenced:true`, and the actual fence/observation receipts. Do not use `/root/ezh-qualification-stage/second-v3-noeffect-request-20260924.json` or any earlier nonce. Require the timer deadline to exceed this request deadline by **more than 600000 ms** and require the existing server `frozen-until <deadlineMs>` audit to pass. Submit the request **once** through the root supervisor using `--recover-request`. The supervisor independently stops its app, waits and observes, signs, and applies. A timeout or unknown response is **not** permission to send again.
6. **Durable receipt and exact restoration.** Require CREATE `FAILED` with `OPERATOR_PROVEN_NO_EFFECT`, a separate audited no-op DESTROY `SUCCEEDED`, binding `ABSENT`, released reservations, and independent empty server inventory. If the supervisor response is lost or a check fails, do **not** assert that CREATE is still `OUTCOME_UNKNOWN`: it may have applied before the response was lost. Leave AMD ingress/runner fenced, inspect the supervisor hold, make a stopped-app database copy, and classify the actual durable rows and server inventory before any authority release. Never resubmit the request. If no apply occurred and durable CREATE is still `OUTCOME_UNKNOWN`, restore the exact old cert and old policy under server freeze, then do the thaw-first rollback below. If the rows are partial, conflicting, or cannot be read, preserve local fences and stop for a new review while the server's timed rollback remains armed.

   On a fully verified success, restore the **same** backed-up `engine` certificate under server freeze with `type:client`, `restricted:true`, `projects:["ezharness"]`, and the exact DER fingerprint above; restore the original server policy SHA above. Then `systemctl thaw user-1000.slice`, require `cgroup.freeze=0` and `frozen 0`, and let any already-running rollback finish before another switch. If no switch job runs and the server remains temporary, run the exact old generation's `switch-to-configuration test` once. Require old running/profile, fresh dev SSH, original cert/policy, timer result, and empty inventory/operations before stopping a still-active timer. Restore the original AMD observer/fence files from byte-checked backups, remove only the exact temporary runner assertion, re-enable linger, and start only the dedicated runner. Require its authenticated socket, supervisor/app health and readiness, durable recovery rows, absent hold marker, and the TCP ingress hold. **Keep TCP ingress held**; a new guest CREATE or traffic release needs its own decision.

The operator must save exact UTC arm time, monotonic timer deadline and margin at pre-revoke and pre-request gates, every observer read time, request deadline, signed receipt or stop reason, server rollback job and exit state, final generation/profile, cert/policy hashes, app/runner/hold checks, and durable CREATE state. No action in this packet is approved by earlier v3 approval. It is a concrete review artifact for a new exact decision.
