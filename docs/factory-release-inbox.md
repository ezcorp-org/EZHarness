# Factory inbox

Generic workflow approvals and release notifications use the durable `factory_notifications` queue. The queue row is the outbox record and the in-app inbox record. `FactoryNotificationDelivery.deliverNext(projectId)` changes one queued row to `delivered` in one database transaction. It does not call email, chat, webhook, or another notification service.

The application must call `releaseOperations.notifications.deliverNext(projectId)` from its bounded delivery worker. A restart can call it again. The queue deduplication identity and the atomic delivered transition keep one visible item.

Interactive users read `GET /api/factories/projects/:projectId/release/notifications?limit=50&cursor=...`. The store checks the live project membership and grant in the same transaction as the bounded query:

- `approval_requested` requires `factory.approve` and stays visible only while the exact approval is pending, unexpired, and attached to a pending release operation.
- `command_approval_requested` requires a human session and `factory.approve`. An `owner` request is visible only to the durable run initiator. An `operator` request is visible to a current approver. A `tenant-contract-admin` request also requires the existing `factory.trust` administrator rule. It stays visible only while its exact committed command, run fence, deadline, and protected context are current.
- `release_uncertain` requires `factory.operate` and stays visible only while the exact dispatch generation is uncertain.
- `release_settled` requires `factory.release` and remains as a completion receipt for the succeeded dispatch generation.

The API returns operation or command IDs, current outcome details, and the exact approval context digest needed by the relevant decision route. It does not return sender tokens, archive coordinates, provider evidence, pinned material, or release request bodies. A generic decision calls `PUT /api/factories/projects/:projectId/runs/:runId/approvals/:approvalId` with one exact declared choice. Its store locks the live run before the approval, repeats the human and grant checks, and commits one stable `approval-decided` event to the existing interpreter inbox with the decision. An exact idempotent retry returns the same decision and does not enqueue another event.
