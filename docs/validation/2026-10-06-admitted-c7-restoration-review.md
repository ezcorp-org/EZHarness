# Restore the already admitted c7 cleanup

Status: one signed restoration and normal app startup succeeded and passed
independent verification. The queued cleanup then reported OUTCOME_UNKNOWN;
its stopped guest remains present. This restored the existing
cleanup; it did not repeat recovery, extend an expired clock, or grant new
backend authority.

## Exact scope

Cleanup: `8720a719-b3cd-44d7-a00d-5a57f4262fca`, currently JOURNALED.
Original START: `c7b5f35d-aa75-421f-aa6b-0741840c8c39`, still UNKNOWN.
Original receipt SHA-256:
`e59e2caf33034aba63e63a601aa3eef5313bee4eb52e9bf4abbbd4afeee01061`.
The [attempt 6 result](2026-10-06-c7-consumer-preflight-attempt6-result.md)
records actual admission, detached-database proof and closed temporary access.

The installed app remains source `5080f3792dbbedcdae17b81368ed9ee83ba41b80`,
manifest `f935dbb456db40581cf1642f1f6bd2049e28062f605298ea395dff0195191748`.
The saved hold, request, configuration and restoration journal remain intact.
The exact unsettled set is the older 069 UNKNOWN operation, c7 UNKNOWN and
the queued 8720 cleanup. Other operations must not be admitted by this path.

## Reviewed implementation

Reuse the previously successful admitted-restoration consumer through the
installed supervisor's supported restoration command. Its new receipt lasts
30 seconds; its control calls keep the 25-second bound. It verifies the
original signed admission, current provider authority, database identity,
exact historical files and current certificate before starting the runner.
Server checks are GET-only through the normal approved SSH connection.

Runner startup now sets marker owner/group explicitly to root:root. It starts
once, waits for a new socket and stable process identity, then applies the
unchanged strict account, command and socket checks. It does not accept a
weaker identity or restart repeatedly. Actual consumer tests reproduce the
old startup and ownership failures and pass with this correction.

| Item | SHA-256 |
| --- | --- |
| Consumer | `f134a2cde5fe339a2ababa518f6d026c99f656df4a02440132bafc28dd9e5df8` |
| Consumer configuration | `05d6a13d80f0afd8417afab95a29b7e4c2e4dec23b434fe520a67c3d591016ad` |
| Restoration request | `e5039d45fe7120f161c5e312d89d63eedf6b2d3541d5302dbd5963809b014de1` |
| Admission inspector | `da776536ea0c021f6d42c8fc2d520d92548a93cd22f879d58808ade4734431ac` |
| Readiness helper | `3ff86d2c8289553d77913d6d031024faea4d129c910ba0bf1f22ee9bd7b895e5` |
| Certificate reader | `beb6070497ebe13621b42badab18a35e0c126acb808c4774a32dce57c7b1c271` |
| Historical archive helper | `4643094b683a732207f6edefc75f4d2795c50036656ec8cb15cdbead97a65487` |
| Offline supervisor configuration | `eba4b4da36fe45042ac9ad847d8712186b95e74eb5617272f355107029317188` |
| Normal app restoration | `7b6716096a85d8cda536d13b9db0eb6331b761e0bd002e8f122c30692e9b0b27` |

Private stage: `/root/ezh-qualification-stage/oct06-admitted-restoration-8720`.
The app-readable inspector is separately staged under
`/opt/ezharness-admitted-restoration-8720`. The configuration pins the complete
14-artifact dependency set. Private credential bytes must not enter evidence
or logs.

The offline supervisor configuration adds only the fixed restoration command,
the original request/configuration/journal paths, and stopped-actor guards.
It does not replace the normal service configuration. The historical archive
uses atomic no-overwrite renames for the exact three older 8157 records;
their hashes, inodes, signature and successful terminal state are checked.
The current 8720 hold is checked unchanged before and after.

Actual staged checks passed: the app-user loader rejected the empty frame
before opening the database, and the full supported inspection returned the
exact admitted cleanup, original receipt, current source and manifest.
Independent inspection evidence prefix: `d0edd9a9`.

## Execution gates

1. Check exact staged hashes and metadata. Pass the actual Bun loader as UID
   62040 with a rejected empty input before any database open.
2. With all managed actors stopped and no database handles, run the actual
   supported inspection command. Require exact committed admission and current
   GET-only certificate proof before signing.
3. Preserve only the three verified historical 8157 restoration artifacts in
   a fresh archive with unchanged bytes/inodes. Check their exact identities
   before moving them. Leave the current hold and 8720 records untouched.
4. Review the exact supervisor configuration change and fresh host conditions.
   Submit one restoration-only request. Preserve every intent and response;
   never infer no effect from a timeout or repeat a consumed start.
5. Require transport readiness and the supervisor's supported archive of the
   exact hold. Restore normal configuration/startup through reviewed steps.
6. Read back the existing cleanup's terminal result, actual reservations and
   independent guest/storage absence. Admission or transport readiness alone
   does not close cleanup or end-to-end qualification.

The immutable attempt 6 packet stays unchanged. No new guest, provider
activation, firewall/network change, issuer credential change, or database
restore is included. The continuing user goal authorizes this scoped work;
no claim is made that the user reviewed an unseen new digest.

## Actual result

Signed-restoration result SHA-256:
`13f60fe66d1aa577b68f14d0d84472ce188b81f1f868476d3eb5ded2366c9e0f`.
The result identifies only cleanup 8720 and reports `transportReady` and
`holdArchived` true. Independent review verified the actual signature,
original admission/history, exact completion proof, absent active hold,
archived hold bytes, and strict runner account/command/socket identity.
The new startup marker is root:root, empty and mode 0600 as required.

Before signing, the failed restoration's previous marker was atomically moved
to `/run/ezharness-qual-runner-allow-start.held-8720-before-restore`.
Device 27, inode 3335056, ownership, mode, link count and empty bytes stayed
the same. Rename changed ctime, so the initial whole-stat assertion failed;
the move was not repeated. Independent readback verified the intended state
and unchanged current hold before the signed request proceeded.

Starting the app and proving queued DESTROY success, released reservations,
and independent backend absence are still required. Transport restoration
alone does not establish end-to-end completion.

The normal-restoration helper passed actual read-only bootstrap/proof checks
and two focused guard tests independently. It verifies this signed result,
stops only the verified runner, preserves its temporary marker, restores the
five original configuration backups, and recreates the original marker's
root:62040/0600/empty semantics. It then starts the same installed app to process
the existing queue. Its pause/configuration/start phases have separate durable
intents; it contains no new cleanup admission or database restore.

All three normal-restoration phases returned exit 0 with healthy startup on
508/f935 and current authority verified. Receipt 299 then records cleanup
8720 as OUTCOME_UNKNOWN, with no provider operation handle or saved error.
The binding remains desired ABSENT and observed STOPPED. Receipt 300 still
finds the exact stopped guest. This is a new uncertain cleanup outcome,
separate from the original c7 START. Do not repeat deletion or report released
reservations. Read-only diagnosis of the provider response is in progress.
