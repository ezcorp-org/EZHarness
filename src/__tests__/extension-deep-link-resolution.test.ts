/**
 * THE DEEP-LINK GUARD (server side).
 *
 * The bug this file exists to make impossible: the install pipeline MINTS a
 * user-facing URL (`/extensions/<manifest-name>`) that nothing ever proved
 * resolves. `POST /api/extensions/author/install` returned it as
 * `redirectUrl`, the `install_draft` card rendered it as the "Open extension"
 * button's `openUrl`, the author page `goto`'d it — and the detail route's
 * read was an id-equality lookup, so the one link handed to a user after a
 * successful install rendered "Extension not found".
 *
 * It shipped because the only test that touched the redirect asserted the URL
 * STRING. A string is not a destination. So this suite asserts, against a real
 * PGlite and the REAL producer:
 *
 *   1. every deep-link `installAuthoredDraft` mints for a freshly installed
 *      extension RESOLVES to that extension's row, and
 *   2. so does the library's `/extensions/<row-id>` link shape.
 *
 * The links are read off the pipeline's actual return value, never re-typed
 * here — change the minted URL shape without teaching the resolver about it
 * and this fails. The browser-level half (that a resolving ref actually
 * RENDERS, and that the page then canonicalises on the row id) is
 * `web/e2e/extension-deep-links.spec.ts` + the real-tier author flow.
 *
 * The pipeline's non-DB collaborators (draft store, acceptance gate, the
 * installer's file/checksum work, the registry) are mocked so the install is
 * deterministic; `db/queries/extensions` is deliberately NOT mocked — the row
 * really lands in the test DB and the resolver really queries it.
 */

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  useTempProjectRoot,
  type TempProjectRoot,
} from "./helpers/temp-project-root";
import { mockDbConnection, setupTestDb, closeTestDb } from "./helpers/test-pglite";

mockDbConnection();

// ── Draft store double ────────────────────────────────────────────
// The pipeline's owner-scoped draft lookup + the on-disk draft dir.
let DRAFT_DIR = "";
let TMP_ROOT = "";
let tmpProjectRoot: TempProjectRoot | undefined;
const consumed: string[] = [];
mock.module("../db/queries/ez-drafts", () => ({
  getDraft: async () => ({ id: "draft-1", kind: "extension", payload: { type: "tool" } }),
  consumeDraft: async (id: string) => {
    consumed.push(id);
    return { id };
  },
  getExtensionAuthorDraftDir: () => DRAFT_DIR,
}));

// ── Acceptance gate double ────────────────────────────────────────
// Returns the manifest the pipeline names the extension (and therefore the
// deep-link) after. Mutable so a test can drive a hostile name.
let manifestName = "weather-lookup";
mock.module("../extensions/author-gate", () => ({
  runAuthorAcceptanceGate: async () => ({
    ok: true,
    manifest: {
      schemaVersion: 2,
      name: manifestName,
      version: "1.0.0",
      description: "deep-link guard fixture",
      author: { name: "test" },
      permissions: {},
    },
    steps: [],
  }),
}));

// ── Installer double ──────────────────────────────────────────────
// Stands in for the checksum/env-leak/file work ONLY — it still writes a REAL
// row through the REAL query layer, so the resolver under test queries a real
// table, not a map.
const { createExtension } = await import("../db/queries/extensions");
mock.module("../extensions/installer", () => ({
  installFromLocal: async (
    installedPath: string,
    granted: Record<string, unknown>,
  ) =>
    createExtension({
      name: manifestName,
      version: "1.0.0",
      description: "deep-link guard fixture",
      manifest: {
        schemaVersion: 2,
        name: manifestName,
        version: "1.0.0",
        description: "deep-link guard fixture",
        author: { name: "test" },
        permissions: {},
      } as never,
      source: `local:${installedPath}`,
      installPath: installedPath,
      enabled: false,
      grantedPermissions: granted as never,
    }),
}));

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: { getInstance: () => ({ reload: async () => {} }) },
}));

afterAll(async () => {
  await closeTestDb();
  tmpProjectRoot?.cleanup();
  restoreModuleMocks();
});

const { installAuthoredDraft } = await import("../extensions/author-install");
const { getExtensionByRef } = await import("../db/queries/extensions");

/**
 * The library's link shape, verbatim from
 * `web/src/routes/(app)/extensions/+page.svelte` (`href="/extensions/{ext.id}"`).
 */
function libraryLink(rowId: string): string {
  return `/extensions/${rowId}`;
}

/**
 * Do what the SvelteKit router does with a `/extensions/<ref>` URL: hand the
 * single path segment to the route as `params.id`. Anything that is not that
 * route's shape is a test-authoring mistake, not a silent pass.
 */
function routeParamOf(deepLink: string): string {
  const m = /^\/extensions\/([^/?#]+)$/.exec(deepLink);
  expect(m, `not a /extensions/<ref> deep-link: ${deepLink}`).not.toBeNull();
  return decodeURIComponent(m![1]!);
}

beforeEach(async () => {
  await setupTestDb();
  consumed.length = 0;
  manifestName = "weather-lookup";
  // The install lands at `getProjectRoot()/.ezcorp/extensions/<name>`, so
  // the root has to be PINNED here — otherwise the pipeline writes into
  // the real checkout. `tmpProjectRoot.cleanup()` (afterAll) restores the
  // env var, the cache and the cwd. The draft dir keeps its real-world
  // depth because the resolver is mocked to hand back this exact path.
  tmpProjectRoot = useTempProjectRoot("ez-deeplink-");
  TMP_ROOT = tmpProjectRoot.root;
  DRAFT_DIR = join(
    TMP_ROOT,
    ".ezcorp/extension-data/extension-author/drafts/user-1/draft-1",
  );
  mkdirSync(DRAFT_DIR, { recursive: true });
  writeFileSync(join(DRAFT_DIR, "index.ts"), "export default {};\n");
});

describe("every deep-link the server mints resolves to the installed row", () => {
  test("install → redirectUrl, openUrl and the library link all resolve to the SAME row", async () => {
    const result = await installAuthoredDraft({
      draftId: "draft-1",
      userId: "user-1",
      enable: false,
    });

    // The pipeline must actually hand the user a link — an omitted `openUrl`
    // would make the rest of this test vacuous.
    expect(result.redirectUrl).toBeTruthy();
    expect(result.openUrl).toBeTruthy();

    // Read the links OFF THE PRODUCER. Nothing below re-types a URL shape, so
    // a change to how the server mints them is a failure here, not a silent
    // "Extension not found" in a browser.
    const deepLinks: Array<[string, string]> = [
      ["install redirectUrl (web author form)", result.redirectUrl],
      ["install_draft openUrl (in-chat card button)", result.openUrl!],
      ["extensions library link", libraryLink(result.extensionId)],
    ];

    for (const [label, link] of deepLinks) {
      const resolved = await getExtensionByRef(routeParamOf(link));
      expect(resolved, `${label} (${link}) does not resolve to any extension`).not.toBeNull();
      expect(resolved!.id, `${label} resolved to the WRONG extension`).toBe(
        result.extensionId,
      );
      expect(resolved!.name).toBe(result.name);
    }
  });

  test("the id-only lookup the route used to call is what BROKE the name links", async () => {
    const { getExtension } = await import("../db/queries/extensions");
    const result = await installAuthoredDraft({
      draftId: "draft-1",
      userId: "user-1",
      enable: false,
    });

    // Characterises the regression precisely: the very same links resolve
    // under `getExtensionByRef` and 404 under the id-equality lookup. If a
    // future refactor points the detail read back at `getExtension`, the
    // suite above goes red for exactly this reason.
    const nameRef = routeParamOf(result.redirectUrl);
    expect(await getExtension(nameRef)).toBeNull();
    expect((await getExtensionByRef(nameRef))?.id).toBe(result.extensionId);
  });
});

describe("getExtensionByRef", () => {
  async function seed(name: string) {
    return createExtension({
      name,
      version: "1.0.0",
      description: "",
      manifest: { schemaVersion: 2, name, version: "1.0.0", description: "", author: { name: "t" }, permissions: {} } as never,
      source: "local:/tmp/x",
      installPath: "/tmp/x",
      enabled: false,
      grantedPermissions: {} as never,
    });
  }

  test("resolves by row id", async () => {
    const row = await seed("alpha");
    expect((await getExtensionByRef(row.id))?.id).toBe(row.id);
  });

  test("resolves by manifest name", async () => {
    const row = await seed("alpha");
    expect((await getExtensionByRef("alpha"))?.id).toBe(row.id);
  });

  test("unknown reference returns null", async () => {
    await seed("alpha");
    expect(await getExtensionByRef("no-such-extension")).toBeNull();
  });

  test("empty reference returns null without querying", async () => {
    await seed("alpha");
    expect(await getExtensionByRef("")).toBeNull();
  });

  // Manifest names are USER-CONTROLLED and only have to satisfy
  // `^[a-z0-9][a-z0-9-_.]{0,63}$` — which a `crypto.randomUUID()` string
  // satisfies. So a second install can name itself byte-identically to an
  // existing row's id. Id must win, or a squatter could shadow another
  // extension at its own URL.
  test("a name that squats on another row's id NEVER shadows it — id wins", async () => {
    const victim = await seed("victim-extension");
    const squatter = await seed(victim.id);

    expect(squatter.name).toBe(victim.id);
    const resolved = await getExtensionByRef(victim.id);
    expect(resolved!.id).toBe(victim.id);
    expect(resolved!.name).toBe("victim-extension");

    // The squatter is still reachable at its OWN id.
    expect((await getExtensionByRef(squatter.id))?.id).toBe(squatter.id);
  });
});
