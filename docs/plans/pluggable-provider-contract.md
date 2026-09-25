# Pluggable provider contract foundation

Status: C01 contract foundation.

This change adds declarations only. Runtime registration, live connections, transport authority, sensitive result delivery, and provider qualification remain disabled until their later host gates are complete.

The contract stays additive to manifest schema version 4. Provider protocol major 1 identifies the provider method contract. It is separate from host contract major 4.

## Declaration

An extension can add `providers` to its v4 manifest. An extension without this field has the same accepted shape and behavior as before. Each provider has a local ID. Its stable scoped identity is `<extension-name>/<provider-id>`; two providers in different extensions do not share an identity.

Every provider declares:

- kind, protocol major 1, and minimum supported host contract 4.0;
- one or more fixed profiles;
- a bounded configuration JSON Schema;
- a closed list of existing manifest permission axes that it requires;
- fixed method groups whose values reference methods in the same manifest; and
- optional capabilities as an explicit list.

Provider declarations cannot grant permissions. Each required permission must already exist in `manifest.permissions`. Host review and runtime authorization remain separate gates.

## Profiles and method groups

Sandbox providers can declare only `linux-exec.v1` in the MVP. `persistent-web-compose.v1` remains unsupported until a real runtime qualifies it. The profile requires these groups:

- `sandbox.lifecycle.v1`: create, inspect, start, stop, and destroy;
- `sandbox.process.v1`: start, inspect, read output, and cancel; and
- `sandbox.files.v1`: stat, list, read, write, mkdir, remove, and chmod.

Sandbox capabilities are an explicit empty list in the MVP. Preview, large transfer, snapshot, suspend, PTY, and resize declarations are rejected. A later release can add a capability only with its reviewed method group and qualification gates.

Static-secret providers declare only `static-secret.v1` and `secret.static.v1/resolve`. Dynamic leases are not selectable in this contract. They remain unavailable until a real issuer and a later contract revision are approved.

Every mapped method must exist once in `manifest.methods` and explicitly set `sensitivity` to `ordinary` or `sensitive`. Static-secret methods must be sensitive. A sensitive mapped method cannot also be a model tool. Classification is metadata for later host gates; it does not create a sealed result path or authorize execution.

## Limits of this foundation

This contract does not implement the C02 sandbox wire semantics or the C03 secret result semantics. Method input and output schemas remain provider-authored bounded value schemas until those tasks freeze their shared payload types.

Runtime discovery must ignore provider declarations until C04 registration and qualification are complete. Private transport, controller authority, connection storage, sensitive result handling, and live provider access remain absent. The existing `secretRead` permission still allows its documented raw native credential exposure. This change does not treat that legacy path as a sealed provider result.

Unsupported protocol majors, host contract versions, profiles, permission axes, duplicate identities, dangling mappings, duplicate mappings, and sensitive tool collisions fail manifest validation.
