# Production factory pool process gates

- [x] G1: Strict private, reference-only config validates the PostgreSQL identity, TLS pair and CA, RSA verification keys, certificate identities, and explicit static resources before bind.
- [x] G2: Startup binds the installation and pool to the durable database, applies the additive pool schema, and rejects removed durable resources or GPU hosts.
- [x] G3: Readiness is atomic and accepts only a fresh exact ready identity; startup, runtime failure, clean stop, and close failure publish truthful lifecycle state.
- [x] G4: The existing Bun mTLS server and pool service run in a fresh subprocess against isolated PostgreSQL. Exact admission retry returns the durable token lease, bad tokens fail, and SIGTERM closes cleanly.
- [x] G5: Private launch and configuration requirements are documented without embedding credentials.
- [x] G6: The canonical pool coverage producer measures all pool sources at 100%, and builds, all four type checks, lint, boundaries, registration, and gate integrity pass.

Evidence so far: focused process and readiness tests pass 10 tests with 176 assertions. The isolated PostgreSQL subprocess suite passes two tests with 16 assertions. Root and web frozen installs complete with Bun 1.3.14; factory SDK and transport builds, all four type-check legs, lint, factory boundaries, factory CI registration, required-check tests, and gate integrity pass. The canonical pool producer passes 65 tests with 430 assertions and measures all ten pool source files at 100% line coverage in `/tmp/factory-pool-process-final/lcov.info`.
