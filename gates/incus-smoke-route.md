# Incus guest smoke route gate

Scope: one real operator fixture lifecycle in the isolated EZHarness app, before SP01–SP08 qualification. This route does not mark a preset qualified.

- [x] An admin human session and same-origin JSON are required. Inputs name only the exact release, connection, preset, and `incus-smoke-*` operation ID. Unknown fields, guest commands, paths, images, generations, and credentials are rejected.
- [x] Create, start, stop, status, and destroy use `IncusQualificationFixtureService`. Power identity includes the binding generation and predecessor operation ID. A repeated step returns its saved receipt, including an unknown outcome; stop → start creates a new operation. Opposite transitions wait for a settled prior effect. Durable status is available after an unknown response.
- [x] Guest inspection, a fixed marker file, and a fixed Compose one-shot run use `IncusHostLiveWitness`, which checks fixture ownership, release, connection, image, and guest RPC policy. The Compose image is supplied only by the host and must be an immutable digest reference.
- [x] Guest output is checked before a success receipt. A lost Compose response remains unknown; the fixed, bounded one-shot command can be run again. The route never returns raw credential material or unbounded guest logs.
- [x] Eight focused smoke tests and the same-timestamp fixture ordering test pass. Biome passes. Focused smoke route coverage is 109/109 lines and 11/11 functions. The earlier production build passed before this power-only edit.
- [ ] Final integrated typecheck/build pass on the committed head; the root run owns this check after parallel edits settle.
- [ ] Run the route on the isolated app after a separately approved exact setup Apply. Record create, start, marker, Compose, stop, reconnect, and destroy receipts plus server inventory. This is not proof of the full feature workflow or SP01–SP08.
