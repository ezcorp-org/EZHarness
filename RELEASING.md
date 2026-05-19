# Releasing EZCorp

End-to-end guide for cutting a new versioned release of the EZCorp application (separate from the SDK, which follows its own `sdk-v*` tag convention).

---

## TL;DR

```bash
# 1. Verify everything works
bun run verify:all

# 2. Bump the version
# edit package.json "version" → e.g. "0.1.0"
git commit -am "chore(release): app v0.1.0"

# 3. Tag and push
git tag app-v0.1.0
git push origin main
git push origin app-v0.1.0

# 4. Publish release notes on GitHub:
#    https://github.com/ezcorp-org/EZcorp/releases/new?tag=app-v0.1.0
```

CI takes it from there (gates → multi-arch build → GHCR push). The in-app update banner on every existing instance will surface the new version within 24 hours.

---

## 1. Pre-release verification

Run the full gate locally before tagging. This catches regressions that would otherwise fail CI mid-build:

```bash
bun run verify:all
```

This chains:

| Step                         | Coverage                                                                                       |
|------------------------------|------------------------------------------------------------------------------------------------|
| `verify:backup`              | Snapshot → simulated migrate failure → rollback restores data → recovery works (real PGlite).  |
| `verify:edges`               | Stale marker, unset SHA, no-snapshot-available, pruning-to-3, malformed marker.                |
| `verify:docker`              | Builds image, checks OCI labels + VOLUME + env vars, asserts `/api/ready` 200, persistence.    |
| `verify:docker-rollback`     | Marker-driven circuit breaker, degraded-mode readiness, `docker exec` recovery.                |

All four must be green before tagging. Each exits non-zero on any failure.

## 2. Version bump

Root `package.json` drives the image version via the `VERSION` build-arg:

```diff
-  "version": "0.1.0",
+  "version": "0.2.0",
```

Follow semver:

- **Major** (`x.0.0`) — breaking migration (e.g. schema change that is NOT idempotent DDL). Document the manual upgrade step in the release notes.
- **Minor** (`0.x.0`) — new features, additive DB changes, new env vars with safe defaults.
- **Patch** (`0.0.x`) — bug fixes, doc changes, dependency bumps.

Commit the bump on `main`:

```bash
git commit -am "chore(release): app v0.2.0"
```

## 3. Tag and push

```bash
git tag app-v0.2.0
git push origin main
git push origin app-v0.2.0
```

The `app-v*` prefix (not `v*`) avoids collision with `sdk-v*` (the SDK's tag convention). The CI workflow at [`.github/workflows/release-image.yml`](.github/workflows/release-image.yml) triggers only on `app-v*`.

## 4. What CI does on a tag push

1. Checkout + bun install (root + web).
2. Run the four `verify:*` gates — identical to local pre-release check.
3. Build the image locally with build-args `VERSION`, `REVISION=${sha}`, `CREATED=${iso}`.
4. Run `verify:docker --no-build` and `verify:docker-rollback` against that exact image.
5. Multi-arch build + push to `ghcr.io/ezcorp-org/ezcorp` with tags:
   - `latest`
   - `0.2.0`, `0.2`, `0` (semver)
   - `sha-<short>`

Failure at any gate aborts the publish. No broken image can reach GHCR.

## 5. Post-release

### Publish release notes

Go to <https://github.com/ezcorp-org/EZcorp/releases/new?tag=app-v0.2.0>. The UpdateBanner's "Release notes" link points users here, so this is the only place the content shows up in the product.

Template:

```markdown
## Highlights
- Short bullet list of user-visible changes

## Breaking changes
- Any manual steps required (env var rename, migration, etc.) — or "None."

## Upgrade
```bash
docker compose -f compose.prod.yml pull && docker compose -f compose.prod.yml up -d
```
The safe boot sequence snapshots the DB before migrating. If the migration fails, the container auto-recovers and `/api/ready` reports `migration-blocked`.
```

### Verify the published image

```bash
docker pull ghcr.io/ezcorp-org/ezcorp:0.2.0
docker run --rm ghcr.io/ezcorp-org/ezcorp:0.2.0 bun --version
```

Confirm the OCI labels reflect the tag:

```bash
docker inspect ghcr.io/ezcorp-org/ezcorp:0.2.0 \
  --format '{{index .Config.Labels "org.opencontainers.image.version"}}'
# → 0.2.0
```

### Update banner propagation

Instances with `EZCORP_CHECK_UPDATES=true` (default) poll GitHub Releases once per 24 hours. The banner will appear on users' next page load after their cache expires. Nothing else to do — Watchtower users get auto-updated within the same window.

---

## Rolling back a bad release

1. **If the image is broken but CI somehow let it through** — delete or re-tag the bad GHCR tag, push a patch version immediately. `:latest` will move to the patch on next CI run.
2. **If the migration is broken** — every instance that upgraded is self-protecting: the safe boot sequence restored from snapshot and wrote `/app/data/.migration-failed`. Users will see `/api/ready` return 503 with `reason: "migration-blocked"` and the UI still works. Recovery options are in [production-guide.md §2](docs/production-guide.md#recovering-from-a-failed-migration).
3. **If users need to pin** — tell them to change `compose.prod.yml`:
   ```yaml
   image: ghcr.io/ezcorp-org/ezcorp:0.1.0  # or any known-good prior tag
   ```

---

## Pre-release (RC) builds

For testing a potentially-risky change:

```bash
git tag app-v0.2.0-rc.1
git push origin app-v0.2.0-rc.1
```

Published as `ghcr.io/ezcorp-org/ezcorp:0.2.0-rc.1`. CI does NOT move `:latest` to an RC tag (the metadata-action's `semver` pattern only matches stable semver), so existing `latest`-following deployments are unaffected. Testers can pin explicitly.

---

## Don't

- **Don't** force-push to `main` after a tag. The tag's SHA is baked into the image as `EZCORP_IMAGE_SHA` and drives the circuit-breaker marker key — if the SHA "moves" underneath users, the breaker can misfire.
- **Don't** delete a published GHCR tag that users may have pinned. Cut a new patch instead.
- **Don't** skip `verify:all` locally even if CI is green. The in-process gates are 5 seconds; the Docker gates are ~2 minutes. Both catch different things (e.g. package-resolution issues only surface in Docker).
