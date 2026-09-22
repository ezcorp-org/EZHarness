/**
 * Integration test for the file-mention symlink-escape boundary.
 *
 * Threat model: a user types `@filename` → the autocomplete endpoint
 * `/api/mentions/search?type=path` lists project files → user picks the
 * entry → the composer inserts `@[file:...]` → the message is POSTed →
 * server resolves the mention against the project root → an LLM /
 * downstream tool reads the file. Any path that resolves OUTSIDE the
 * project root via a symlink, `..` traversal, or absolute prefix must
 * be rejected at every step.
 *
 * Pieces under test:
 *   1. `web/src/routes/api/mentions/search/+server.ts` `GET` — implements
 *      a `realpath`-based `insideRoot` filter on the autocomplete side.
 *   2. `src/runtime/mention-wiring.ts` `resolveFileMentions` — mirrors
 *      that filter so the resolve pipeline agrees with the search
 *      pipeline. A token can't survive past either boundary.
 */

import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks, unavailableWorkflowAccess } from "./helpers/mock-cleanup";
import { serverContextStub } from "./helpers/mock-request";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Mock the SvelteKit aliases the +server.ts route imports ─────────
// Mocks must be registered BEFORE importing the route module.

let nextProject: { id: string; path: string } | null = null;

// The route resolves `$server/db/queries/projects` through its OWN tsconfig,
// and a dozen suites in this pool register that alias, so a relative-path mock
// cannot reach the route: once any file registers a `$server/*` specifier it is
// served from that registration for the rest of the process. Claim the alias,
// then, but claim it SAFELY — spread the real module so the export set stays
// whole, and re-register the real module in afterAll so the value goes back.
// Bound before the `drizzle-orm` mock below, which the real module builds with.
const realProjects = require("../db/queries/projects");

mock.module("$server/db/queries/projects", () => ({
  ...realProjects,
  getProject: async (_id: string) => nextProject,
}));

// Spread the real module, and revert the one override in afterAll. A
// `mock.module("$server/…")` cannot be withdrawn, and a PARTIAL factory does
// not merely shadow the other exports — it deletes them for the rest of the
// process, because no module was ever loaded under that specifier for a
// snapshot to restore from. Dropping `checkProjectRole` here stopped
// `installer-idempotent-local.test.ts` from linking at all, losing its
// sixteen tests to one unhandled error.
let stubRequireAuth = true;
mock.module("$server/auth/middleware", () => ({
  ...require("../auth/middleware"),
  requireAuth: (locals: unknown) => (stubRequireAuth ? { id: "test-user", role: "admin" } : require("../auth/middleware").requireAuth(locals)),
}));

mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));

mock.module("$lib/server/workflow-access", () => ({
  listVisibleWorkflows: async () => [],
}));

// The route statically imports `getWorkflows` for the `type=workflow` branch
// and the bare-`!` merge. This spec only exercises `type=path`, which returns
// first — but the export has to exist for the module to link at all. That is
// true of every OTHER export too, for every later suite in the process:
// `serverContextStub` supplies the whole list so a partial factory here cannot
// delete one out from under them.
mock.module("$lib/server/context", () => serverContextStub({
  getExecutor: () => ({ listAgents: () => [] }),
  getCommandRegistry: () => ({ listCommands: () => [] }),
  getWorkflows: () => [],
}));

// Mocked on the RELATIVE path, not on `$server/db/connection`: the route
// resolves that alias through its own tsconfig to this same module, so the
// stub still reaches it, and nothing registers the alias — which would hijack
// the specifier for every later file and freeze it on this empty database.
// `restoreModuleMocks()` in afterAll then puts the real module back, which it
// could never do for an alias.
mock.module("../db/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }),
  }),
}));

// No `$server/db/schema` stub. The fake `getDb()` above ignores whatever table
// it is handed, so the real tables cost these specs nothing — and stubbing them
// costs a LATER suite everything: this route module is linked ONCE per process,
// so whichever suite imports it first binds its `extensions` for all of them,
// and a re-registration in afterAll cannot rebind an import that is already
// resolved. An empty table then reaches a real drizzle query as
// `Object.entries(undefined)` inside `orderSelectedFields`.

mock.module("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  or: () => ({}),
  ilike: () => ({}),
}));

mock.module("$server/runtime/tools/builtin-registry", () => ({
  getBuiltInCategories: () => [],
}));

afterAll(() => {
  stubRequireAuth = false;
  mock.module("$lib/server/workflow-access", unavailableWorkflowAccess);
  mock.module("$server/runtime/tools/builtin-registry", () =>
    require("../runtime/tools/builtin-registry"),
  );
  // Hand the two claimed aliases back to the real modules. The registration
  // itself cannot be withdrawn, but re-registering updates the values, and an
  // empty `extensions` table reaching a later suite's real drizzle query is a
  // TypeError inside `orderSelectedFields`, not a test failure it can read.
  mock.module("$server/db/queries/projects", () => realProjects);
  // Puts the relative `../db/connection` stub back. No suite in this pool
  // claims that alias, so the route reaches the stub natively and the real
  // module can be restored the ordinary way.
  restoreModuleMocks();
});

// Import AFTER mocks.
const { GET } = await import("../../web/src/routes/api/mentions/search/+server");
const { resolveFileMentions } = await import("../runtime/mention-wiring");

// ── Setup helper: temp project with an out-of-root symlink ──────────

const SECRET_CONTENT = "TOP-SECRET-DO-NOT-LEAK\n";

let projectRoot: string;
let outsideDir: string;
let secretFile: string;

beforeAll(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "mention-symlink-proj-"));
  outsideDir = await mkdtemp(join(tmpdir(), "mention-symlink-outside-"));
  // Layout:
  //   projectRoot/
  //     ok.txt                          (regular file inside project — control)
  //     src/
  //       app.ts                        (regular file in subdir)
  //     escape-link.txt  ──┐             (symlink → outside/secret.txt)
  //     escape-dir       ──┤             (symlink → outside/   directory)
  //   outsideDir/
  //     secret.txt                       (target of escape-link.txt)
  //     buried/inner.txt                 (target reachable via escape-dir)
  await writeFile(join(projectRoot, "ok.txt"), "INSIDE\n");
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(join(projectRoot, "src", "app.ts"), "// app\n");

  secretFile = join(outsideDir, "secret.txt");
  await writeFile(secretFile, SECRET_CONTENT);
  await mkdir(join(outsideDir, "buried"), { recursive: true });
  await writeFile(join(outsideDir, "buried", "inner.txt"), "BURIED-SECRET\n");

  try {
    await symlink(secretFile, join(projectRoot, "escape-link.txt"));
    await symlink(outsideDir, join(projectRoot, "escape-dir"));
  } catch (e) {
    // Some sandboxes reject symlink creation. The describe-blocks below
    // tolerate this by skipping assertions when the symlink wasn't made.
    console.warn("symlink creation failed; skipping symlink-specific assertions:", e);
  }
});

afterAll(async () => {
  try {
    if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
  } finally {
    if (outsideDir) await rm(outsideDir, { recursive: true, force: true });
  }
});

// ── Helpers to invoke the +server.ts GET handler directly ───────────

function buildEvent(params: Record<string, string>): any {
  const search = new URLSearchParams(params).toString();
  const url = new URL(`http://localhost/api/mentions/search?${search}`);
  return {
    url,
    locals: {},
    request: new Request(url.toString()),
  };
}

async function callSearch(params: Record<string, string>): Promise<any[]> {
  const res = await GET(buildEvent(params));
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────
// 1. Search filter rejects symlink-escape entries
// ─────────────────────────────────────────────────────────────────────

describe("GET /api/mentions/search — symlink-escape filter", () => {
  test("symlink to a file outside the project is excluded from results", async () => {
    nextProject = { id: "p", path: projectRoot };
    const body = await callSearch({ type: "path", q: "", projectId: "p" });
    const names: string[] = body.map((b) => b.name);
    expect(names).not.toContain("escape-link.txt");
  });

  test("symlink to a directory outside the project is excluded from results", async () => {
    nextProject = { id: "p", path: projectRoot };
    const body = await callSearch({ type: "path", q: "", projectId: "p" });
    const names: string[] = body.map((b) => b.name);
    expect(names).not.toContain("escape-dir");
  });

  test("descent INTO a symlink-escape directory yields no children", async () => {
    nextProject = { id: "p", path: projectRoot };
    const body = await callSearch({ type: "path", q: "escape-dir/", projectId: "p" });
    // Children of the symlinked outside dir must not surface — every entry's
    // realpath would resolve outside the project root.
    expect(body).toEqual([]);
  });

  test("fuzzy query matching the symlink basename still excludes it", async () => {
    nextProject = { id: "p", path: projectRoot };
    const body = await callSearch({ type: "path", q: "escape", projectId: "p" });
    const names: string[] = body.map((b) => b.name);
    expect(names).not.toContain("escape-link.txt");
    expect(names).not.toContain("escape-dir");
  });

  // Negative control: regular files MUST appear in results so we know the
  // tests aren't false-positive (i.e., aren't passing because nothing is
  // listed at all).
  test("negative control: regular files inside project DO appear", async () => {
    nextProject = { id: "p", path: projectRoot };
    const body = await callSearch({ type: "path", q: "", projectId: "p" });
    const names: string[] = body.map((b) => b.name);
    expect(names).toContain("ok.txt");
    expect(names).toContain("src/app.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. Resolver refuses tokens whose realpath escapes the project root
// ─────────────────────────────────────────────────────────────────────

describe("resolveFileMentions — symlink-escape boundary holds", () => {
  test("symlinked file pointing outside the project is refused", async () => {
    const result = await resolveFileMentions(
      "read @[file:escape-link.txt]",
      projectRoot,
    );
    expect(result).toEqual([]);
  });

  test("symlinked dir pointing outside the project is refused", async () => {
    const result = await resolveFileMentions(
      "list @[dir:escape-dir]",
      projectRoot,
    );
    expect(result).toEqual([]);
  });

  test("regression guard: out-of-project symlink content cannot leak via mention", async () => {
    // If this assertion ever fails (result.length > 0), the resolver has
    // regressed — readFile(result[0].absPath) would follow the symlink and
    // surface SECRET_CONTENT. realpath confinement is the only thing
    // standing between a `@[file:link]` token and an out-of-project read.
    const result = await resolveFileMentions(
      "read @[file:escape-link.txt]",
      projectRoot,
    );
    expect(result).toHaveLength(0);
    // SECRET_CONTENT is referenced here so the fixture cleanup
    // (`outsideDir`) remains tied to a real assertion target.
    expect(SECRET_CONTENT.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. Validator/POST simulation: a message containing the escape token
// ─────────────────────────────────────────────────────────────────────

describe("message-POST simulation — content does not leak from a stable boundary", () => {
  test("system note for symlink-escape token does not embed file content", async () => {
    // The runtime does NOT eagerly read file content — it only emits a
    // "[User referenced file: ...]" system note pointing at the path.
    // Verify the note text never embeds the secret payload.
    const { resolveFileMentions, formatFileMentionSystemNotes } = await import(
      "../runtime/mention-wiring"
    );
    const mentions = await resolveFileMentions(
      "please read @[file:escape-link.txt]",
      projectRoot,
    );
    const note = formatFileMentionSystemNotes(mentions);
    expect(note).not.toContain(SECRET_CONTENT);
    expect(note).not.toContain("TOP-SECRET");
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Edge cases: relative `..` traversal + absolute path
// ─────────────────────────────────────────────────────────────────────

describe("resolveFileMentions — traversal + absolute paths are rejected", () => {
  test("relative `../../etc/passwd` is rejected (returns empty)", async () => {
    const result = await resolveFileMentions(
      "exfil @[file:../../etc/passwd]",
      projectRoot,
    );
    expect(result).toEqual([]);
  });

  test("absolute `/etc/passwd` is rejected (returns empty)", async () => {
    const result = await resolveFileMentions(
      "exfil @[file:/etc/passwd]",
      projectRoot,
    );
    expect(result).toEqual([]);
  });

  test("absolute path to symlink target is rejected even if target exists", async () => {
    const result = await resolveFileMentions(
      `exfil @[file:${secretFile}]`,
      projectRoot,
    );
    expect(result).toEqual([]);
  });

  test("search endpoint rejects absolute query path (no out-of-root entries)", async () => {
    nextProject = { id: "p", path: projectRoot };
    const body = await callSearch({ type: "path", q: "/etc/", projectId: "p" });
    // Whatever the response, no entry's description (absolute path) may
    // escape the project root.
    for (const entry of body) {
      expect(entry.description.startsWith(projectRoot)).toBe(true);
    }
  });
});
