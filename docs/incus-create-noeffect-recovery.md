# Operator repair for a pre-fix unknown Incus CREATE

This path is for one qualification fixture whose CREATE operation is
`OUTCOME_UNKNOWN` and has no provider operation ID. It does not infer that
the operation had no effect from that null ID. It does not run SP cases or
change public readiness.

The saved 2026-09-24 incident is still pending. Its fixture operation ID is
`live-fixture-20260924`; its controller CREATE ID is
`62633686-a1bc-4b93-b87a-54fdbc96c2fd`. No command in this repository has
been run against its live database or Incus server.

## Required operator fence

Use a dedicated app UID and the root-owned supervisor. Stop new HTTP traffic
and every other app and runner client that can use this Incus connection.
Record the service stop, ingress hold, client inventory, and review ticket in
`fenceEvidence`. The supervisor stops its exact managed child and kills its
process group. It refuses repair if another local process still has the app
UID. It checks for a shared UID before stopping the child, so this known
preflight failure leaves the app running. It also requires a separate
root-owned `recoveryFenceCommand` to prove
that detached runners and other clients are stopped. Without that configured
verifier, recovery fails closed. It then waits 65 seconds, beyond the host
transport's 30-second deadline and the v4 worker's 60-second policy,
deadline, and makes two separate durable and pinned Incus observations at
least five seconds apart. Both project-wide operation lists and the exact
named instance must be empty or absent. This check depends on both the
operator's assertion and the independent fence command's proof for clients
outside the managed app.

The operator-owned connection config named by
`EZCORP_INCUS_NOEFFECT_CONFIG` must be a root-owned mode `0600` JSON file
with `context` and `transportConnection` in the same shapes used by
`incus-qualification-supervisor-receipt.ts`. It must pin the reviewed
installation, release, connection revision, project, server certificate,
image, and preset. Set `EZCORP_INCUS_SUPERVISOR_DB_PATH` to the app's exact
persistent PGlite directory. The app-UID verifier opens PGlite only while
the app is stopped. The operator verifier reads Incus over pinned mTLS. The
signing key remains root-owned outside the app.

Add these fields to the supervisor's private JSON config:

```json
{
  "operatorSocket": "/run/ezharness-incus-control/operator.sock",
  "recoveryCommand": [
    "/run/current-system/sw/bin/bun",
    "/opt/ezharness/scripts/incus/incus-create-noeffect-recovery.ts"
  ],
  "recoveryFenceCommand": ["/run/current-system/sw/bin/false"]
}
```

The example `false` command deliberately blocks repair. Replace it only
with a reviewed operator command that checks the exact client inventory,
stopped runner services, and any remote credential holders. It receives
`{"request": ..., "oldProcess": ...}` on stdin and must return exactly
`{"fenced": true, "evidence": "<the request fenceEvidence>"}`. Any other
result fails closed.

The operator socket is mode `0600` and accepts only the supervisor UID. It
is not a public HTTP action. Prepare a root-owned mode `0600` JSON request
with the exact IDs read from the saved fixture and operation. Use a fresh
nonce, an expiry about two minutes ahead, and a review ID:

```json
{
  "version": 1,
  "action": "recover-noeffect",
  "nonce": "fresh-operator-nonce",
  "reviewId": "review-ticket",
  "scope": {
    "installationId": "00bcc640-c430-4c9a-8d97-e35835b8bcf8",
    "releaseId": "02ce233e-ccbf-4b19-a93f-4e6ee63a926a",
    "connectionId": "9be7969a-0319-4cd7-8b85-d6e034f0f226",
    "presetId": "incus-compose-v1"
  },
  "fixtureOperationId": "live-fixture-20260924",
  "bindingId": "READ_FROM_SAVED_FIXTURE",
  "operationId": "62633686-a1bc-4b93-b87a-54fdbc96c2fd",
  "generation": 1,
  "connectionRevision": 1,
  "allClientsFenced": true,
  "fenceEvidence": "review ticket and exact client stop evidence",
  "deadlineMs": 0
}
```

Replace the binding ID, generation, revision, nonce, review ID, evidence,
and deadline from a fresh read-only review. The example's `deadlineMs: 0`
is invalid by design. After the review, run as root:

```sh
python3 scripts/incus/incus-qualification-supervisor.py \
  --config /etc/ezharness/incus-supervisor.json \
  --recover-request /root/incus-noeffect-request.json
```

The supervisor returns a signed receipt and cleanup operation ID only after
the transaction commits. The transaction locks the exact fixture, binding,
CREATE, reservation, and project, and checks the sole admission. It rejects a provider operation
ID, another operation or claim, an active qualification run, a changed scope
or resource, stale backend observations, or a replay. It keeps the original
CREATE row and its idempotency key, marks it `FAILED` with
`OPERATOR_PROVEN_NO_EFFECT`, creates a separate audited no-op DESTROY receipt,
marks the binding `ABSENT`, and releases compute and disk in one transaction.
The `incus_noeffect_recoveries` audit row stores the original CREATE row
and signed operator receipt. The supervisor starts the app again only after
the offline step ends.

If the fence, pinned reads, or row checks cannot be proved, leave the saved
operation `OUTCOME_UNKNOWN`. Keep the app stopped for manual review of Incus
operations, logs, and every client that held these credentials. Do not clear
the row merely because the current instance list is empty.

The current isolated app runs under the shared development UID 1001. Other
processes use that UID, so the local process fence will reject recovery.
Move the isolated app to a dedicated supervised UID and verify that no
other local process uses it before any live repair review. Also supply the
independent runner client fence command; neither preflight is in place now.
