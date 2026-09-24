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
then makes two separate durable and pinned Incus observations at
least five seconds apart. Both project-wide operation lists and the exact
named instance must be empty or absent. This check depends on both the
operator's assertion and the independent fence command's proof for clients
outside the managed app.

The operator-owned config named by `EZCORP_INCUS_NOEFFECT_CONFIG` must be a
root-owned mode `0600` JSON file with `context` (the reviewed
`LiveReadbackContext`) and `observation`:

```json
{
  "host": "PINNED_INCUS_SSH_HOST",
  "user": "DEDICATED_FORCED_COMMAND_SSH_ACCOUNT",
  "identityFile": "/etc/ezharness/noeffect-observer.key",
  "knownHostsFile": "/etc/ezharness/noeffect-known-hosts",
  "project": "ezharness",
  "instance": "EXACT_DERIVED_INCUS_INSTANCE_NAME",
  "oldCertificateSha256": "EXACT_64_LOWERCASE_HEX_DER_FINGERPRINT"
}
```

The instance name must equal the name derived from the saved connection and
binding IDs. Pin the SSH host key in the dedicated known-hosts file. Both
the key and known-hosts files must be root-owned, regular, mode `0600`, and
have no symlink at their final path. This key must be distinct from the
app's provider certificate and from the setup operator's SSH key. The
observer config contains no provider private key. Set
`EZCORP_INCUS_SUPERVISOR_DB_PATH` to the app's exact persistent PGlite
directory. The app-UID verifier opens PGlite only while the app is stopped.
The signing key stays root-owned outside the app.

On the Incus host, install the reviewed `ssh-gate.py` as root-owned code.
Create a separate SSH account with one observer public key, no password
login, no other keys, and no unrestricted sudo. Bind that key with OpenSSH
`restrict` and a forced command that runs the gate with one root-owned
policy file. Incus group access is privileged; the forced command and policy
are the authority boundary for this account. The forced command must receive the exact SSH original command
`ezh-incus-noeffect-observe-v1`. The dedicated policy has exactly these
fields: `version: 2`, `purpose: "noeffect-readback"`, `project`, `instance`,
and `oldCertificateSha256`. It must pin the same values as the operator
config. It has no command list or write classification. The account must
have only the rights needed for `incus list --project=...`, project-scoped
`incus query /1.0/operations?project=...`, and `incus config trust list`.
Review the host account, key, policy owner and mode, forced command, and
Incus authorization before use. This repository does not install them.

Revoke the old provider client certificate on the Incus host after all
clients are fenced. The observer requires its exact DER SHA-256 fingerprint
to be absent from the complete trust list. It also requires the exact
instance to be absent and every project-scoped active operation list to be
empty. Failed, malformed, or slow reads reject recovery. The observer does
not take a command, host, project, instance, or fingerprint from the repair
request. The SSH connection uses the private pinned host-key file, disables
password authentication and forwarding, and has a bounded timeout. Do not
use the setup gate's version 1 command policy for this observer.

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
nonce, a deadline between 145 and 180 seconds ahead that provides headroom
for the 65-second wait and bounded readback stages, and a review ID. A stage
that reaches its own limit or the request deadline still fails closed:

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
