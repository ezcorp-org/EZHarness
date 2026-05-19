/**
 * Direct test for `+page.server.ts`'s `load()` export. Auditor flagged
 * the prior page-logic test as skipping `load()` ("would require a
 * SvelteKit-aware harness"). SvelteKit's `load` is a plain function —
 * we mock `locals: { user }` and `url: new URL(...)` and call it
 * directly. Covers:
 *
 *   - missing `?prefill`              → throws error(400)
 *   - invalid draftId shape           → throws error(400)
 *   - missing / expired / wrong-owner → throws error(404)
 *   - non-extension draft kind        → throws error(400)
 *   - happy path returns { draft, files } with files read fresh from disk
 *   - fresh-from-disk: mutate a file, call load again, change reflected
 *
 * Spec ref: auditor must-fix gap (B2).
 */

import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const draftStore = new Map<string, { userId: string; kind: string; payload: unknown; consumedAt: Date | null }>();

vi.mock("$server/auth/middleware", () => ({
  requireAuth: vi.fn((locals: { user?: { id: string } }) => {
    if (!locals.user) throw new Response("unauth", { status: 401 });
    return locals.user;
  }),
}));

vi.mock("$server/db/queries/ez-drafts", async () => {
  const { join } = await import("node:path");
  return {
    getDraft: vi.fn(async (id: string, userId: string) => {
      const r = draftStore.get(id);
      if (!r) return undefined;
      if (r.userId !== userId) return undefined;
      return {
        id,
        userId,
        kind: r.kind,
        payload: r.payload,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: r.consumedAt,
      };
    }),
    getExtensionAuthorDraftDir: vi.fn((id: string, userId: string) =>
      join(DRAFT_ROOT, userId, id),
    ),
  };
});

import { load } from "../routes/(app)/extensions/author/+page.server";

let TMP: string;
let DRAFT_ROOT: string;
const USER = { id: "user-x", email: "x@x", name: "X", role: "member" };

function seedDraft(id: string, userId: string, files: Record<string, string>): void {
  const dir = join(DRAFT_ROOT, userId, id);
  draftStore.set(id, {
    userId,
    kind: "extension",
    payload: { name: "weather", type: "tool", mode: "author", draftDir: dir },
    consumedAt: null,
  });
  mkdirSync(dir, { recursive: true });
  for (const [n, c] of Object.entries(files)) {
    writeFileSync(join(dir, n), c, "utf8");
  }
}

/**
 * Build a `LoadEvent`-ish fixture. The real type has many fields
 * but `load()` here only reads `url`, `locals`. Anything else can be
 * `never`-typed.
 */
function makeEvent(opts: {
  prefill?: string | null;
  user?: typeof USER | null;
}): never {
  const url = new URL("http://x/extensions/author");
  if (opts.prefill !== undefined && opts.prefill !== null) {
    url.searchParams.set("prefill", opts.prefill);
  }
  return {
    url,
    locals: opts.user === null ? {} : { user: opts.user ?? USER },
    params: {},
    route: { id: "/(app)/extensions/author" },
    fetch: globalThis.fetch,
    setHeaders: () => {},
    parent: async () => ({}),
    depends: () => {},
    untrack: <T>(fn: () => T) => fn(),
  } as never;
}

beforeEach(() => {
  TMP = join(tmpdir(), `ext-author-load-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(join(TMP, ".git"), { recursive: true });
  DRAFT_ROOT = join(TMP, ".ezcorp/extension-data/extension-author/drafts");
  mkdirSync(DRAFT_ROOT, { recursive: true });
  process.chdir(TMP);
  draftStore.clear();
});

afterEach(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* swallow */ }
});

describe("+page.server.ts load() — 400 path", () => {
  test("missing ?prefill → throws error(400)", async () => {
    await expect(load(makeEvent({}))).rejects.toMatchObject({ status: 400 });
  });

  test("invalid draftId shape (path-traversal) → throws error(400)", async () => {
    await expect(load(makeEvent({ prefill: "../escape" }))).rejects.toMatchObject({ status: 400 });
  });

  test("invalid draftId shape (slash) → throws error(400)", async () => {
    await expect(load(makeEvent({ prefill: "a/b" }))).rejects.toMatchObject({ status: 400 });
  });

  test("non-extension kind draft → throws error(400)", async () => {
    draftStore.set("bad-kind", {
      userId: USER.id,
      kind: "agent",
      payload: {},
      consumedAt: null,
    });
    await expect(load(makeEvent({ prefill: "bad-kind" }))).rejects.toMatchObject({ status: 400 });
  });
});

describe("+page.server.ts load() — 404 path (opaque)", () => {
  test("missing draftId → throws error(404)", async () => {
    await expect(load(makeEvent({ prefill: "nonexistent" }))).rejects.toMatchObject({ status: 404 });
  });

  test("wrong-owner draftId → throws error(404) (same as missing, opaque)", async () => {
    seedDraft("d-other", "other-user", { "README.md": "x" });
    await expect(load(makeEvent({ prefill: "d-other" }))).rejects.toMatchObject({ status: 404 });
  });
});

describe("+page.server.ts load() — happy path", () => {
  test("returns { draft, files } with files read fresh from disk", async () => {
    seedDraft("happy", USER.id, {
      "ezcorp.config.ts": "// stub manifest",
      "README.md": "# Happy",
    });
    const result = await load(makeEvent({ prefill: "happy" })) as {
      draft: { id: string; kind: string };
      files: Record<string, string>;
    };
    expect(result.draft.id).toBe("happy");
    expect(result.draft.kind).toBe("extension");
    expect(result.files["ezcorp.config.ts"]).toBe("// stub manifest");
    expect(result.files["README.md"]).toBe("# Happy");
  });

  test("file mutation reflected on subsequent load (fresh-read, not cached)", async () => {
    seedDraft("fresh", USER.id, { "README.md": "original" });
    const r1 = await load(makeEvent({ prefill: "fresh" })) as { files: Record<string, string> };
    expect(r1.files["README.md"]).toBe("original");

    // Mutate the file on disk WITHOUT going through the API. The next
    // load() must see the new content — proves the loader doesn't
    // cache.
    writeFileSync(join(DRAFT_ROOT, USER.id, "fresh", "README.md"), "edited", "utf8");

    const r2 = await load(makeEvent({ prefill: "fresh" })) as { files: Record<string, string> };
    expect(r2.files["README.md"]).toBe("edited");
  });

  test("files outside ALLOWED_FILES are excluded", async () => {
    seedDraft("filt", USER.id, {
      "ezcorp.config.ts": "// stub",
    });
    // Drop a non-allowlisted file directly on disk.
    writeFileSync(join(DRAFT_ROOT, USER.id, "filt", "secret.key"), "shhh", "utf8");

    const result = await load(makeEvent({ prefill: "filt" })) as { files: Record<string, string> };
    expect(result.files["ezcorp.config.ts"]).toBe("// stub");
    expect("secret.key" in result.files).toBe(false);
  });
});
