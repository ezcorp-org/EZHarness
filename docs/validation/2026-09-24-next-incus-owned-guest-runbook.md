# Next EZHarness-owned Incus guest: one lifecycle

Status: **runbook only; no live guest action or success claim**. The second unknown CREATE has a [signed v4 recovery receipt](2026-09-25-second-unknown-create-recovery-v4-execution.md) and an absent binding. Use this sequence only with the fixed scope and fresh gates in the [25 September guest smoke review](2026-09-25-next-incus-owned-guest-smoke-review.md). This smoke proves one guest lifecycle. The full SP01–SP08 qualification is a separate gate.

## Fixed scope and entry gate

The isolated app is at `http://127.0.0.1:4301`. Every request below is a same-origin `POST` with `Content-Type: application/json` from a human admin session. Keep the existing TCP ingress hold and use the established private admin session. Do not place the cookie in this document or shell history. An API key cannot call these routes.

| Field | Value |
| --- | --- |
| `installationId` | `00bcc640-c430-4c9a-8d97-e35835b8bcf8` |
| `releaseId` | `9ec8e626-0a5d-4ed6-9333-a3fd1aa25472` (approved release 0.1.2; digest `4c0e2eee0f9105d28a5173ec695bd42c6b84de58233570fb0ffb2dcf03a6ac18`) |
| `connectionId` | `540e2032-532f-4d8f-9a4e-df50c8e9f43a`, revision 1 |
| `presetId` | `incus-compose-v1` |
| old fixture to recover | `incus-smoke-post-recovery-20260924`; CREATE `016f7e51-60a6-4e19-aa32-77d44b745053` |
| proposed **new** `operationId` | `incus-smoke-owned-lifecycle-20260925-v1` (authoritatively absent in the reviewed detached copy; recheck scope before use) |
| backend project | `ezharness` |

Before a new CREATE, read the old fixture's saved status and signed recovery result. Require old CREATE `FAILED`/`OPERATOR_PROVEN_NO_EFFECT`, no-op DESTROY `SUCCEEDED`, binding `ABSENT`, and released reservation. Check the server inventory and active operation list, app and runner health, active release/connection revision, setup receipt, 32 GiB capacity record, and the exact release artifact in the dedicated runner store. Verify that the server's scoped client certificate is restored and that the setup gate and app use the intended current configuration. If any authority, digest, or state changed, stop and review the new values. An empty Incus list alone does not settle an unknown operation.

Check the pinned guest image and helper digest against the active preset and image receipt. The last direct worker probe reported `Incus helper version pin does not match` because the unqualified transport reports the helper as `unverified`; the guest smoke must prove the actual helper before claiming support. The isolated app already has a reviewed immutable `EZCORP_INCUS_COMPOSE_FIXTURE_IMAGE_REF`; recheck it before CREATE. The Compose action must prove that exact digest runs inside the new guest. Do not substitute a mutable tag.

## One smoke sequence

Use `/api/infrastructure/incus/smoke` for each action. Send **exactly** these six JSON fields: `action`, `installationId`, `releaseId`, `connectionId`, `presetId`, `operationId`. The five ID values remain fixed for every call. Save the HTTP status, response body, time, and host/app logs in a root-private evidence directory. Never copy credentials into the packet.

```json
{"action":"create","installationId":"00bcc640-c430-4c9a-8d97-e35835b8bcf8","releaseId":"9ec8e626-0a5d-4ed6-9333-a3fd1aa25472","connectionId":"540e2032-532f-4d8f-9a4e-df50c8e9f43a","presetId":"incus-compose-v1","operationId":"incus-smoke-owned-lifecycle-20260925-v1"}
```

For each later call, change only `action` to the next value below. Supply the existing admin session cookie and `Origin: http://127.0.0.1:4301` through the private operator client. Do not add a guest command, image, path, generation, or credential field: the route rejects extra fields.

1. `create`: expect HTTP 202 with `operation.kind=CREATE`, then `status`: require `operation.state=SUCCEEDED`, `binding.desiredState=STOPPED`, `binding.observedState=STOPPED`, and one exact tagged Incus instance in project `ezharness`. Record the returned controller operation ID, binding ID, backend instance ID, generation, provider operation ID, and image/profile/resource readback. If CREATE is `OUTCOME_UNKNOWN`, stop. Do not send another CREATE or DESTROY until the effect is reconciled.
2. `inspect`: record `inspection` for the stopped guest. Require the expected image and helper digests, `sandbox` guest user, `/workspace`, private network, restricted project, unprivileged mode, and preset resource ceilings. Compare this host witness with an independent Incus inventory read.
3. `start`: expect HTTP 202 with `operation.kind=START`; poll `status` until `SUCCEEDED` and desired/observed `RUNNING`. Record the start operation ID and guest boot ID from `inspect`. A pending or unknown power result blocks the next action; the route replays the same saved result when repeated.
4. `marker`: expect HTTP 200 with path `ezh-smoke-marker`, size, and SHA-256. The host witness writes and reads the fixed guest file through the provider. Record the digest and confirm that no AMD workspace file was changed. The route does not accept a caller-selected path or command.
5. `compose`: expect HTTP 200 with the reviewed immutable image reference, `service=proof`, `exitCode=0`, and `outputMarker=ezh-compose-ok`. This uses the guest's Docker Compose one-shot service and is not a general app bootstrap test. Record guest Docker/Compose logs, image digest, and resource readback. A 503 means the host image reference is missing or mutable. A 409 requires log and durable-status review before a deliberate retry.
6. Re-read `status` and `inspect`, then `stop`: require a new `STOP` receipt that settles `SUCCEEDED`, desired/observed `STOPPED`, and a retained instance/workspace. `start` and `stop` keys are derived by the route from generation and the prior operation. Do not invent a new key. Reconnect the admin client and confirm the same binding and instance IDs. Then `destroy`: require `DESTROY` `SUCCEEDED`, binding `ABSENT`, released reservation, no endpoint or lease residue, and an independent project inventory with no instance or active operation for this ID. Retain the operation and audit receipts.

The route returns HTTP 409 `smoke_unavailable` for a failed host witness or uncertain result. Use `status` and host logs to classify the failure. Do not infer success from HTTP 202; it reports an admitted operation receipt. If cleanup is unknown, retain it for reconciliation and do not create another fixture to conceal it.

## Full qualification after smoke

Only after the smoke and its cleanup pass, use `/api/infrastructure/incus/qualification` with the same scope, `action=qualify`, and a **fresh** stable `operationId` for the durable run. This is not the smoke fixture ID. The route needs the host live witness readiness gate, pinned Compose image, private control-probe root, supervisor socket and public key, and qualification user project. HTTP 202 returns a durable `run`; it does not mean SP01–SP08 passed. Track the saved run and supervisor continuation until all eight real cases complete and `incus_live_qualifications` contains the current release, connection revision, preset/image/helper digests, backend observation, and validity. Confirm fixtures are cleaned and the provider preflight then advertises only the qualified profile. Any helper mismatch, restart failure, resource/network test failure, or stale scope keeps qualification unavailable.

## Evidence and limits

Save the request IDs, redacted API receipts, app/runner logs, Incus operation IDs and inventory, guest inspection, marker digest, Compose output, reservation readback, and final cleanup comparison. The existing [smoke route gate](../../gates/incus-smoke-route.md) records focused route tests; it is not live evidence. One successful smoke does not prove SP01–SP08, a user feature checkout, tool routing, or the complete PRD acceptance suite. Those need separate runs after this first guest works.
