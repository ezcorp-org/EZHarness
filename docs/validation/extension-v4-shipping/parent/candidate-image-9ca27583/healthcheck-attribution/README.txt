Native rootless Podman stores the image config blob with the Dockerfile Healthcheck intact. Its SHA-256 equals the image ID. `podman image inspect` omits that field, so that image-inspect result is a serializer/view limitation, not a failed Docker-to-Podman transfer.

The current local R4 launcher generated a minimal compose service without a healthcheck field. Its live container has no configured or active healthcheck. This is a harness-specific launch condition. It does not invalidate R4 lifecycle/resource predicates, which used explicit HTTP readiness checks rather than container health state.

Supported production compose (`compose.prod.yml:199-206`) declares its own app healthcheck. README production startup uses that compose file. This audit does not prove the production compose healthcheck under rootless Podman; the documented Podman wrapper targets the development stack.
