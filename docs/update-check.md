# Update check

EZCorp polls GitHub Releases for a newer version of itself and, when one
exists, surfaces a small **bottom-left notification** ("Update available:
`<version>`") with a link to the release notes. The check is best-effort,
cached, and fully disable-able.

This document explains how the check works end-to-end and — critically —
**how to cut a release so the check actually fires** (see
[Releasing a new version](#releasing-a-new-version)). The two halves must
stay in sync: the running build reports its own version from
`package.json`, while the "is there something newer?" comparison reads
**published GitHub Releases**. Bump one without the other and the check
either goes quiet or nags forever.

## How it works

### The running version (what "current" means)

The version the running instance reports is read at runtime from the
`EZCORP_IMAGE_VERSION` environment variable, falling back to the literal
string `"dev"` when unset (`src/update-check.ts` → `currentVersion()`).

`EZCORP_IMAGE_VERSION` is **baked into the Docker image at build time**,
not set by hand at deploy time:

- `Dockerfile:106-109` — `ARG VERSION=dev` → `ENV EZCORP_IMAGE_VERSION=$VERSION`.
- `.github/workflows/release-image.yml` derives that build arg from the
  **root `package.json` `version` field**:
  `VERSION=$(jq -r .version package.json)` (the "Derive build args" step),
  then passes it as `--build-arg VERSION=…` to the image build.

So the single source of truth for the running version is **root
`package.json`** — whatever it says at the moment the `app-v*` tag is
built is what the image will report forever.

> Running locally (`bun dev`) the version is `"dev"`. `compareVersions`
> treats any real `N.N.N` release as *newer* than `"dev"`, so if you also
> point `EZCORP_UPDATE_REPO` at a repo with releases, the dev build will
> always show the notification. In practice local dev leaves
> `EZCORP_UPDATE_REPO` unset, which disables the check entirely (below).

### The latest version (the GitHub Releases poll)

`getUpdateCheck()` (`src/update-check.ts`) drives the check:

1. **Gate.** The check is *disabled* — returns
   `{ updateAvailable: false, latest: null, source: "disabled" }` — when
   either:
   - `EZCORP_CHECK_UPDATES` is `"false"`, or
   - `EZCORP_UPDATE_REPO` is unset.

   There is **no built-in default repo in code**; an unset
   `EZCORP_UPDATE_REPO` means "off". (The compose stack supplies a default
   value — see [Configuration](#configuration).)

2. **Cache.** Reads `.update-check.json` next to the database
   (`${EZCORP_DB_PATH}/.update-check.json`, or
   `${HOME}/ez-corp/.data/.update-check.json` for external Postgres /
   in-memory DB). If the cached entry is younger than **24 hours**
   (`CACHE_TTL_MS`), it is used as-is — GitHub is not contacted. This
   keeps us well under GitHub's unauthenticated rate limit regardless of
   how many clients hit `/api/version`.

3. **Fetch.** On a cache miss, calls
   `GET https://api.github.com/repos/<EZCORP_UPDATE_REPO>/releases/latest`
   with a 5-second timeout and a `User-Agent: ezcorp-update-check` header.
   It reads `tag_name` (the version) and `html_url` (the release-notes
   link). On any failure (network, non-2xx, timeout) it logs a warning and
   falls back to the cached value — the check never throws.

   > `releases/latest` returns the release GitHub marks **"Latest"** — the
   > newest published, non-draft, non-prerelease release. Drafts and
   > pre-releases are invisible to the check.

4. **Compare.** `compareVersions(latest, current)` extracts the first
   `N.N.N`-ish substring from each string, so any tag prefix (`v`,
   `app-v`, `bun-v`, …) and any suffix (`-rc.1`, `-beta`, `+build`) are
   ignored. `updateAvailable` is true only when `latest` is strictly
   greater. Example: tag `app-v1.4.0` vs running `1.3.0` → compares
   `1.4.0` > `1.3.0` → update available.

5. **Persist + return.** Writes the fresh result back to the cache and
   returns `UpdateCheckResult`:

   ```ts
   {
     current: string;        // EZCORP_IMAGE_VERSION or "dev"
     latest: string | null;  // release tag_name, e.g. "app-v1.4.0"
     updateAvailable: boolean;
     checkedAt: string | null;
     source: "github-releases" | "disabled";
     releaseUrl?: string;
   }
   ```

### Serving it to the UI

- **Endpoint:** `GET /api/version`
  (`web/src/routes/api/version/+server.ts`) is a thin wrapper around
  `getUpdateCheck()`.
- **Notification:** `web/src/lib/components/UpdateBanner.svelte` fetches
  `/api/version` on mount and renders a fixed **bottom-left** card when
  `updateAvailable` is true. The card animates in, links to the release
  notes, and has a dismiss (×).
- **Dismissal:** keyed by the `latest` version in `sessionStorage`
  (`UpdateBanner.helpers.ts`). Dismissing hides *that* version for the
  session; a newer release re-shows the card. Closing the tab clears the
  dismissal.

## Configuration

| Variable               | Default (compose)     | Effect                                                                                  |
|------------------------|-----------------------|-----------------------------------------------------------------------------------------|
| `EZCORP_CHECK_UPDATES` | `true`                | `false` disables the poll and the notification entirely.                                |
| `EZCORP_UPDATE_REPO`   | `ezcorp-org/EZcorp`   | `<owner>/<repo>` whose GitHub Releases are polled. Unset (in code) ⇒ check disabled.    |
| `EZCORP_IMAGE_VERSION` | `dev` (Dockerfile)    | The running version reported as `current`. Baked from `package.json` at image build.    |

The compose defaults live in `compose.prod.yml`
(`${EZCORP_UPDATE_REPO:-ezcorp-org/EZcorp}`,
`${EZCORP_CHECK_UPDATES:-true}`); override them in `.env.prod`. See the
env-var table in [`docs/production-guide.md`](production-guide.md).

> **Verify the repo slug.** `EZCORP_UPDATE_REPO` must point at the repo
> that actually publishes releases (`ezcorp-org/EZCorp`). GitHub treats
> owner/repo case-insensitively, but the value is otherwise taken
> literally — a wrong slug silently yields "no update" forever.

## Releasing a new version

Releasing is **automated and deterministic** — pushing an `app-v<version>`
git tag does the rest. Because `current` comes from `package.json` (baked
into the image) and `latest` comes from a published **GitHub Release**,
`.github/workflows/release-image.yml` ties both to that one tag:

1. **Bump `version` in the root `package.json`** and commit it. This is
   the value that becomes `EZCORP_IMAGE_VERSION` in the built image. Use
   the bare semver, e.g. `1.4.0`.

2. **Tag the commit `app-v<version>` and push the tag**, e.g.:

   ```sh
   git tag app-v1.4.0
   git push origin app-v1.4.0
   ```

That's it. The pushed `app-v*` tag triggers `release-image.yml`, which:

- **Verifies the tag matches `package.json`** ("Verify tag matches
  package.json version" step) — if `app-v1.4.0` is pushed but
  `package.json` still says `1.3.0`, the build **fails fast** before doing
  any work, so a mismatched `current`/`latest` can never ship.
- Runs the verification gates and **publishes the multi-arch image** to
  GHCR (`ghcr.io/ezcorp-org/ezcorp:<version>` + `:latest`) with the
  version baked in.
- **Publishes the GitHub Release** for the same tag, marked **"Latest"**,
  with auto-generated notes ("Publish GitHub Release" step, using
  `gh release create … --generate-notes --latest`). *This* is what the
  update check reads. The step is idempotent, so re-running the workflow
  for an existing tag just re-asserts "Latest" rather than failing.

The notification's "Release notes" link points at this auto-published
Release (`html_url`); edit the Release on GitHub afterward if you want to
expand the generated notes.

### Why it's wired this way

The single git tag is the source of truth for all three artifacts —
`package.json` `version`, the GHCR image tag, and the GitHub Release tag —
and CI enforces that they agree. The failure modes that used to be
possible when any step was manual:

| Mistake                                    | Now prevented by…                                                                            |
|--------------------------------------------|----------------------------------------------------------------------------------------------|
| Image built but no Release ⇒ nobody is notified | "Publish GitHub Release" step runs on every `app-v*` tag.                                |
| Release published but `package.json` not bumped ⇒ build reports stale version and nags | "Verify tag matches package.json version" step fails the build.        |
| `package.json` version ≠ tag ⇒ meaningless comparison | Same guard step — the tag *is* the version.                                       |

## Tests

- `src/__tests__/update-check.test.ts` — `compareVersions` edge cases,
  cache TTL, disabled gating, fetch-failure fallback, `"dev"` fallback.
- `web/src/__tests__/api-ready-version.test.ts` — the `/api/version`
  endpoint.
- `web/src/__tests__/update-banner-logic.test.ts` — show/dismiss logic.
- `web/src/lib/components/UpdateBanner.component.test.ts` — the
  bottom-left card render + dismiss behaviour.

The first three also run as a pre-publish gate inside
`release-image.yml` (the "Unit tests" / "Web unit tests" steps), so a
regression in the update path blocks the image build.
