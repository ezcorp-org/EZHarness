# Second unknown CREATE: guarded host activation and recovery

Status: **prepared for one exact approval; no v3 live action yet**. The [first attempt](2026-09-24-second-unknown-create-recovery-attempt.md) stopped when the server observer named the wrong instance. The [second attempt](2026-09-24-second-unknown-create-revised-attempt.md) stopped before runner or server changes because a systemd drop-in could not remove the supervisor's base-unit dependency. Both attempts restored their temporary changes and sent no signed recovery request. The saved CREATE remains `OUTCOME_UNKNOWN`.

This packet combines two conditional stages. Stage A activates the corrected AMD NixOS unit under a timed rollback. Stage B runs the already defined no-effect recovery with the exact second-target server observer policy. Stage B is forbidden unless Stage A passes its loaded-unit, service, app, and traffic-hold checks. A changed generation, digest, target, certificate, or authority route requires a new review; this approval would not authorize substituting another candidate or repeating an unknown effect.

## Exact state and artifacts

| Item | Pinned value |
| --- | --- |
| Fixture / CREATE | `incus-smoke-post-recovery-20260924` / `016f7e51-60a6-4e19-aa32-77d44b745053` |
| Binding / generation | `incus-qual-binding-3fd085a2188deff6d167d727d33176e6b78f0ebb6e2ecc50fecbfc68167c31ae` / 1 |
| Provider / connection | release `9ec8e626-0a5d-4ed6-9333-a3fd1aa25472`; connection `540e2032-532f-4d8f-9a4e-df50c8e9f43a` revision 1 |
| Incus project / exact instance | `ezharness` / `ezh-ec47ebd35d0d508dc3cd269e5b4666c8` |
| Scoped old client certificate DER SHA-256 | `fcd2d46c8f4007cd01098123e6bfbfba0c962b1c9d9f511bf222dfb7a9b3e622` |
| Current AMD generation | `/nix/store/qnfynrsjm8k3lnxqry6pkr7mqyvdl4v1-nixos-system-nixos-amd-26.05.20260430.15f4ee4`; NAR `sha256-gYT7R85siRNL8HLi5UMrRsmc09XBxZoNlyGScLiu1y8=` |
| New AMD generation | `/nix/store/i3d2l0ybkrlqaksa504k956bcd09j8y8-nixos-system-nixos-amd-26.05.20260430.15f4ee4`; NAR `sha256-ibIELcrZrx90zvywn4RiNFgMY64fGmM+CZv8BeFQw3U=` |
| New AMD source | [NixOS PR #13](https://github.com/EZArchy/nixos/pull/13), reviewed branch tip `410eba1034bcd87465eaf291c8689ab5586012f0` |
| Old server observer policy SHA-256 | `966d68f791c7fd015a5151a0e9cbba4cba35bda35ed576c3246c003f36a2ee61` |
| Second-target server policy SHA-256 | `37b5c4ad0805bd3d40f2876646705b66f08198fb47fb5b02f8c63d785c66050c` from [NixOS PR #12](https://github.com/EZArchy/nixos/pull/12) |
| Temporary server administrator-fence generation | `/nix/store/r4y7zdn7imlb44mg2bmjx5kl1lpr8d5v-nixos-system-sandbox-server-26.05.20260430.15f4ee4`, NAR `sha256-bx0dyLlp+ioAuhURHqszyuH+1KW4wdy5xuZQHEepkHI=` |

The current isolated supervisor and runner are active. A root-only app health check returned HTTP 200; the local TCP hold passed and denies ordinary access. The exact old restricted certificate is trusted, and the server project inventory was empty at the last readback. These observations are preflight inputs, not final recovery evidence. The authority and durable state must be read again at execution time.

## Stage A: guarded AMD unit activation

Use the full command blocks and rollback procedure in [PR #13's activation packet](https://github.com/EZArchy/nixos/blob/410eba1/docs/ezh-qualification-recovery-runner-dependency-review.md). Its read-only preflight passed on AMD and checks exact current/candidate NAR hashes, closure availability, unit hashes, existing recovery environment drop-in, active services, root-only app health, and traffic hold. Its three command blocks passed syntax checks. The generated-unit test and activation-packet zero-match test passed. An independent Astra review found the generated unit semantics sound and caught a zero-match check, which was fixed and tested before this packet.

Arm the exact 15-minute rollback timer before `switch-to-configuration test`. Require the loaded supervisor `Requires` to contain the runtime check and **not** the runner; `Wants`/`After` and the startup active-runner check must remain. Require the runner, supervisor, operator socket, app health, and TCP hold to pass before selecting the new system profile and switching. From a fresh session, require at least two minutes of timer margin, an idle rollback service, and all checks again before disarming the timer. On any failure, keep the timer armed or run its reviewed rollback; do not start Stage B. Stage A changes the normal AMD unit and leaves the new generation active if successful.

## Stage B: exact no-effect recovery

Use the immutable IDs and durable-state checks in the [original target packet](2026-09-24-second-unknown-create-recovery-review.md), the [second-target server policy packet](https://github.com/EZArchy/nixos/blob/1130e55/docs/ezh-second-noeffect-observer-policy-swap-review.md), and the server authority fence procedure recorded in the [first attempt](2026-09-24-second-unknown-create-recovery-attempt.md), with the following mandatory order. The older packet's first-target policy and runtime-mask instruction are stale and must not be reused.

1. Re-read the saved fixture, CREATE, binding, reservation, admission, release, connection, and target. Reinstall only the exact second-target AMD observer/composed fence files after checking their staged hashes. Keep the local traffic hold. No parallel access to the live PGlite directory.
2. Under the now-correct loaded AMD unit, install and prove the separate runner assertion gate, stop the runner, and test that a real start attempt is denied. Require no runner UID process, cgroup, or socket. Require the **same supervisor PID and operator socket** and its managed app child to remain active. If the supervisor stops or restarts, stop before any server write.
3. Activate the separately reviewed temporary server administrator freeze and timer. Verify frozen `dev` slice, denied new `dev`/setup SSH, and root audit. Back up the root-owned old observer policy and atomically swap only `/etc/ezharness/incus-noeffect-observer-policy.json` to the exact PR #12 SHA. Verify ownership, mode, script pin, and target. While the old client certificate is trusted, the restricted observer must deny the no-effect read.
4. Back up the exact old client certificate, recheck its DER fingerprint/restriction, and revoke only that fingerprint under the live fences. The restricted forced-command observer must return **the second instance** with `absent:true`, no active operations, and `oldCertificateRevoked:true`. Repeat an independent read at least 65 seconds later with fresh audit and timer checks. A mismatch stops the attempt; the saved CREATE remains unknown.
5. Construct one fresh request for only this saved scope. Submit it once through the root supervisor socket. The supervisor stops its managed app, holds ingress, independently repeats the spaced no-effect reads, verifies durable state and fences, signs the receipt, and applies the recovery transaction. Require CREATE `FAILED` with `OPERATOR_PROVEN_NO_EFFECT`, audited no-op DESTROY `SUCCEEDED`, binding `ABSENT`, released reservation, and independent server inventory before any new sandbox CREATE.
6. Restore normal runner/client/admin authority only after the durable receipt and host checks pass. Decide and record whether the observer policy returns to the backed-up first-target version after this recovery is closed. Keep the AMD generation from Stage A active; verify its loaded unit, app, runner, and traffic hold. Record exact timestamps, hashes, request/receipt IDs, and cleanup in a new execution receipt.

If Stage B fails after a server write, do not repeat CREATE or assert no effect. Keep the traffic hold and client fences. Restore only the exact backed-up certificate while the server admin freeze is active, verify its original scope, and account for the observer policy before restoring ordinary server routes. If a supervisor recovery hold exists, leave the app stopped until its durable state is reviewed. The prior two attempt receipts show the stop and rollback evidence; they do not authorize a third attempt by themselves.

The first and second approvals covered earlier packets and did not cover the new NixOS generation. **A fresh exact approval of this packet is required for both conditional stages.** No sandbox will be created until the signed recovery and durable cleanup pass.
