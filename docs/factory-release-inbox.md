# Factory release inbox

Factory approval and release notifications use the durable `factory_notifications` queue. The queue row is the outbox record and the in-app inbox record. `FactoryNotificationDelivery.deliverNext(projectId)` changes one queued row to `delivered` in one database transaction. It does not call email, chat, webhook, or another notification service.

The application must call `releaseOperations.notifications.deliverNext(projectId)` from its bounded delivery worker. A restart can call it again. The queue deduplication identity and the atomic delivered transition keep one visible item.

Interactive users read `GET /api/factories/projects/:projectId/release/notifications?limit=50&cursor=...`. The store checks the live project membership and grant in the same transaction as the bounded query:

- `approval_requested` requires `factory.approve` and stays visible only while the exact approval is pending, unexpired, and attached to a pending release operation.
- `release_uncertain` requires `factory.operate` and stays visible only while the exact dispatch generation is uncertain.
- `release_settled` requires `factory.release` and remains as a completion receipt for the succeeded dispatch generation.

The API returns operation IDs, current outcome details, and the exact approval context digest needed by the existing approval decision route. It does not return sender tokens, archive coordinates, provider evidence, pinned material, or release request bodies. Approval buttons call the existing assurance decision store. That store repeats the current human and grant checks before it records a decision.
