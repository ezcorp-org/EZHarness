# Infisical static-secret provider

This v4 extension resolves a bounded list of approved credential names from one pinned Infisical project, environment, and secret path. The classified `provider/credentials.resolve` lane is its only credential interface. It does not publish model tools or ordinary methods.

The connection configuration contains only an exact HTTPS endpoint, scope identifiers, a host-owned machine-identity auth reference, and explicit credential-to-secret mappings. It rejects client IDs, client secrets, access tokens, arbitrary request paths, duplicate mappings, and undeclared consumer extensions.

The provider reports the Infisical access-token expiry from Universal Auth. The host owns broker-handle lifetime. Infisical's static-secret response does not provide issuer expiry, so this provider reports that validity as unknown. It does not implement or claim dynamic secret leases.

The package uses an injected HTTP transport. The production entrypoint targets the reserved host route `/api/secret-providers/infisical/transport`; host H04 must implement that route, resolve the auth reference, enforce the approved endpoint and TLS policy, and keep bootstrap material out of extension configuration. Until that work and a non-production machine-identity qualification pass, this adapter has offline test coverage only. It does not replace or change the built-in encrypted credential store.
