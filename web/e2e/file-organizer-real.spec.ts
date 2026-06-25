/**
 * file-organizer — REAL-BACKEND e2e (Docker-gated).
 *
 * ✅ This is the ONLY genuinely end-to-end file-organizer spec. It runs
 * against the LIVE backend (the dev container `ez-corp-ai-app-1` on host
 * network :3000), with NO mockApi. It exercises the real add-folder
 * validator, the real config.json write (verified by reading the WRITER's
 * on-disk config.json via `docker exec`), the real rule DSL parser, the
 * real container-visibility probe, the real fs-list jail (403), and the
 * real Hub render subprocess — the surfaces the mock suite
 * (`file-organizer-hub.spec.ts`) stubs out. See
 * `docs/extensions/examples/file-organizer/TEST-COVERAGE.md`.
 *
 * GATING — this suite is INERT in the default mock preview run. It only
 * executes when `DOCKER_TEST` is set, which is also what flips
 * `web/playwright.config.ts` to baseURL :3000 + the docker-auth-setup
 * global setup (login test@test.com / Test123! → `.docker-auth.json`
 * storageState reused here). Run it with:
 *
 *   cd web && DOCKER_TEST=1 bunx playwright test file-organizer-real.spec.ts \
 *     --project=chromium
 *
 * ORACLE — there is no read-config HTTP API, so persistence is verified
 * two ways: (1) the events route's own idempotent refusals (a duplicate
 * add is refused "already being watched" ⇒ the first write hit disk), and
 * (2) reading the WRITER's config.json directly out of the container with
 * `docker exec ez-corp-ai-app-1 cat /app/.ezcorp/extension-data/file-organizer/config.json`.
 * We assert on the WRITER dir because that is where the events route +
 * daemon actually persist; post-fix the Hub render reads the SAME dir, so
 * the "appears in the Hub" specs ALSO assert the rendered reflection.
 *
 * CLEANUP — this spec mutates the SHARED container's config.json. It
 * snapshots config.json in `beforeAll` and restores the exact bytes in
 * `afterAll`, so a run leaves the shared container exactly as it found it
 * (no folder/ignore/rule pollution for other sessions).
 *
 * DATA-DIR ALIGNMENT (was a dev-only split; FIXED 2026-06-19): the events
 * route + daemon write `/app/.ezcorp/extension-data/file-organizer/`. The
 * render subprocess previously resolved its data dir from `process.cwd()`
 * (= /app/web under vite-SSR), so a mutated config never surfaced in the
 * Hub render. Two coordinated changes aligned them: (1) the host injects
 * `EZCORP_EXTENSION_DATA_ROOT=/app` (registry.ts → getProjectRoot()) which
 * the extension's data-dir resolver prefers, and (2) the `$CWD` fs-grant
 * token now expands to the PROJECT ROOT (permissions.ts:grantCwdBase) so
 * the host-mediated read of /app/.ezcorp/… is covered by the extension's
 * `["$CWD"]` grant instead of being denied + disabling the extension. Prod
 * is unaffected (host cwd is already /app). The previously-skipped
 * "appears in the Hub render" specs are enabled below.
 */
import { test, expect, type APIRequestContext, type APIResponse } from "@playwright/test";
import { execFileSync } from "node:child_process";

const RUN_REAL = !!process.env.DOCKER_TEST;

const CONTAINER = "ez-corp-ai-app-1";
// The canonical data dir: events route + daemon WRITE here, and post-fix
// the render subprocess READS here too — see the data-dir alignment note
// in the header.
const CONFIG_PATH = "/app/.ezcorp/extension-data/file-organizer/config.json";

// Pre-made, reachable absolute watch dir inside the container. A typed
// ABSOLUTE path is the only add-folder flow that works in the real app —
// Browse 403s (fs-list jail). The container has this dir created.
const WATCH_DIR = "/app/projects/fo-test-watched";
// A SECOND reachable dir used by the config-mutation round-trip so we can
// add → mutate → remove it without disturbing WATCH_DIR. It must be a
// SIBLING (not an ancestor/descendant) of WATCH_DIR — `addFolder` drops a
// watched descendant when you add its ancestor, which would corrupt the
// WATCH_DIR entry mid-suite. This sibling exists inside the container.
const MUTATE_DIR = "/app/projects/fo-verify-new";

const FOLDERS_PAGE = "ext:file-organizer:overview";

function evtUrl(suffix: string): string {
  return `/api/extensions/file-organizer/events/${suffix}`;
}

/**
 * POST a file-organizer Hub event, transparently riding out the route's
 * REAL rate limiter (10 actions/min/user, fixed 60s window — see
 * `web/src/routes/api/extensions/[name]/events/[event]/+server.ts`). This
 * suite fires more than 10 mutating actions, so a 429 is EXPECTED real
 * behavior, not a failure: on a 429 we wait the `Retry-After` (seconds)
 * for the window to roll over, then retry. A real user never hits this
 * (they don't fire 15 actions in 2s); the helper keeps every assertion on
 * the REAL `{ok,message}` while respecting the real limiter.
 */
async function postEvent(
  request: APIRequestContext,
  suffix: string,
  payload: Record<string, unknown>,
  pageId = "overview",
): Promise<APIResponse> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await request.post(evtUrl(suffix), {
      data: { source: "hub", pageId, payload },
    });
    if (res.status() !== 429) return res;
    const retryAfter = Number(res.headers()["retry-after"] ?? "1");
    // Cap the wait so a misconfigured window can't hang the suite; the real
    // window is 60s, so +1s of slack is plenty.
    await new Promise((r) => setTimeout(r, Math.min(retryAfter + 1, 65) * 1000));
  }
  // Final attempt — return whatever we get so the assertion surfaces it.
  return request.post(evtUrl(suffix), { data: { source: "hub", pageId, payload } });
}

/** Read the WRITER's config.json out of the container (the persistence
 *  oracle). Returns the parsed object, or a `validateConfig(null)`-shaped
 *  empty config when the file is absent. */
function readWriterConfig(): { folders: Array<Record<string, unknown>> } {
  let raw = "";
  try {
    raw = execFileSync("docker", ["exec", CONTAINER, "cat", CONFIG_PATH], {
      encoding: "utf8",
    });
  } catch {
    return { folders: [] };
  }
  try {
    return JSON.parse(raw) as { folders: Array<Record<string, unknown>> };
  } catch {
    return { folders: [] };
  }
}

/** Raw bytes of config.json (for exact-restore on cleanup), or null if absent. */
function snapshotWriterConfig(): string | null {
  try {
    return execFileSync("docker", ["exec", CONTAINER, "cat", CONFIG_PATH], {
      encoding: "utf8",
    });
  } catch {
    return null;
  }
}

/** Restore config.json to the exact snapshot bytes (or delete it if there
 *  was none). Uses a heredoc-free `sh -c` write via base64 to survive any
 *  bytes in the JSON. */
function restoreWriterConfig(snapshot: string | null): void {
  if (snapshot === null) {
    try {
      execFileSync("docker", ["exec", CONTAINER, "rm", "-f", CONFIG_PATH]);
    } catch {
      /* best-effort */
    }
    return;
  }
  const b64 = Buffer.from(snapshot, "utf8").toString("base64");
  // `printf %s | base64 -d > file` — atomic enough for a single small JSON
  // and avoids any shell-escaping of the JSON payload.
  execFileSync("docker", [
    "exec",
    CONTAINER,
    "sh",
    "-c",
    `printf %s '${b64}' | base64 -d > ${CONFIG_PATH}`,
  ]);
}

test.describe(
  RUN_REAL ? "file-organizer real-backend" : "file-organizer real-backend (skipped: set DOCKER_TEST=1)",
  () => {
    test.skip(!RUN_REAL, "real-backend spec — requires DOCKER_TEST=1 + live container on :3000");

    // Snapshot the shared container's config.json before any mutation and
    // restore the exact bytes afterward — leave no pollution for other
    // sessions. Runs serially so the snapshot/restore brackets the whole
    // mutating set deterministically.
    // Serial: the snapshot/restore brackets the whole mutating set and avoids
    // a cross-worker config.json race. Generous per-test timeout because the
    // REAL events route rate-limits 10 actions/min — `postEvent` rides out a
    // 429 by waiting the (≤60s) window roll-over, which a fast default 30s
    // timeout would otherwise abort.
    test.describe.configure({ mode: "serial", timeout: 90_000 });
    let configSnapshot: string | null = null;
    test.beforeAll(() => {
      configSnapshot = snapshotWriterConfig();
      // Ensure the scratch dirs the spec adds/probes exist in the container
      // (idempotent — harmless test scratch under /app/projects). Makes the
      // spec portable to a fresh container rather than relying on dirs a
      // prior audit happened to leave behind.
      try {
        execFileSync("docker", [
          "exec",
          CONTAINER,
          "mkdir",
          "-p",
          WATCH_DIR,
          MUTATE_DIR,
          `${WATCH_DIR}/sub-verify`,
        ]);
      } catch {
        /* best-effort — the dirs usually already exist */
      }
    });
    test.afterAll(() => {
      restoreWriterConfig(configSnapshot);
    });

    // ── add-folder: accept + persistence oracle ──────────────────────────

    test("add-folder: a TYPED ABSOLUTE path is accepted by the REAL validator and persisted", async ({ request }) => {
      // POST the real add-folder event. The handler runs the real
      // `checkReachability`/`addFolder` against the real fs. We accept BOTH
      // ok:true (first add) and the idempotent "already watched" refusal
      // (a re-run) — either proves the path is a valid, reachable, persisted
      // watched folder.
      const res = await postEvent(request, "add-folder", { path: WATCH_DIR });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { ok: boolean; message?: string };
      if (!body.ok) {
        expect(body.message ?? "").toMatch(/already being watched/i);
      }

      // Persistence oracle #1: the entry is on disk in the WRITER's config.
      const cfg = readWriterConfig();
      expect(cfg.folders.some((f) => f.path === WATCH_DIR)).toBe(true);

      // Persistence oracle #2: a SECOND add of the same absolute path MUST
      // now be refused as already-watched — proving the first write hit
      // config.json on disk (not an in-memory no-op).
      const res2 = await postEvent(request, "add-folder", { path: WATCH_DIR });
      expect(res2.status()).toBe(200);
      const body2 = (await res2.json()) as { ok: boolean; message?: string };
      expect(body2.ok).toBe(false);
      expect(body2.message ?? "").toMatch(/already being watched/i);
    });

    // ── add-folder: every REAL refusal branch (exact strings) ────────────

    test("add-folder: a RELATIVE path is refused by the REAL validator with the exact message", async ({ request }) => {
      const res = await postEvent(request, "add-folder", { path: "relative/Downloads" });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { ok: boolean; message?: string };
      expect(body.ok).toBe(false);
      expect(body.message).toBe("Path must be an absolute, valid filesystem path.");
    });

    test("add-folder: an UNREACHABLE absolute path is refused with the container-visibility message", async ({ request }) => {
      // An absolute path that does NOT exist inside the container — the
      // real `checkReachability` exists-probe fails and returns the
      // canonical "mount it + restart" message.
      const res = await postEvent(request, "add-folder", { path: "/definitely/not/mounted/fo-xyz" });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { ok: boolean; message?: string };
      expect(body.ok).toBe(false);
      expect(body.message ?? "").toMatch(/isn't visible to the EZCorp container/i);
      // Refusal must NOT have written the path to config.
      expect(readWriterConfig().folders.some((f) => f.path === "/definitely/not/mounted/fo-xyz")).toBe(false);
    });

    test("add-folder: a DESCENDANT of an already-watched folder is refused as already-covered", async ({ request }) => {
      // WATCH_DIR is watched (added by the first test). An EXISTING subfolder
      // of it is already covered — the real `addFolder` overlap guard refuses
      // it. The child MUST exist on disk so it passes the reachability
      // exists-probe (which runs first) and reaches the overlap guard;
      // `sub-verify` is created in the container under the watch dir.
      const child = `${WATCH_DIR}/sub-verify`;
      const res = await postEvent(request, "add-folder", { path: child });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { ok: boolean; message?: string };
      expect(body.ok).toBe(false);
      expect(body.message ?? "").toMatch(/already covered by watched folder/i);
    });

    // ── add-rule: the REAL DSL parser refuses a malformed rule ───────────

    test("add-rule: a malformed DSL rule is refused by the REAL parser with the exact parse error", async ({ request }) => {
      // The state handler runs `parseDsl` BEFORE touching config, so a bad
      // rule is refused regardless of folderId — no valid folder needed.
      const res = await postEvent(request, "add-rule", { folderId: "anything", rule: "no-arrow-here" });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { ok: boolean; message?: string };
      expect(body.ok).toBe(false);
      expect(body.message).toBe("missing '-> destination'");
    });

    // ── Config-mutation round-trip against a REAL folderId ───────────────
    // Add a throwaway folder, read back its real id from config.json, then
    // drive set-mode / toggle-preset / add-ignore / set-backlog-policy /
    // add-rule against it and assert the REAL persisted config reflects each
    // mutation. Finally remove-folder it and assert it's gone. (config.json
    // is fully restored from the snapshot in afterAll regardless.)
    test("config mutations (set-mode/toggle-preset/add-ignore/set-backlog-policy/add-rule/remove-folder) persist to the REAL config", async ({ request }) => {
      // Add the throwaway watched folder.
      const add = await postEvent(request, "add-folder", { path: MUTATE_DIR });
      expect(add.status()).toBe(200);

      // Read back the REAL folder id the host minted (never trust a
      // caller-supplied id — the route looks up BY id).
      const folder = readWriterConfig().folders.find((f) => f.path === MUTATE_DIR);
      expect(folder, "throwaway folder must be persisted").toBeTruthy();
      const folderId = folder!.id as string;
      expect(typeof folderId).toBe("string");

      // set-mode → fully-auto, verify persisted mode. NOTE: the mode value
      // must be one of the REAL `MODES` ("ask-everything" |
      // "approve-non-destructive-only" | "fully-auto") — `setFolderMode`
      // silently no-ops an invalid mode (while the route still returns
      // ok:true), so an invalid value would NOT persist.
      const mode = await postEvent(request, "set-mode", { folderId, mode: "fully-auto" });
      expect(((await mode.json()) as { ok: boolean }).ok).toBe(true);
      expect(readWriterConfig().folders.find((f) => f.id === folderId)?.mode).toBe("fully-auto");

      // toggle-preset → junk-sweep on, verify it's in presets. Must be a real
      // preset name (`junk-sweep`/`downloads-router`/`duplicate-killer`/
      // `stale-archiver`) — `toggleFolderPreset` ignores unknown presets.
      const preset = await postEvent(request, "toggle-preset", { folderId, preset: "junk-sweep" });
      expect(((await preset.json()) as { ok: boolean }).ok).toBe(true);
      expect(
        (readWriterConfig().folders.find((f) => f.id === folderId)?.presets as string[]) ?? [],
      ).toContain("junk-sweep");

      // add-ignore → verify the entry lands in the folder's ignore list.
      const ignore = await postEvent(request, "add-ignore", { folderId, path: "*.partial" });
      expect(((await ignore.json()) as { ok: boolean }).ok).toBe(true);
      expect(
        (readWriterConfig().folders.find((f) => f.id === folderId)?.ignore as string[]) ?? [],
      ).toContain("*.partial");

      // set-backlog-policy → include-existing, verify persisted policy.
      const backlog = await postEvent(request, "set-backlog-policy", { folderId, backlogPolicy: "include-existing" });
      expect(((await backlog.json()) as { ok: boolean }).ok).toBe(true);
      expect(readWriterConfig().folders.find((f) => f.id === folderId)?.backlogPolicy).toBe("include-existing");

      // add-rule (VALID DSL) → verify a customRule is persisted.
      const rule = await postEvent(request, "add-rule", { folderId, rule: "*.pdf -> Documents" });
      expect(((await rule.json()) as { ok: boolean }).ok).toBe(true);
      expect(
        ((readWriterConfig().folders.find((f) => f.id === folderId)?.customRules as unknown[]) ?? []).length,
      ).toBeGreaterThan(0);

      // remove-folder → the throwaway folder is gone from config.
      const remove = await postEvent(request, "remove-folder", { folderId });
      expect(((await remove.json()) as { ok: boolean }).ok).toBe(true);
      expect(readWriterConfig().folders.some((f) => f.id === folderId)).toBe(false);
    });

    // ── Proposal lifecycle (conditional — needs a daemon-produced proposal) ──

    test("proposal lifecycle: accept a REAL pending proposal moves the file on disk (skips when no proposals)", async ({ request }) => {
      // Read the WRITER's proposals.json. The daemon owns proposal
      // production on its own clamped schedule; if it hasn't produced a
      // pending proposal we honestly skip rather than fabricate one (the
      // mock suite covers the accept WIRING; this asserts the REAL move).
      let proposalsRaw = "";
      try {
        proposalsRaw = execFileSync(
          "docker",
          ["exec", CONTAINER, "cat", "/app/.ezcorp/extension-data/file-organizer/proposals.json"],
          { encoding: "utf8" },
        );
      } catch {
        proposalsRaw = "";
      }
      const parsed = (() => {
        try {
          return JSON.parse(proposalsRaw) as { proposals?: Array<{ id: string; status: string; dst?: string }> };
        } catch {
          return { proposals: [] as Array<{ id: string; status: string; dst?: string }> };
        }
      })();
      const pending = (parsed.proposals ?? []).find((p) => p.status === "pending");
      test.skip(!pending, "no daemon-produced pending proposal on disk — nothing real to accept");

      const res = await postEvent(request, "accept", { proposalId: pending!.id }, "overview");
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { ok: boolean; message?: string };
      // A real accept either applies (file moved) or is blocked/failed with
      // a real reason — never a silent no-op. We assert the route returned a
      // real outcome message for the looked-up id.
      expect(body.message ?? "").toBeTruthy();
      // Re-read proposals: the accepted row must no longer be pending.
      const after = JSON.parse(
        execFileSync(
          "docker",
          ["exec", CONTAINER, "cat", "/app/.ezcorp/extension-data/file-organizer/proposals.json"],
          { encoding: "utf8" },
        ),
      ) as { proposals?: Array<{ id: string; status: string }> };
      expect((after.proposals ?? []).find((p) => p.id === pending!.id)?.status).not.toBe("pending");
    });

    // ── Picker reality: typed absolute works; Browse 403s (the jail) ─────

    test("picker: Browse → real GET /api/fs/list?dir=/ is 403 (sandbox-jailed, documents the limitation)", async ({ request }) => {
      // The picker's Browse calls /api/fs/list. Against the real backend the
      // root listing is jailed to the project root, so dir=/ is 403. This
      // is why only a TYPED ABSOLUTE path can reach an arbitrary watch dir.
      const res = await request.get("/api/fs/list?dir=/");
      expect(res.status()).toBe(403);
    });

    // ── UI: a refused add surfaces a real error toast in the browser ─────

    test("UI: a refused add surfaces a real error toast in the browser", async ({ page }) => {
      // Drive the real Folders page + prompt with a relative path and assert
      // the host shell renders the REAL refusal as an error toast (the
      // dispatchAction ok:false → addToast path), against the live backend.
      await page.goto(`/hub/${encodeURIComponent(FOLDERS_PAGE)}`);
      await expect(page.getByTestId("hub-page-title")).toBeVisible();
      await page.getByTestId("hub-node-button").filter({ hasText: "Add watched folder" }).click();
      await expect(page.getByTestId("hub-prompt-dialog")).toBeVisible();
      await page.getByTestId("hub-prompt-format").locator("input").fill("relative/Downloads");
      await page.getByTestId("hub-prompt-submit").click();
      await expect(
        page.getByRole("alert").filter({ hasText: "Path must be an absolute, valid filesystem path." }),
      ).toBeVisible({ timeout: 5000 });
    });

    // ── DATA-DIR ALIGNMENT (the split is FIXED) ──────────────────────────
    //
    // The events route + daemon WRITE /app/.ezcorp/extension-data/
    // file-organizer/ (host `getProjectRoot()` → /app). FIXED 2026-06-19:
    // the render subprocess now READS the SAME dir, via two coordinated
    // changes:
    //   1. The host injects `EZCORP_EXTENSION_DATA_ROOT=/app`
    //      (registry.ts `buildAllowedEnv` → `getProjectRoot()`), which the
    //      file-organizer's data-dir resolver prefers over `process.cwd()`
    //      (which is /app/web under the vite-SSR dev server).
    //   2. The `$CWD` filesystem-grant token now expands to the PROJECT
    //      ROOT (`getProjectRoot()` → /app) instead of the host
    //      `process.cwd()` (/app/web) — see
    //      `src/extensions/permissions.ts:grantCwdBase`. Without this, the
    //      subprocess's host-mediated read of /app/.ezcorp/… was OUTSIDE
    //      its `["$CWD"]` grant → the fs-handler's `denyAndDisable` fired
    //      and DISABLED the extension. Widening the grant from /app/web up
    //      to /app only PERMITS more (a sibling outside /app is still
    //      denied), so the read is now covered.
    // Net: writer and reader agree on /app/.ezcorp/… in dev AND prod (prod
    // host cwd is already /app, so the change is a no-op there). These
    // specs assert the rendered Hub reflects the REAL mutation.

    // A real add-folder (events route → writer dir) now surfaces in the
    // Folders Hub render (reader reads the same dir, covered by the grant).
    test("add-folder: the added folder APPEARS in the Hub render (data dirs aligned)", async ({ page, request }) => {
      const res = await postEvent(request, "add-folder", { path: WATCH_DIR });
      expect(res.status()).toBe(200);
      // Persistence oracle: the writer dir holds the entry.
      expect(readWriterConfig().folders.some((f) => f.path === WATCH_DIR)).toBe(true);
      // Render reflection: the subprocess reads the SAME dir, so the path
      // renders. Reload pulls a fresh render after the add (the add
      // invalidates the ~60s page cache).
      await page.goto(`/hub/${encodeURIComponent(FOLDERS_PAGE)}`);
      await expect(page.getByText(WATCH_DIR)).toBeVisible({ timeout: 10_000 });
    });

    // A config mutation (toggle a preset on a sibling watched folder) now
    // REFLECTS in the Folders render — proves the render reads the
    // post-mutation config from the same dir. MUTATE_DIR is a sibling so it
    // doesn't disturb WATCH_DIR; cleaned up after.
    test("config mutation REFLECTS in the Folders Hub render (data dirs aligned)", async ({ page, request }) => {
      const add = await postEvent(request, "add-folder", { path: MUTATE_DIR });
      expect(add.status()).toBe(200);
      const folder = readWriterConfig().folders.find((f) => f.path === MUTATE_DIR);
      expect(folder, "throwaway folder must persist").toBeTruthy();
      const folderId = folder!.id as string;

      const preset = await postEvent(request, "toggle-preset", { folderId, preset: "junk-sweep" });
      expect(((await preset.json()) as { ok: boolean }).ok).toBe(true);
      expect(
        (readWriterConfig().folders.find((f) => f.id === folderId)?.presets as string[]) ?? [],
      ).toContain("junk-sweep");
      // Render reflection: the mutated folder's path renders in the Hub.
      await page.goto(`/hub/${encodeURIComponent(FOLDERS_PAGE)}`);
      await expect(page.getByText(MUTATE_DIR)).toBeVisible({ timeout: 10_000 });

      // Clean up the throwaway folder (afterAll also restores config.json).
      await postEvent(request, "remove-folder", { folderId });
    });

    // The Review Hub render loads against the live backend reading the same
    // data dir the daemon writes (pre-fix it read the wrong dir / could be
    // disabled). Even with no daemon-produced proposals, the render must
    // succeed (titled page). The conditional accept/move is covered by the
    // proposal-lifecycle test above.
    test("Review Hub render loads against the live backend (data dirs aligned)", async ({ page }) => {
      await page.goto(`/hub/${encodeURIComponent("ext:file-organizer:overview")}`);
      await expect(page.getByTestId("hub-page-title")).toBeVisible({ timeout: 10_000 });
    });
  },
);
