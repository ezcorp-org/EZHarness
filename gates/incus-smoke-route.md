# Incus guest smoke route gate

Scope: one real operator fixture lifecycle in the isolated EZHarness app, before SP01–SP08 qualification. This route does not mark a preset qualified.

- [x] An admin human session and same-origin JSON are required. Inputs name only the exact release, connection, preset, and `incus-smoke-*` operation ID. Unknown fields, guest commands, paths, images, generations, and credentials are rejected.
- [x] Create, start, stop, status, and destroy use `IncusQualificationFixtureService`. Each state-changing action has a fixed replay identity. The durable status action is available after an unknown response.
- [x] Guest inspection, a fixed marker file, and a fixed Compose one-shot run use `IncusHostLiveWitness`, which checks fixture ownership, release, connection, image, and guest RPC policy. The Compose image is supplied only by the host and must be an immutable digest reference.
- [x] Guest output is checked before a success receipt. A lost Compose response remains unknown; the fixed, bounded one-shot command can be run again. The route never returns raw credential material or unbounded guest logs.
- [x] 47 focused route and parity tests pass. Full typecheck, Biome, and production build pass. Focused route coverage is 92/92 lines and 9/9 functions.
- [ ] Run the route on the isolated app after a separately approved exact setup Apply. Record create, start, marker, Compose, stop, reconnect, and destroy receipts plus server inventory. This is not proof of the full feature workflow or SP01–SP08.
