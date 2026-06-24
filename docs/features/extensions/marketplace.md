# Marketplace

> _A public, mostly-open catalog of shareable **agent configs**: browse / search / filter by category & tag, install (which mints a private agent-config copy), thumbs-rate, flag-for-moderation, version, import/export manifests, and check for updates — backed by four `marketplace_*` tables and seeded with demo agents._

## Intent

The marketplace lets users publish their own agent configurations as versioned listings, discover other people's agents, and one-click "install" them into their own account. It exists to make EZCorp's agent ecosystem shareable without a full extension-package install: a listing carries an `ExtensionManifestV2` whose `agent` block is the unit of distribution, and **installing copies that agent definition into a new private `agentConfigs` row** — it does *not* run code or unpack an extension bundle. Community trust is handled with thumbs-up/down ratings and a user-flag → admin-moderation loop. The richer code-bearing extension install path (with the full package checksum gate) is a sibling subsystem; see Notes.

## How it works

### Data model (4 tables, `src/db/schema.ts`)

- `marketplace_listings` — one row per published agent. Carries `authorId`, nullable `agentConfigId` (the author's source config; `on delete set null`), `name`, `description`, unique `slug`, `category`, `tags` (jsonb string array), `latestVersion`, denormalized `installCount` / `ratingPositive` / `ratingTotal` / `flagCount`, `status` (`active` | `flagged` | `removed`), and `featured`.
- `marketplace_versions` — append-only version history; each row stores the full `manifest` (`ExtensionManifestV2` jsonb) + optional `changelog`. `on delete cascade` from the listing.
- `marketplace_ratings` — one thumbs-up/down per `(listingId, userId)`; upsert recomputes the listing's denormalized rating counts.
- `marketplace_flags` — abuse reports: `reason`, `category` (`spam`/`malicious`/`misleading`/`inappropriate`/`other`), `status` (`pending`/`dismissed`/`removed`), `reviewedBy`/`reviewedAt`.

### Publish (`POST /api/marketplace`)

1. `requireScope(locals,"extensions")` + `requireAuth`, then `publishListingSchema` parse (semver `version`, optional `changelog`/`tags`).
2. Load the author's `agentConfig`; ownership-gated — a config not owned by the caller returns **404** (never 403).
3. Build an `ExtensionManifestV2` from the config: `name` is **slugified** via `generateSlug(config.name)` (so `"Code Reviewer"` → `code-reviewer`, because the name is a filesystem dir name when installed), the agent block copies `prompt`/`category`/`capabilities` (+ optional `temperature`/`maxTokens`/`outputFormat`/`inputSchema`), `author` = caller. `validateManifestV2` gates it.
4. **Republish vs new:** if a listing already exists for this `agentConfigId` (found via `getListingsByAuthor`), the new `version` must be strictly higher than the latest (`compareVersions` ≤ 0 → 400), then `createVersion` appends. Otherwise `createListing` + first `createVersion`. Both write a `marketplace:publish` audit entry and return **201**.

### Browse / search (`GET /api/marketplace`, public)

- No auth — browse is intentionally open (`GET` has no `requireAuth`/`requireScope`).
- `browseMarketplace` (`src/db/queries/marketplace.ts`) filters to `status='active'`, optional `category` exact-match and `tag` (jsonb `@>` containment).
- **Search is a length-gated hybrid:** queries ≤ 2 chars short-circuit to plain sort (no search WHERE); queries ≥ 3 chars emit `word_similarity(...) > 0.4 OR to_tsvector @@ plainto_tsquery(...)` (typo-tolerant trigram recall OR English FTS stem recall), ordered `0.6 * word_similarity + 0.4 * ts_rank_cd`. Without a query, `sort` selects `popular` (installCount desc), `rating` (`positive*100/(total+1)` desc), or `newest` (createdAt desc).
- Each row is decorated with `ratingPercent = round(positive/total*100)`. On the first page (`offset===0`) the response also includes `featured` (top 6 by `featured` flag then installCount).

### Install (`POST /api/marketplace/[id]/install`)

1. `requireScope(locals,"extensions")` + `requireAuth`; 404 if the listing is missing/removed.
2. Optional `version` (must be non-empty when present) selects `getVersion`, else `getLatestVersion`; 404 if no version, 400 if the manifest has no `agent`.
3. `createAgentConfig` clones the manifest's agent into a **new private config owned by the caller**; on name collision the new name gets a ` (Marketplace)` suffix.
4. Provenance is recorded in a `settings` row keyed `marketplace:installed:<agentConfigId>` (`{ listingId, version, installedAt }`), then `incrementInstallCount` + a `marketplace:install` audit entry. Returns **201** `{ agentConfig, extensionsNeeded: [] }`.

`extensionsNeeded` is **always `[]`** here — marketplace install never pulls a code-bearing extension package; it only materializes the agent config.

### Rate & flag

- `POST /api/marketplace/[id]/rate` (scope `extensions`) — `{ thumbsUp: boolean }`; `upsertRating` writes/updates the per-user row and recomputes denormalized counts.
- `POST /api/marketplace/[id]/flag` (scope `extensions`) — `{ reason (required, non-empty), category? }`; unknown categories fall back to `other`. **Rate-limited to 5 flags per user per hour** (429). `createFlag` **auto-flags the listing** (`status='flagged'`) the moment *any* pending flag exists, hiding it from browse.

### Moderation (admin)

- `GET /api/marketplace/flags` — global queue of all `pending` flags, enriched with `{ id, name, slug }` of the listing.
- `GET /api/marketplace/[id]/flags` — flag history for one listing; `PATCH /api/marketplace/[id]/flags` — `{ flagId, action: "dismissed" | "removed" }`. `resolveFlag`: `removed` sets the listing `status='removed'`; `dismissed` restores it to `active` only if it's currently `flagged` **and no other pending flags remain**. Recomputes `flagCount`. Audit entry `marketplace:flag:<action>`.
- `DELETE /api/marketplace/[id]` (scope `admin`) — **soft remove** (`status='removed'`, listing stays in DB). Audit `marketplace:remove`.
- `DELETE /api/marketplace/[id]/delete` (scope `admin`) — **hard delete** (row gone, versions/ratings/flags cascade). Audit `marketplace:delete`.

### Versions, updates, import/export

- `GET /api/marketplace/[id]/versions` — full version list (auth + `read`).
- `GET /api/marketplace/updates?ids=<csv of agentConfigIds>` — for each installed config, reads its `marketplace:installed:*` provenance and reports `{ hasUpdate: listing.latestVersion !== installed.version, currentVersion, latestVersion, listingId }`. Drives "update available" badges.
- `GET /api/marketplace/export/[id]` — downloads the latest version's manifest as JSON (`Content-Disposition: attachment; filename="<slug>-v<version>.json"`), stamped with `exportedAt`.
- `POST /api/marketplace/import` — accepts a raw `ExtensionManifestV2` JSON, `validateManifestV2`, and if it has an `agent`, creates a private config (name-collision suffix ` (Imported)`) and records `marketplace:imported:<agentConfigId>` provenance. Returns 400 if the manifest has no agent component. This is the "Import Agent" button — a manifest-file install path that bypasses the catalog entirely.

### Demo seed (`src/db/seed-marketplace.ts`)

`bun src/db/seed-marketplace.ts` seeds 15 demo agents (Code Reviewer, SQL Query Builder, …) as listings+versions with randomized ratings and a few `featured`, plus 5 demo agent *teams*, a test project/conversation, seed memories, bundled extensions, and `.env.seed` credentials. It exists for UI verification, not production.

## Usage

### REST API

| Method & path | Scope / role | Purpose |
|---|---|---|
| `GET /api/marketplace` | **public** | Browse/search/filter; `?q=&category=&tag=&sort=popular\|rating\|newest&limit=&offset=` (limit clamped ≤ 50). First page also returns `featured`. |
| `POST /api/marketplace` | `extensions` | Publish/republish a listing from an owned `agentConfigId`. Republish requires a higher semver. 201. |
| `GET /api/marketplace/categories` | **public** | Tag taxonomy with live counts over active listings (`{ categories: [{ tag, count }] }`). |
| `GET /api/marketplace/[id]` | `read` | Listing detail + `latestVersion`, `versions`, caller `userRating`, `installed` flag. |
| `DELETE /api/marketplace/[id]` | `admin` | Soft-remove (`status='removed'`). |
| `DELETE /api/marketplace/[id]/delete` | `admin` | Hard-delete the row (cascades). |
| `POST /api/marketplace/[id]/install` | `extensions` | Install latest (or `{version}`) → new private agent config. 201. |
| `POST /api/marketplace/[id]/rate` | `extensions` | `{ thumbsUp }` upsert. |
| `POST /api/marketplace/[id]/flag` | `extensions` | `{ reason, category? }`; rate-limited 5/hr (429). Auto-flags listing. |
| `GET /api/marketplace/[id]/versions` | `read` | Version history. |
| `GET /api/marketplace/[id]/flags` | `admin` | Flag history for a listing. |
| `PATCH /api/marketplace/[id]/flags` | `admin` | Resolve a flag (`dismissed`/`removed`). |
| `GET /api/marketplace/flags` | `admin` | Global pending-flag queue. |
| `GET /api/marketplace/updates?ids=` | `extensions` | Update-availability for installed configs. |
| `GET /api/marketplace/export/[id]` | `extensions` | Download latest manifest JSON. |
| `POST /api/marketplace/import` | `extensions` | Import a manifest JSON → private agent config. 201. |

### UI entry points

- `/marketplace` (`web/src/routes/(app)/marketplace/+page.svelte`) — catalog: debounced search, sort `<select>`, `CategoryGrid` (canonical categories), a tag sidebar with live counts, featured carousel, paginated `MarketplaceCard` grid, and an "Import Agent" file picker that POSTs to `/api/marketplace/import` then navigates to the new agent.
- `/marketplace/[id]` (`web/src/routes/(app)/marketplace/[id]/+page.svelte`) — detail page rendering `MarketplaceDetail` with install / thumbs-rate (optimistic) / export buttons, a `FlagDialog` (shown only to authenticated non-author non-admins), and a `PublishDialog` for the author to push a new version.

### Client wrappers (`web/src/lib/api.ts`)

`browseMarketplace`, `fetchMarketplaceCategories`, `getMarketplaceListing`, `publishToMarketplace`, `installMarketplaceAgent`, `rateMarketplaceListing`, `exportManifest`, `importManifest`.

## Key files

- `web/src/routes/api/marketplace/+server.ts` — `GET` browse (public) + `POST` publish/republish.
- `web/src/routes/api/marketplace/schema.ts` — `publishListingSchema` (semver `version`, `changelog`, `tags`).
- `web/src/routes/api/marketplace/categories/+server.ts` — public tag-count taxonomy.
- `web/src/routes/api/marketplace/[id]/+server.ts` — `GET` detail + `DELETE` soft-remove (admin).
- `web/src/routes/api/marketplace/[id]/install/+server.ts` — install → private agent config + `marketplace:installed:*` provenance.
- `web/src/routes/api/marketplace/[id]/rate/+server.ts` — thumbs rating upsert.
- `web/src/routes/api/marketplace/[id]/flag/+server.ts` — user flag submission, 5/hr rate limit, auto-flag.
- `web/src/routes/api/marketplace/[id]/flags/+server.ts` — admin `GET` history + `PATCH` resolve.
- `web/src/routes/api/marketplace/[id]/versions/+server.ts` — version list.
- `web/src/routes/api/marketplace/[id]/delete/+server.ts` — admin hard-delete (cascades).
- `web/src/routes/api/marketplace/flags/+server.ts` — admin global pending-flag queue.
- `web/src/routes/api/marketplace/updates/+server.ts` — update-availability over installed configs.
- `web/src/routes/api/marketplace/export/[id]/+server.ts` — latest-manifest JSON download.
- `web/src/routes/api/marketplace/import/+server.ts` + `import/schema.ts` — manifest-JSON import → private agent config.
- `src/db/queries/marketplace.ts` — `createListing`/`browseMarketplace` (hybrid search) /`getListingById` (excludes removed) /`getFeaturedListings`/`getMarketplaceTagCounts`/`incrementInstallCount`/`updateListingStatus`/`deleteListing`.
- `src/db/queries/marketplace-versions.ts` — `createVersion` (also bumps `latestVersion`), `getVersion`, `getLatestVersion`, `listVersions`.
- `src/db/queries/marketplace-ratings.ts` — `upsertRating`, ratings/flags helpers (`createFlag` auto-flag, `resolveFlag`, `listFlags`, `countPendingFlagsByUser`).
- `src/db/queries/settings.ts` — `isListingInstalled` (LIKE over `marketplace:installed:%` settings rows).
- `src/db/schema.ts` — `marketplaceListings` / `marketplaceVersions` / `marketplaceRatings` / `marketplaceFlags`.
- `src/extensions/manifest.ts` — `validateManifestV2`, `generateSlug`, `compareVersions` (shared with publish/install/import).
- `src/db/seed-marketplace.ts` — demo seed (15 agents + 5 teams + project/memories).
- `web/src/routes/(app)/marketplace/+page.svelte` + `[id]/+page.svelte` — catalog + detail UI.
- `web/src/lib/components/MarketplaceCard.svelte`, `MarketplaceDetail.svelte`, `PublishDialog.svelte`, `FlagDialog.svelte`, `CategoryGrid.svelte` — UI components.
- `web/src/lib/api.ts` — marketplace client wrappers.

## Features it touches

- [[agents]] — the marketplace's unit of distribution is an agent config; publish reads an owned config, install/import write a new private one.
- [[teams]] — the demo seed also wires agent teams (`category:"team"`, `references.members`); marketplace listings themselves remain single-agent.
- [[overview-and-authoring]] — listings carry `ExtensionManifestV2`; publish/import share `validateManifestV2` + `generateSlug` with extension authoring.
- [[bundled-catalog]] — sibling distribution channel: bundled extensions are wired at boot and skip the integrity gate; marketplace agents are user-installed copies.
- [[permissions-and-grants]] — the *code-bearing* extension installer (separate from this catalog) enforces the package checksum / integrity gate that marketplace agent-config installs do not need.
- [[sandbox-and-isolation]] — relevant only to that extension-install path, not to marketplace agent configs (no code runs on install).
- [[settings-system]] — install/import provenance lives in `settings` rows (`marketplace:installed:*`, `marketplace:imported:*`).
- [[audit-and-observability]] — every publish/install/flag/remove/delete writes an audit-log entry.
- [[admin-surfaces]] — flag moderation + soft/hard removal are admin-only surfaces.
- [[rbac-and-permission-modes]] — routes are gated by `requireScope` (`extensions`/`read`/`admin`) + `requireRole("admin")`; browse is intentionally public.
- [[api-security]] — publish ownership failures collapse to 404 (no existence leak); flag submission is rate-limited.
- [[developer-api-keys]] — non-public routes accept scoped API keys via `requireScope`.

## Related docs

None yet — this is the primary reference. (See `docs/extensions/data-storage.md` for extension data-dir conventions and the extension-authoring docs for `ExtensionManifestV2`.)

## Notes & gotchas

- **It's an agent-config marketplace, not a code-package marketplace.** "Install" copies the manifest's `agent` block into a new private `agentConfigs` row — no extension process is created, no files are unpacked, `extensionsNeeded` is always `[]`. A listing whose manifest has no `agent` cannot be installed (400).
- **The "full checksum gate vs bundled" lives in the *other* install path.** The package-integrity checksum gate is enforced in `src/extensions/registry.ts#getProcess` for **user-installed code extensions** and is *skipped* for bundled ones (keyed off the DB `isBundled` flag, not a name match, so an attacker can't masquerade as `ai-kit` to skip the check). Marketplace agent-config installs don't touch that path at all — don't conflate the two when reading the grounding hint.
- **Browse is intentionally public.** `GET /api/marketplace` and `GET /api/marketplace/categories` have no auth — anyone can read the catalog. Listing *detail* (`GET /[id]`) requires the `read` scope.
- **`getListingById` hides removed listings.** It filters `status != 'removed'`, so a soft-removed listing 404s on detail/install/export even though the row still exists. Hard delete (`/[id]/delete`) actually drops the row.
- **One pending flag hides a listing.** `createFlag` flips `status` to `flagged` as soon as a single pending flag exists, removing it from `browse` (which requires `status='active'`) until an admin dismisses it. A dismissal only restores it if *no* other pending flags remain.
- **Republish is monotonic semver.** Republishing the same `agentConfigId` requires a strictly-higher version (`compareVersions(version, latest) <= 0` → 400); there's no "overwrite current version" path.
- **Manifest names are slugified.** Display name stays on the listing row, but `manifest.name` is `generateSlug(name)` because it doubles as a filesystem directory name (`data/extensions/<name>`) in the broader extension model. Two configs whose names slug-collide will produce listing slug collisions (the `slug` column is `unique`).
- **Provenance is settings rows, not a join table.** Install tracking is `settings` keys `marketplace:installed:<agentConfigId>` and import tracking is `marketplace:imported:<agentConfigId>`. `isListingInstalled` does a `LIKE 'marketplace:installed:%'` + jsonb `->>'listingId'` scan — there's no FK between an installed config and its source listing, and the `installed` flag on the detail response is **global, not per-user** (any install of that listing makes it read as installed).
- **Update detection is name-blind.** `/api/marketplace/updates` compares stored `installed.version` against `listing.latestVersion` by string inequality, not semver ordering — a re-published *equal-or-lower* version (which publish forbids) is the only way to get a false negative, but it never validates the installed config still matches the listing.
