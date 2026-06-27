/**
 * Integration test: the github-projects connect → store → get → pause →
 * disconnect lifecycle against a REAL PGlite database, with ONLY the GitHub
 * client mocked. Proves the security-critical guarantees end to end:
 *
 *   - the PAT is stored ENCRYPTED at rest (the settings row never holds the
 *     plaintext, and `decrypt()` round-trips it),
 *   - the link row carries the resolved board metadata,
 *   - pause (enabled=false) keeps the board + token but flips the flag,
 *   - disconnect PURGES the token setting, CANCELS active proposals, and DROPS
 *     the link.
 *
 * The route handlers are exercised directly (the same code the HTTP layer
 * calls), so this is a true integration of handler ⇄ queries ⇄ encryption ⇄ DB.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../../__tests__/helpers/mock-cleanup";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
} from "../../../__tests__/helpers/test-pglite";

// Real DB-backed connection for every query module under test.
mockDbConnection();

// Mock ONLY the GitHub client (the single egress) — everything else is real.
let validationResult = { ok: true, scopes: ["repo", "project"], missingScopes: [] as string[] };
mock.module("../client", () => ({
  createGithubClient: () => ({
    resolveBoardFromUrl: async () => ({
      boardNodeId: "PVT_kanban",
      title: "Team Kanban",
      ownerLogin: "acme",
      statusFieldId: "FIELD_status",
      statusOptions: [
        { id: "opt-todo", name: "Todo" },
        { id: "opt-doing", name: "Doing" },
      ],
    }),
    validateAuth: async () => validationResult,
  }),
}));

// Mock the bus-registry so the handler's emit is a no-op (no web bus here).
mock.module("../bus-registry", () => ({
  getGithubProjectsEmit: () => undefined,
}));

// Stub the SvelteKit `$lib/server/*` aliases the handlers import. The real
// http-errors / api-keys live in web/; re-implement the tiny surface inline so
// this src-side integration test doesn't reach across into the web tree.
mock.module("$lib/server/http-errors", () => ({
  errorJson: (status: number, message: string, details?: Record<string, unknown>) =>
    new Response(JSON.stringify(details ? { error: message, ...details } : { error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
}));
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null, // cookie-style: allow
}));
mock.module("$server/auth/middleware", () => require("../../../auth/middleware"));
mock.module("$server/db/queries/projects", () => require("../../../db/queries/projects"));
mock.module("$server/db/queries/github-projects", () => require("../../../db/queries/github-projects"));
mock.module("$server/db/queries/settings", () => require("../../../db/queries/settings"));
mock.module("$server/providers/encryption", () => require("../../../providers/encryption"));
mock.module("$server/integrations/github-projects/client", () => require("../client"));
mock.module("$server/integrations/github-projects/spawn", () => require("../spawn"));
mock.module("$server/integrations/github-projects/types", () => require("../types"));
mock.module("$server/integrations/github-projects/bus-registry", () => require("../bus-registry"));
mock.module("$server/logger", () => require("../../../logger"));

// Real query modules + helpers (DB-backed via mockDbConnection).
const { createProject } = await import("../../../db/queries/projects");
const { createUser } = await import("../../../db/queries/users");
const { getSetting } = await import("../../../db/queries/settings");
const { getLinkByProjectId, insertProposalIfNew, getProposalById } = await import(
  "../../../db/queries/github-projects"
);
const { decrypt } = await import("../../../providers/encryption");
const { githubTokenSettingKey, githubProposalDedupeKey } = await import("../types");

// Route handlers (the code the HTTP layer runs).
const { POST: connect } = await import(
  "../../../../web/src/routes/api/integrations/github-projects/connect/+server"
);
const { GET: linkGet, PATCH: linkPatch, DELETE: linkDelete } = await import(
  "../../../../web/src/routes/api/integrations/github-projects/link/+server"
);

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

const USER = { id: "user-1", email: "u@test.local", name: "U", role: "member" as const };

function ev(method: string, opts: { body?: unknown; url?: string } = {}) {
  const url = new URL(opts.url ?? "http://localhost/api/integrations/github-projects/link");
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (opts.body !== undefined && method !== "GET") init.body = JSON.stringify(opts.body);
  return {
    request: new Request(url.toString(), init),
    url,
    params: {},
    locals: { user: USER },
  } as any;
}

let projectId: string;

beforeEach(async () => {
  await setupTestDb();
  validationResult = { ok: true, scopes: ["repo", "project"], missingScopes: [] };
  // The link's created_by_user_id FKs users.id — seed the acting user.
  await createUser({ id: USER.id, email: USER.email, passwordHash: "x", name: USER.name, role: USER.role });
  const proj = await createProject({ name: "Integ Project", path: "/tmp/integ" });
  projectId = proj.id;
});

describe("github-projects connect lifecycle (real DB)", () => {
  test("connect (pat) stores the token ENCRYPTED at rest + writes the link", async () => {
    const secret = "github_pat_supersecret_value";
    const res = await connect(
      ev("POST", { body: { projectId, boardUrl: "https://github.com/orgs/acme/projects/1", authMode: "pat", token: secret } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.boardTitle).toBe("Team Kanban");
    // The response NEVER contains the plaintext token.
    expect(JSON.stringify(body)).not.toContain(secret);

    // The settings row is CIPHERTEXT (not the plaintext) and decrypts back.
    const stored = (await getSetting(githubTokenSettingKey(projectId))) as string;
    expect(stored).toBeDefined();
    expect(stored).not.toContain(secret);
    expect(stored).toMatch(/^v1:/); // encryption format tag
    expect(decrypt(stored)).toBe(secret);

    // The link row carries the resolved board metadata.
    const link = await getLinkByProjectId(projectId);
    expect(link?.boardNodeId).toBe("PVT_kanban");
    expect(link?.boardTitle).toBe("Team Kanban");
    expect(link?.authMode).toBe("pat");
    expect(link?.enabled).toBe(true);
    expect(link?.createdByUserId).toBe(USER.id);
  });

  test("missing scopes → 403 and NOTHING is persisted", async () => {
    validationResult = { ok: false, scopes: ["repo"], missingScopes: ["project"] };
    const res = await connect(
      ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "t" } }),
    );
    expect(res.status).toBe(403);
    expect(await getSetting(githubTokenSettingKey(projectId))).toBeUndefined();
    expect(await getLinkByProjectId(projectId)).toBeNull();
  });

  test("GET reflects the connection, then PATCH pause flips enabled (token retained)", async () => {
    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "tok" } }));

    const getRes = await linkGet(ev("GET", { url: `http://localhost/x?projectId=${projectId}` }));
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.link.enabled).toBe(true);
    // The link view exposes NO token field.
    expect(getBody.link).not.toHaveProperty("token");

    const patchRes = await linkPatch(ev("PATCH", { body: { projectId, enabled: false } }));
    expect(patchRes.status).toBe(200);
    const link = await getLinkByProjectId(projectId);
    expect(link?.enabled).toBe(false);
    // Pause keeps the credential.
    expect(await getSetting(githubTokenSettingKey(projectId))).toBeDefined();
  });

  test("disconnect PURGES the token, CANCELS active proposals, and DROPS the link", async () => {
    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "tok" } }));
    const link = await getLinkByProjectId(projectId);
    expect(link).not.toBeNull();

    // Seed an active proposal so we can prove it gets cancelled.
    const proposal = await insertProposalIfNew({
      projectId,
      linkId: link!.id,
      itemNodeId: "item-1",
      statusOptionId: "opt-doing",
      statusName: "Doing",
      action: "plan",
      title: "Do the thing",
      dedupeKey: githubProposalDedupeKey(projectId, "item-1", "opt-doing", "plan"),
      status: "pending",
    });
    expect(proposal).not.toBeNull();

    const res = await linkDelete(ev("DELETE", { body: { projectId } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.disconnected).toBe(true);
    expect(body.cancelledProposals).toBe(1);

    // Token purged.
    expect(await getSetting(githubTokenSettingKey(projectId))).toBeUndefined();
    // Link dropped.
    expect(await getLinkByProjectId(projectId)).toBeNull();
    // Proposal CASCADE-deleted with the link (link delete cascades proposals).
    expect(await getProposalById(proposal!.id)).toBeNull();
  });

  test("re-connect from pat → gh purges the stale encrypted PAT", async () => {
    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "tok" } }));
    expect(await getSetting(githubTokenSettingKey(projectId))).toBeDefined();

    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "gh" } }));
    // The stale PAT is gone; the link is now gh-mode.
    expect(await getSetting(githubTokenSettingKey(projectId))).toBeUndefined();
    expect((await getLinkByProjectId(projectId))?.authMode).toBe("gh");
  });
});
