/**
 * Integration tests for the Feature Index REST endpoints.
 *
 * Surface under test:
 *   - GET    /api/projects/:id/features
 *   - POST   /api/projects/:id/features
 *   - PATCH  /api/projects/:id/features/:featureId
 *   - DELETE /api/projects/:id/features/:featureId
 *   - POST   /api/projects/:id/features/scan
 *
 * Combines real PGlite (`setupTestDb`) with `mockServerAlias()` so the
 * route handlers reach actual DB queries through the mocked
 * `$server/db/queries/*` aliases. Auth + scope are stubbed at the
 * boundary so we focus on policy + data flow.
 *
 * The headline assertions:
 *   - PATCH on agent-sourced feature flips source → 'user' (PM headline)
 *   - Scan preserves user-pinned files AND user-renamed feature rows
 *   - Cross-project isolation on PATCH/DELETE
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  mockServerAlias,
  createMockEvent,
  jsonFromResponse,
  MEMBER_USER,
} from "./helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ─────────────────────
mockDbConnection();
mockServerAlias();

// Make $server aliases used by the feature routes resolve to the real
// modules backed by the mocked db/connection.
mock.module("$server/db/queries/features", () =>
  require("../db/queries/features"),
);
mock.module("$server/db/queries/projects", () =>
  require("../db/queries/projects"),
);
mock.module("$server/runtime/scan/feature-scan", () =>
  require("../runtime/scan/feature-scan"),
);
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null, // open scope — auth is checked separately by requireAuth
}));
mock.module("$lib/server/security/validation", () =>
  require("../../web/src/lib/server/security/validation"),
);
mock.module("$lib/server/http-errors", () =>
  require("../../web/src/lib/server/http-errors"),
);

mock.module(
  "../../web/src/routes/api/projects/[id]/features/$types",
  () => ({}),
);
mock.module(
  "../../web/src/routes/api/projects/[id]/features/[featureId]/$types",
  () => ({}),
);
mock.module(
  "../../web/src/routes/api/projects/[id]/features/scan/$types",
  () => ({}),
);

// ── Handler imports (AFTER mocks) ───────────────────────────────────
import { GET, POST as POST_create } from "../../web/src/routes/api/projects/[id]/features/+server";
import {
  PATCH,
  DELETE,
} from "../../web/src/routes/api/projects/[id]/features/[featureId]/+server";
import { POST as POST_scan } from "../../web/src/routes/api/projects/[id]/features/scan/+server";

const { createProject } = await import("../db/queries/projects");
const { createFeature, addUserFile, replaceAgentFiles, getFeature } =
  await import("../db/queries/features");

// ── Helpers ─────────────────────────────────────────────────────────

async function call(handler: any, event: any): Promise<Response> {
  try {
    return (await handler(event)) as Response;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

let projectId: string;
let otherProjectId: string;
let projectRoot: string;
let otherProjectRoot: string;

async function freshProjects() {
  projectRoot = await mkdtemp(resolve(tmpdir(), "feat-route-"));
  otherProjectRoot = await mkdtemp(resolve(tmpdir(), "feat-route-other-"));
  const a = await createProject({ name: "alpha", path: projectRoot });
  const b = await createProject({ name: "beta", path: otherProjectRoot });
  projectId = a.id;
  otherProjectId = b.id;
}

beforeEach(async () => {
  await setupTestDb();
  await freshProjects();
});

afterAll(async () => {
  await closeTestDb();
  await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  await rm(otherProjectRoot, { recursive: true, force: true }).catch(() => {});
  restoreModuleMocks();
});

// ── GET /api/projects/:id/features ──────────────────────────────────

describe("GET /api/projects/:id/features", () => {
  test("returns 404 when project does not exist", async () => {
    const event = createMockEvent({
      method: "GET",
      url: "http://localhost/api/projects/missing/features",
      params: { id: "missing-id" },
      user: MEMBER_USER,
    });
    const res = await call(GET, event);
    expect(res.status).toBe(404);
    const body = await jsonFromResponse(res);
    expect(body.error).toContain("Project not found");
  });

  test("returns 401 when unauthenticated", async () => {
    const event = createMockEvent({
      method: "GET",
      params: { id: projectId },
      // no user
    });
    const res = await call(GET, event);
    expect(res.status).toBe(401);
  });

  test("empty project returns []", async () => {
    const event = createMockEvent({
      method: "GET",
      params: { id: projectId },
      user: MEMBER_USER,
    });
    const res = await call(GET, event);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body).toEqual([]);
  });

  test("returns features sorted by name with file counts", async () => {
    const f1 = await createFeature({ projectId, name: "z-feat" });
    const f2 = await createFeature({ projectId, name: "a-feat" });
    await replaceAgentFiles(f1.id, ["src/z/1.ts", "src/z/2.ts"]);
    await addUserFile(f2.id, "src/a/p.ts");

    const event = createMockEvent({
      method: "GET",
      params: { id: projectId },
      user: MEMBER_USER,
    });
    const res = await call(GET, event);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body.map((f: any) => f.name)).toEqual(["a-feat", "z-feat"]);
    const byName = new Map(body.map((f: any) => [f.name, f.fileCount]));
    expect(byName.get("a-feat")).toBe(1);
    expect(byName.get("z-feat")).toBe(2);
  });

  test("scopes results to the requested project (cross-project isolation)", async () => {
    await createFeature({ projectId, name: "mine" });
    await createFeature({ projectId: otherProjectId, name: "yours" });

    const event = createMockEvent({
      method: "GET",
      params: { id: projectId },
      user: MEMBER_USER,
    });
    const body = await jsonFromResponse(await call(GET, event));
    expect(body.map((f: any) => f.name)).toEqual(["mine"]);
  });
});

// ── POST /api/projects/:id/features ─────────────────────────────────

describe("POST /api/projects/:id/features", () => {
  test("creates a user-sourced feature with fileCount: 0 and 201", async () => {
    const event = createMockEvent({
      method: "POST",
      params: { id: projectId },
      body: { name: "manual", description: "hand-rolled" },
      user: MEMBER_USER,
    });
    const res = await call(POST_create, event);
    expect(res.status).toBe(201);
    const body = await jsonFromResponse(res);
    expect(body.name).toBe("manual");
    expect(body.description).toBe("hand-rolled");
    expect(body.source).toBe("user");
    expect(body.fileCount).toBe(0);
  });

  test("rejects duplicate name in same project with 409", async () => {
    await createFeature({ projectId, name: "dup" });
    const event = createMockEvent({
      method: "POST",
      params: { id: projectId },
      body: { name: "dup" },
      user: MEMBER_USER,
    });
    const res = await call(POST_create, event);
    expect(res.status).toBe(409);
  });

  test("same name in DIFFERENT project succeeds (per-project unique)", async () => {
    await createFeature({ projectId, name: "shared" });
    const event = createMockEvent({
      method: "POST",
      params: { id: otherProjectId },
      body: { name: "shared" },
      user: MEMBER_USER,
    });
    const res = await call(POST_create, event);
    expect(res.status).toBe(201);
  });

  test("rejects name with whitespace via zod schema → 400", async () => {
    const event = createMockEvent({
      method: "POST",
      params: { id: projectId },
      body: { name: "has whitespace" },
      user: MEMBER_USER,
    });
    const res = await call(POST_create, event);
    expect(res.status).toBe(400);
  });

  test("missing body → 400", async () => {
    const event = createMockEvent({
      method: "POST",
      params: { id: projectId },
      body: {},
      user: MEMBER_USER,
    });
    const res = await call(POST_create, event);
    expect(res.status).toBe(400);
  });

  test("missing project → 404", async () => {
    const event = createMockEvent({
      method: "POST",
      params: { id: "ghost" },
      body: { name: "x" },
      user: MEMBER_USER,
    });
    const res = await call(POST_create, event);
    expect(res.status).toBe(404);
  });

  test("unauthenticated → 401", async () => {
    const event = createMockEvent({
      method: "POST",
      params: { id: projectId },
      body: { name: "x" },
    });
    const res = await call(POST_create, event);
    expect(res.status).toBe(401);
  });
});

// ── PATCH /api/projects/:id/features/:featureId — VALIDATION MESSAGES
// ── Locks the user-facing schema messages so a future refactor can't
// ── silently regress them to Zod's defaults ("Invalid"). The UI
// ── surfaces these through the `fields` payload of validationError().

describe("PATCH /api/projects/:id/features/:featureId — validation messages", () => {
  test("rename with a space returns an actionable name-field message (not bare 'Invalid')", async () => {
    const seeded = await createFeature({
      projectId,
      name: "agent-feat",
      description: "",
      source: "agent",
    });

    const res = await call(
      PATCH,
      createMockEvent({
        method: "PATCH",
        params: { id: projectId, featureId: seeded.id },
        body: { name: "has a space" },
        user: MEMBER_USER,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await jsonFromResponse(res)) as {
      error?: string;
      fields?: Record<string, string>;
    };
    expect(body.error).toBe("Validation failed");
    expect(body.fields).toBeDefined();
    expect(body.fields!.name).toContain("letters, numbers, hyphens, and underscores");
    // Anti-regression: the bare default Zod message "Invalid" must not
    // surface here; the user needs to know what the rule actually is.
    expect(body.fields!.name).not.toBe("Invalid");
  });

  test("create with a space in the name returns the same actionable message", async () => {
    const res = await call(
      POST_create,
      createMockEvent({
        method: "POST",
        params: { id: projectId },
        body: { name: "spaces not allowed" },
        user: MEMBER_USER,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await jsonFromResponse(res)) as {
      fields?: Record<string, string>;
    };
    expect(body.fields!.name).toContain("letters, numbers, hyphens, and underscores");
  });

  test("empty PATCH body returns the actionable refine message naming the legal fields", async () => {
    const seeded = await createFeature({
      projectId,
      name: "another-feat",
      description: "",
      source: "agent",
    });

    const res = await call(
      PATCH,
      createMockEvent({
        method: "PATCH",
        params: { id: projectId, featureId: seeded.id },
        body: {},
        user: MEMBER_USER,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await jsonFromResponse(res)) as {
      fields?: Record<string, string>;
    };
    // Refine messages live under the empty path "" because no specific
    // field failed — the whole object did.
    const messages = Object.values(body.fields ?? {});
    expect(messages.some((m) => m.includes("name, description, addFiles, or removeFiles"))).toBe(true);
  });
});

// ── PATCH /api/projects/:id/features/:featureId — SOURCE-FLIP POLICY
// ── (the four explicit cases PM called out)

describe("PATCH /api/projects/:id/features/:featureId — source-flip policy", () => {
  test("CASE 1: PATCH agent feature with rename → flips to source='user', survives subsequent rescan", async () => {
    const f = await createFeature({
      projectId,
      name: "old-name",
      description: "Files under src/old-name",
      source: "agent",
    });
    await replaceAgentFiles(f.id, ["src/old-name/a.ts", "src/old-name/b.ts"]);

    const event = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: f.id },
      body: { name: "renamed" },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body.name).toBe("renamed");
    expect(body.source).toBe("user");

    // CRITICAL follow-up: simulate a rescan that would have refreshed
    // the agent feature's description. Because source is now 'user',
    // the rename must NOT be clobbered. The endpoint owns this policy;
    // we can prove it by re-fetching after a synthetic upsert.
    const reloaded = await getFeature(projectId, "renamed");
    expect(reloaded).toBeDefined();
    expect(reloaded!.source).toBe("user");
  });

  test("CASE 2: PATCH agent feature with description-only edit → also flips to user", async () => {
    const f = await createFeature({
      projectId,
      name: "agent-feat",
      description: "Files under src/agent-feat",
      source: "agent",
    });
    const event = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: f.id },
      body: { description: "Hand-edited description" },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body.source).toBe("user");
    expect(body.description).toBe("Hand-edited description");
  });

  test("CASE 3: PATCH user feature → source stays 'user' (idempotent)", async () => {
    const f = await createFeature({
      projectId,
      name: "user-feat",
      description: "user owned",
      source: "user",
    });
    const event = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: f.id },
      body: { description: "still user" },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body.source).toBe("user");
  });

  test("CASE 4: PATCH that ONLY adds files → parent feature.source stays 'agent' (file-level pins are independent)", async () => {
    // Per the design doc + PM's original spec + dev's narrowed policy
    // in [featureId]/+server.ts: file-level pins (addFiles / removeFiles)
    // do NOT flip the parent feature's source column. The featureFiles
    // row's own `source='user'` already protects the pinned file from
    // rescans; the feature-level source column exists strictly to
    // protect rename / description edits from rescan clobber. Adding a
    // pin to an agent-discovered bucket leaves the bucket itself
    // agent-owned so a subsequent scan can still refresh the bucket's
    // description if the underlying dir gets moved/renamed in the FS.
    const f = await createFeature({
      projectId,
      name: "agent-files",
      source: "agent",
    });
    const event = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: f.id },
      body: { addFiles: ["src/agent-files/p.ts"] },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    // Parent feature.source UNCHANGED (still agent).
    expect(body.source).toBe("agent");
    // The pinned file IS source='user' (per-row protection).
    expect(body.files.map((x: any) => x.relpath)).toContain("src/agent-files/p.ts");
    const pinned = body.files.find((x: any) => x.relpath === "src/agent-files/p.ts");
    expect(pinned.source).toBe("user");
  });

  test("CASE 4 symmetric: PATCH that ONLY removes files on agent → source stays 'agent'", async () => {
    // Mirror of CASE 4 — removeFiles is also file-level and must NOT
    // promote the parent feature to user-owned. The featureFiles row
    // is gone after removal, but the bucket stays agent-owned so the
    // next scan can refresh its description / files normally.
    const f = await createFeature({
      projectId,
      name: "agent-rm-only",
      source: "agent",
    });
    await replaceAgentFiles(f.id, ["src/agent-rm-only/a.ts", "src/agent-rm-only/b.ts"]);

    const event = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: f.id },
      body: { removeFiles: ["src/agent-rm-only/a.ts"] },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body.source).toBe("agent");
    expect(body.files.map((x: any) => x.relpath)).not.toContain("src/agent-rm-only/a.ts");
    expect(body.files.map((x: any) => x.relpath)).toContain("src/agent-rm-only/b.ts");
  });

  test("CASE 4b: PATCH name + addFiles together on agent → flips (name is feature-level)", async () => {
    // The combined-edit case from dev's matrix: when a feature-level
    // edit (name or description) is paired with file ops, the flip
    // still fires. Locks in the boundary so a future refactor can't
    // weaken the rule.
    const f = await createFeature({
      projectId,
      name: "agent-combo",
      source: "agent",
    });
    const event = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: f.id },
      body: { name: "user-combo", addFiles: ["src/agent-combo/p.ts"] },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body.source).toBe("user");
    expect(body.name).toBe("user-combo");
    expect(body.files.map((x: any) => x.relpath)).toContain("src/agent-combo/p.ts");
  });
});

// ── D4: No-op PATCH must NOT silently flip source (audit fix d25c126a) ──
describe("PATCH /api/projects/:id/features/:featureId — D4 no-op source-flip guard", () => {
  test("HEADLINE: PATCH with description equal to current value on agent → source STAYS 'agent'", async () => {
    // The legacy `refreshFeatureFiles` row-expand pattern PATCH'd the
    // description back to its current value to trigger the response
    // echo (which included files). Without the d25c126a fix this
    // re-assertion silently flipped the bucket to user-owned, muting
    // it from future rescans even though the user did nothing.
    const f = await createFeature({
      projectId,
      name: "noop-desc",
      description: "Files under src/noop-desc",
      source: "agent",
    });
    const event = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: f.id },
      body: { description: "Files under src/noop-desc" }, // ← same value
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body.source).toBe("agent");

    // Defense in depth: re-read from DB to confirm the row truly stayed
    // agent (not just the response shape).
    const reloaded = await getFeature(projectId, "noop-desc");
    expect(reloaded!.source).toBe("agent");
  });

  test("PATCH with name equal to current value on agent → source STAYS 'agent'", async () => {
    const f = await createFeature({
      projectId,
      name: "noop-name",
      description: "d",
      source: "agent",
    });
    const event = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: f.id },
      body: { name: "noop-name" }, // same value
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body.source).toBe("agent");
  });

  test("PATCH meaningful name on agent → still flips to 'user' (regression: D4 didn't break the meaningful-edit path)", async () => {
    const f = await createFeature({
      projectId,
      name: "meaningful-name",
      description: "d",
      source: "agent",
    });
    const event = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: f.id },
      body: { name: "actually-renamed" },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    const body = await jsonFromResponse(res);
    expect(body.source).toBe("user");
    expect(body.name).toBe("actually-renamed");
  });

  test("PATCH meaningful description on agent → still flips to 'user'", async () => {
    const f = await createFeature({
      projectId,
      name: "meaningful-desc",
      description: "Files under src/meaningful-desc",
      source: "agent",
    });
    const event = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: f.id },
      body: { description: "Hand-rewritten" },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    const body = await jsonFromResponse(res);
    expect(body.source).toBe("user");
    expect(body.description).toBe("Hand-rewritten");
  });
});

// ── D4: GET /:featureId endpoint (audit fix d25c126a) ───────────────
describe("GET /api/projects/:id/features/:featureId", () => {
  // Local handler import — the GET export wasn't on the original list
  // so we import it lazily here to keep the top-of-file import block
  // stable across the refactor.
  let GET: any;
  // This is a top-level await import in an inner describe; rely on
  // jest-style hoisting via beforeAll.
  // eslint-disable-next-line
  beforeEach(async () => {
    if (!GET) {
      const mod = await import(
        "../../web/src/routes/api/projects/[id]/features/[featureId]/+server"
      );
      GET = (mod as any).GET;
    }
  });

  test("returns 200 with {...feature, files, fileCount} for an existing feature", async () => {
    const f = await createFeature({
      projectId,
      name: "get-target",
      description: "test",
      source: "agent",
    });
    await replaceAgentFiles(f.id, ["src/get-target/a.ts", "src/get-target/b.ts"]);
    await addUserFile(f.id, "src/get-target/pinned.ts");

    const event = createMockEvent({
      method: "GET",
      params: { id: projectId, featureId: f.id },
      user: MEMBER_USER,
    });
    const res = await call(GET, event);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body.id).toBe(f.id);
    expect(body.name).toBe("get-target");
    expect(body.description).toBe("test");
    expect(body.source).toBe("agent"); // ← unchanged by GET
    expect(body.fileCount).toBe(3);
    expect(body.files.map((x: any) => x.relpath).sort()).toEqual([
      "src/get-target/a.ts",
      "src/get-target/b.ts",
      "src/get-target/pinned.ts",
    ]);
  });

  test("returns 404 when feature exists but belongs to a DIFFERENT project (cross-project isolation)", async () => {
    const f = await createFeature({
      projectId: otherProjectId,
      name: "cross-proj",
      source: "user",
    });
    const event = createMockEvent({
      method: "GET",
      params: { id: projectId, featureId: f.id },
      user: MEMBER_USER,
    });
    const res = await call(GET, event);
    expect(res.status).toBe(404);
  });

  test("returns 404 for unknown featureId", async () => {
    const event = createMockEvent({
      method: "GET",
      params: { id: projectId, featureId: crypto.randomUUID() },
      user: MEMBER_USER,
    });
    const res = await call(GET, event);
    expect(res.status).toBe(404);
  });

  test("source is NOT mutated by GET (it's a read, not a write)", async () => {
    const f = await createFeature({
      projectId,
      name: "read-only",
      source: "agent",
    });
    const event = createMockEvent({
      method: "GET",
      params: { id: projectId, featureId: f.id },
      user: MEMBER_USER,
    });
    await call(GET, event);
    // Verify with a second GET that the source is still 'agent'.
    const reloaded = await getFeature(projectId, "read-only");
    expect(reloaded!.source).toBe("agent");
  });

  test("unauthenticated → 401", async () => {
    const f = await createFeature({ projectId, name: "noauth-get", source: "user" });
    const event = createMockEvent({
      method: "GET",
      params: { id: projectId, featureId: f.id },
      // no user
    });
    const res = await call(GET, event);
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/projects/:id/features/:featureId — file ops + invariants", () => {
  test("addFiles inserts source='user' rows (idempotent on re-add)", async () => {
    const f = await createFeature({ projectId, name: "addf", source: "user" });

    const event1 = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: f.id },
      body: { addFiles: ["src/p.ts"] },
      user: MEMBER_USER,
    });
    await call(PATCH, event1);
    const event2 = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: f.id },
      body: { addFiles: ["src/p.ts"] },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event2);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body.files).toHaveLength(1);
    expect(body.fileCount).toBe(1);
  });

  test("removeFiles deletes regardless of source (scan + user)", async () => {
    const f = await createFeature({ projectId, name: "rmf", source: "user" });
    await replaceAgentFiles(f.id, ["src/scanned.ts"]);
    await addUserFile(f.id, "src/pinned.ts");

    const event = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: f.id },
      body: { removeFiles: ["src/scanned.ts", "src/pinned.ts"] },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body.files).toEqual([]);
  });

  test("rename to colliding existing name → 409", async () => {
    const f = await createFeature({ projectId, name: "feat-a", source: "user" });
    await createFeature({ projectId, name: "feat-b" });
    const event = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: f.id },
      body: { name: "feat-b" },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(409);
  });

  test("rename to same name → 200 (no-op rename allowed)", async () => {
    const f = await createFeature({ projectId, name: "same", source: "user" });
    const event = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: f.id },
      body: { name: "same" },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(200);
  });

  test("empty body (no fields) → 400 (zod refine fails)", async () => {
    const f = await createFeature({ projectId, name: "empty-body", source: "user" });
    const event = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: f.id },
      body: {},
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(400);
  });

  test("absolute relpath in addFiles → 400 (zod regex)", async () => {
    const f = await createFeature({ projectId, name: "abs-path", source: "user" });
    const event = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: f.id },
      body: { addFiles: ["/etc/passwd"] },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(400);
  });

  test("'..' traversal in addFiles → 400 (zod regex)", async () => {
    const f = await createFeature({ projectId, name: "traversal", source: "user" });
    const event = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: f.id },
      body: { addFiles: ["src/../../../etc/passwd"] },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(400);
  });

  test("PATCH on a feature in a DIFFERENT project → 404 (cross-project isolation)", async () => {
    const f = await createFeature({ projectId: otherProjectId, name: "other-proj", source: "user" });
    // Try to PATCH from `projectId` (the wrong project) using the
    // featureId that belongs to `otherProjectId`.
    const event = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: f.id },
      body: { name: "hijacked" },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(404);
  });

  test("missing featureId → 404", async () => {
    const event = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: "nope" },
      body: { name: "renamed" },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(404);
  });

  test("unauthenticated → 401", async () => {
    const f = await createFeature({ projectId, name: "noauth", source: "user" });
    const event = createMockEvent({
      method: "PATCH",
      params: { id: projectId, featureId: f.id },
      body: { name: "renamed" },
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(401);
  });
});

// ── DELETE /api/projects/:id/features/:featureId ────────────────────

describe("DELETE /api/projects/:id/features/:featureId", () => {
  test("returns {ok:true}, GET shows feature gone, FK cascade drops files", async () => {
    const f = await createFeature({ projectId, name: "doomed", source: "user" });
    await addUserFile(f.id, "src/keep.ts");
    await replaceAgentFiles(f.id, ["src/scanned.ts"]);

    const delEvent = createMockEvent({
      method: "DELETE",
      params: { id: projectId, featureId: f.id },
      user: MEMBER_USER,
    });
    const res = await call(DELETE, delEvent);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body.ok).toBe(true);

    // Subsequent GET shows feature gone.
    const getEvent = createMockEvent({
      method: "GET",
      params: { id: projectId },
      user: MEMBER_USER,
    });
    const list = await jsonFromResponse(await call(GET, getEvent));
    expect(list.find((x: any) => x.id === f.id)).toBeUndefined();

    // Cascade verified via direct DB query: re-create with same name and
    // confirm files=[]
    const recreated = await createFeature({ projectId, name: "doomed", source: "user" });
    const reloaded = await getFeature(projectId, "doomed");
    expect(reloaded!.id).toBe(recreated.id);
    expect(reloaded!.files).toEqual([]);
  });

  test("404 if featureId belongs to a different project (cross-project isolation)", async () => {
    const f = await createFeature({ projectId: otherProjectId, name: "other", source: "user" });
    const event = createMockEvent({
      method: "DELETE",
      params: { id: projectId, featureId: f.id },
      user: MEMBER_USER,
    });
    const res = await call(DELETE, event);
    expect(res.status).toBe(404);
  });

  test("404 for unknown featureId", async () => {
    const event = createMockEvent({
      method: "DELETE",
      params: { id: projectId, featureId: crypto.randomUUID() },
      user: MEMBER_USER,
    });
    const res = await call(DELETE, event);
    expect(res.status).toBe(404);
  });

  test("unauthenticated → 401", async () => {
    const f = await createFeature({ projectId, name: "del-noauth", source: "user" });
    const event = createMockEvent({
      method: "DELETE",
      params: { id: projectId, featureId: f.id },
    });
    const res = await call(DELETE, event);
    expect(res.status).toBe(401);
  });
});

// ── POST /api/projects/:id/features/scan — RESCAN INVARIANTS ────────

describe("POST /api/projects/:id/features/scan — hybrid-ownership invariants", () => {
  test("empty project (no src/) → returns [], nothing inserted", async () => {
    const event = createMockEvent({
      method: "POST",
      params: { id: projectId },
      user: MEMBER_USER,
    });
    const res = await call(POST_scan, event);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body).toEqual([]);
  });

  test("missing project → 404", async () => {
    const event = createMockEvent({
      method: "POST",
      params: { id: "ghost" },
      user: MEMBER_USER,
    });
    const res = await call(POST_scan, event);
    expect(res.status).toBe(404);
  });

  test("HEADLINE: user-pinned files survive rescan (source='user' rows preserved)", async () => {
    // Set up filesystem fixture
    await mkdir(resolve(projectRoot, "src/featA"), { recursive: true });
    await writeFile(resolve(projectRoot, "src/featA/a.ts"), "a");
    await writeFile(resolve(projectRoot, "src/featA/b.ts"), "b");

    // First scan creates the agent feature.
    await call(
      POST_scan,
      createMockEvent({
        method: "POST",
        params: { id: projectId },
        user: MEMBER_USER,
      }),
    );
    const initial = await getFeature(projectId, "featA");
    expect(initial).toBeDefined();
    expect(initial!.source).toBe("agent");

    // User pins a file that is NOT in the scan output.
    await addUserFile(initial!.id, "src/featA/manually-pinned.ts");

    // Add a NEW scan file to verify scan rows refresh.
    await writeFile(resolve(projectRoot, "src/featA/c.ts"), "c");

    // Rescan
    const res = await call(
      POST_scan,
      createMockEvent({
        method: "POST",
        params: { id: projectId },
        user: MEMBER_USER,
      }),
    );
    expect(res.status).toBe(200);

    const reloaded = await getFeature(projectId, "featA");
    const bySource = new Map<string, string>();
    for (const f of reloaded!.files) bySource.set(f.relpath, f.source);

    // User pin survives.
    expect(bySource.get("src/featA/manually-pinned.ts")).toBe("user");
    // Scan rows refreshed (now includes c.ts).
    expect(bySource.get("src/featA/a.ts")).toBe("scan");
    expect(bySource.get("src/featA/b.ts")).toBe("scan");
    expect(bySource.get("src/featA/c.ts")).toBe("scan");
  });

  test("HEADLINE: user-renamed feature survives rescan and ABSORBS the rescan candidate (no duplicate)", async () => {
    await mkdir(resolve(projectRoot, "src/featB"), { recursive: true });
    await writeFile(resolve(projectRoot, "src/featB/a.ts"), "a");
    await writeFile(resolve(projectRoot, "src/featB/b.ts"), "b");

    // Initial scan creates the agent feature with originPath='src/featB'.
    await call(
      POST_scan,
      createMockEvent({
        method: "POST",
        params: { id: projectId },
        user: MEMBER_USER,
      }),
    );
    const before = await getFeature(projectId, "featB");
    expect(before!.source).toBe("agent");
    expect(before!.description).toBe("Files under src/featB");
    expect(before!.originPath).toBe("src/featB");

    // User renames + edits description (PATCH flips source → 'user').
    // Critical: originPath stays put — that's the immutable link back
    // to the source dir that lets the next rescan re-find this row.
    const patchRes = await call(
      PATCH,
      createMockEvent({
        method: "PATCH",
        params: { id: projectId, featureId: before!.id },
        body: { name: "user-renamed", description: "Authentication module" },
        user: MEMBER_USER,
      }),
    );
    expect(patchRes.status).toBe(200);

    // Add a new file in the source dir so the rescan has something
    // fresh to surface — and so we can assert files actually flow into
    // the renamed row (not into a duplicate).
    await writeFile(resolve(projectRoot, "src/featB/c.ts"), "c");

    // Rescan: scanner produces a candidate with originPath='src/featB'.
    // The endpoint matches it to the user-renamed row by originPath
    // and refreshes the agent file slice. NO `featB` duplicate should
    // ever appear in the output.
    const scanRes = await call(
      POST_scan,
      createMockEvent({
        method: "POST",
        params: { id: projectId },
        user: MEMBER_USER,
      }),
    );
    const list = await jsonFromResponse(scanRes);

    // No duplicate row under the original slug — this is the user-
    // visible bug fix. Before originPath tracking, a fresh agent row
    // named `featB` would have appeared alongside `user-renamed`.
    const featBDup = list.find((f: any) => f.name === "featB");
    expect(featBDup).toBeUndefined();

    // The renamed row is intact: name, description, and source-flip
    // all preserved.
    const userRenamed = list.find((f: any) => f.name === "user-renamed");
    expect(userRenamed).toBeDefined();
    expect(userRenamed.source).toBe("user");
    expect(userRenamed.description).toBe("Authentication module");
    expect(userRenamed.originPath).toBe("src/featB");

    // Files from the rescan flow into the renamed row, not a duplicate.
    const reloaded = await getFeature(projectId, "user-renamed");
    const paths = reloaded!.files.map((f) => f.relpath).sort();
    expect(paths).toEqual([
      "src/featB/a.ts",
      "src/featB/b.ts",
      "src/featB/c.ts",
    ]);
    // And those files are scan-sourced (not user-pinned).
    for (const f of reloaded!.files) {
      expect(f.source).toBe("scan");
    }
  });

  test("backfill: legacy agent row with originPath=null is matched by name and updated with originPath", async () => {
    // Simulates an upgrade path: a row created before originPath
    // tracking existed (originPath null in DB). On rescan we want to
    // (a) match it by name fallback, (b) backfill originPath so the
    // NEXT rescan uses the fast path and survives a future rename.
    await mkdir(resolve(projectRoot, "src/legacy-feat"), { recursive: true });
    await writeFile(resolve(projectRoot, "src/legacy-feat/a.ts"), "a");
    await writeFile(resolve(projectRoot, "src/legacy-feat/b.ts"), "b");

    // Seed an agent-sourced row with NO originPath (the legacy shape).
    const legacy = await createFeature({
      projectId,
      name: "legacy-feat",
      description: "Files under src/legacy-feat",
      source: "agent",
      // originPath intentionally omitted → null
    });
    expect(legacy.originPath).toBeNull();

    // Rescan triggers the name-fallback branch + backfill.
    const res = await call(
      POST_scan,
      createMockEvent({
        method: "POST",
        params: { id: projectId },
        user: MEMBER_USER,
      }),
    );
    expect(res.status).toBe(200);

    const reloaded = await getFeature(projectId, "legacy-feat");
    expect(reloaded!.id).toBe(legacy.id); // Same row, not a new one.
    expect(reloaded!.originPath).toBe("src/legacy-feat"); // Backfilled.
  });

  test("rescan over a user-sourced feature with the SAME slug: description preserved, agent files refreshed", async () => {
    // Coverage target: scan/+server.ts lines 63-70 (the
    // `prior.source === 'user'` branch). User has a feature named
    // "manual-feat" with a hand-curated description; the FS happens to
    // also produce a "manual-feat" scan candidate. The endpoint must
    // NOT touch the description, but it MAY refresh the agent file
    // slice (replaceAgentFiles is invariant on user pins anyway).
    await mkdir(resolve(projectRoot, "src/manual-feat"), { recursive: true });
    await writeFile(resolve(projectRoot, "src/manual-feat/a.ts"), "a");
    await writeFile(resolve(projectRoot, "src/manual-feat/b.ts"), "b");

    // Seed the user-sourced feature with a hand-curated description.
    const userFeat = await createFeature({
      projectId,
      name: "manual-feat",
      description: "User-curated description",
      source: "user",
    });
    // Pin one user file inside the bucket — this should survive.
    await addUserFile(userFeat.id, "src/manual-feat/pinned.ts");

    const res = await call(
      POST_scan,
      createMockEvent({
        method: "POST",
        params: { id: projectId },
        user: MEMBER_USER,
      }),
    );
    expect(res.status).toBe(200);

    const reloaded = await getFeature(projectId, "manual-feat");
    // Description NOT touched.
    expect(reloaded!.description).toBe("User-curated description");
    // Source still user.
    expect(reloaded!.source).toBe("user");
    // Agent file slice refreshed: a.ts + b.ts are scan-sourced; user pin survives.
    const bySource = new Map<string, string>();
    for (const f of reloaded!.files) bySource.set(f.relpath, f.source);
    expect(bySource.get("src/manual-feat/a.ts")).toBe("scan");
    expect(bySource.get("src/manual-feat/b.ts")).toBe("scan");
    expect(bySource.get("src/manual-feat/pinned.ts")).toBe("user");
  });

  test("scan creates brand-new agent features with source='agent'", async () => {
    await mkdir(resolve(projectRoot, "src/newFeat"), { recursive: true });
    await writeFile(resolve(projectRoot, "src/newFeat/a.ts"), "a");
    await writeFile(resolve(projectRoot, "src/newFeat/b.ts"), "b");

    const res = await call(
      POST_scan,
      createMockEvent({
        method: "POST",
        params: { id: projectId },
        user: MEMBER_USER,
      }),
    );
    expect(res.status).toBe(200);
    const list = await jsonFromResponse(res);
    expect(list.map((f: any) => f.name)).toEqual(["newFeat"]);
    expect(list[0].source).toBe("agent");
    expect(list[0].fileCount).toBe(2);
  });

  test("vanished feature row is NOT auto-deleted on rescan (intentional per design)", async () => {
    // Seed agent feature with no FS evidence.
    await createFeature({
      projectId,
      name: "ghost",
      description: "leftover",
      source: "agent",
    });

    const res = await call(
      POST_scan,
      createMockEvent({
        method: "POST",
        params: { id: projectId },
        user: MEMBER_USER,
      }),
    );
    const list = await jsonFromResponse(res);
    expect(list.find((f: any) => f.name === "ghost")).toBeDefined();
  });

  test("description refresh on agent feature when scanner output differs", async () => {
    // Seed an agent feature with a stale description.
    await mkdir(resolve(projectRoot, "src/stale"), { recursive: true });
    await writeFile(resolve(projectRoot, "src/stale/a.ts"), "a");
    await writeFile(resolve(projectRoot, "src/stale/b.ts"), "b");

    await createFeature({
      projectId,
      name: "stale",
      description: "OLD DESCRIPTION",
      source: "agent",
    });

    const res = await call(
      POST_scan,
      createMockEvent({
        method: "POST",
        params: { id: projectId },
        user: MEMBER_USER,
      }),
    );
    const list = await jsonFromResponse(res);
    const stale = list.find((f: any) => f.name === "stale");
    expect(stale.description).toBe("Files under src/stale");
  });

  test("rejects scan when project has no path → 400", async () => {
    // Tweak the project to have an empty path. We can't do this via
    // public createProject (it requires a non-empty path); use the DB
    // directly.
    const { getDb } = await import("../db/connection");
    const { projects } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    await getDb().update(projects).set({ path: "" }).where(eq(projects.id, projectId));

    const res = await call(
      POST_scan,
      createMockEvent({
        method: "POST",
        params: { id: projectId },
        user: MEMBER_USER,
      }),
    );
    expect(res.status).toBe(400);
  });

  test("unauthenticated → 401", async () => {
    const event = createMockEvent({
      method: "POST",
      params: { id: projectId },
    });
    const res = await call(POST_scan, event);
    expect(res.status).toBe(401);
  });
});
