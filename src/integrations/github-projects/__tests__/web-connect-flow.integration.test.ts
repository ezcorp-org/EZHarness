/**
 * Integration test: the github-projects connect → store → get → pause →
 * disconnect lifecycle against a REAL PGlite database, with ONLY the GitHub
 * client mocked. Proves the security-critical guarantees end to end:
 *
 *   - the PAT is stored ENCRYPTED at rest in the scope-isolated secrets store
 *     (the `extension_secrets` row holds AAD-bound ciphertext, never the
 *     plaintext, and `decryptWithAad` round-trips it under the right scope),
 *   - the link row carries the resolved board metadata,
 *   - pause (enabled=false) keeps the board + token but flips the flag,
 *   - disconnect PURGES the stored token, CANCELS active proposals, and DROPS
 *     the link.
 *
 * The route handlers are exercised directly (the same code the HTTP layer
 * calls), so this is a true integration of handler ⇄ queries ⇄ secrets store ⇄
 * DB.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../../__tests__/helpers/mock-cleanup";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
  getTestDb,
} from "../../../__tests__/helpers/test-pglite";
import { extensions } from "../../../db/schema";
import { sql } from "drizzle-orm";

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
mock.module("$server/extensions/secrets-store", () => require("../../../extensions/secrets-store"));
mock.module("$server/integrations/github-projects/client", () => require("../client"));
mock.module("$server/integrations/github-projects/spawn", () => require("../spawn"));
mock.module("$server/integrations/github-projects/types", () => require("../types"));
mock.module("$server/integrations/github-projects/bus-registry", () => require("../bus-registry"));
mock.module("$server/logger", () => require("../../../logger"));

// Real query modules + helpers (DB-backed via mockDbConnection).
const { createProject } = await import("../../../db/queries/projects");
const { createUser } = await import("../../../db/queries/users");
// The host-only secrets store: read the stored PAT plaintext for assertions.
const { getSecret } = await import("../../../extensions/secrets-store");
const { getSecretRow } = await import("../../../db/queries/extension-secrets");
const { decryptWithAad } = await import("../../../providers/encryption");
const { getLinkByProjectId, insertProposalIfNew, getProposalById } = await import(
  "../../../db/queries/github-projects"
);
const { githubProposalDedupeKey } = await import("../types");

const GH_EXT = "github-projects";
/** Read the raw stored secret row for the project's PAT (host-only). */
async function patSecretRow(pid: string) {
  return getSecretRow({ extensionId: GH_EXT, projectId: pid, userId: null, name: "apiToken" });
}

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
  // `extension_secrets.extension_id` FKs `extensions.name` — seed the bundled
  // github-projects extension row so the store's INSERT has its FK parent.
  await getTestDb().insert(extensions).values({
    name: GH_EXT,
    version: "1.0.0",
    source: "test:fixture",
    manifest: sql`${JSON.stringify({
      schemaVersion: 2,
      name: GH_EXT,
      version: "1.0.0",
      description: "",
      author: { name: "test" },
      kind: "subprocess",
      entrypoint: { command: ["true"] },
    })}::jsonb`,
  });
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

    // The stored secret row is AAD-bound CIPHERTEXT (not the plaintext) and
    // decrypts back only under the github-projects + project scope.
    const row = await patSecretRow(projectId);
    expect(row).toBeDefined();
    expect(row!.ciphertext).not.toContain(secret);
    expect(decryptWithAad(row!.ciphertext, `${GH_EXT}:${projectId}`)).toBe(secret);
    // The host-only store read returns the plaintext.
    expect(await getSecret(GH_EXT, projectId, "apiToken")).toBe(secret);

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
    expect(await getSecret(GH_EXT, projectId, "apiToken")).toBeNull();
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
    expect(await getSecret(GH_EXT, projectId, "apiToken")).toBe("tok");
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
    expect(await getSecret(GH_EXT, projectId, "apiToken")).toBeNull();
    // Link dropped.
    expect(await getLinkByProjectId(projectId)).toBeNull();
    // Proposal CASCADE-deleted with the link (link delete cascades proposals).
    expect(await getProposalById(proposal!.id)).toBeNull();
  });

  test("connect persists the board's status options so the column editor survives a reload (named + complete)", async () => {
    // The mocked board has TWO columns: Todo + Doing.
    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "tok" } }));

    // Map ONLY one of them (Doing). Before the fix, a reload then rendered just
    // this one column keyed by its bare option id ("opt-doing") shown AS the
    // name, and the unmapped column (Todo) vanished — because the editor fell
    // back to Object.keys(columnActionMap).
    const patchRes = await linkPatch(
      ev("PATCH", {
        body: { projectId, columnActionMap: { "opt-doing": { action: "plan", autoSpawn: false } } },
      }),
    );
    expect(patchRes.status).toBe(200);

    // A fresh GET is exactly what the page's loadLink() does after a reload. It
    // MUST carry the board's FULL, NAMED column list (the data the editor
    // renders), independent of which columns happen to be mapped.
    const getRes = await linkGet(ev("GET", { url: `http://localhost/x?projectId=${projectId}` }));
    expect(getRes.status).toBe(200);
    const { link } = await getRes.json();
    expect(link.statusOptions).toEqual([
      { id: "opt-todo", name: "Todo" },
      { id: "opt-doing", name: "Doing" },
    ]);
    // Pin the exact symptoms the bug exhibited:
    //   1) COMPLETE — both columns present even though only one is mapped.
    expect(link.statusOptions).toHaveLength(2);
    expect(Object.keys(link.columnActionMap)).toEqual(["opt-doing"]);
    //   2) NAMED — every column has a human name, never its raw option id.
    expect(link.statusOptions.map((o: { name: string }) => o.name)).toEqual(["Todo", "Doing"]);
    expect(link.statusOptions.every((o: { id: string; name: string }) => o.name !== o.id)).toBe(true);
  });

  test("defaultModel round-trips: PATCH sets it, GET/publicLinkView returns it; null clears it", async () => {
    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "tok" } }));

    // A fresh connect leaves defaultModel null (the instance default).
    const initial = await linkGet(ev("GET", { url: `http://localhost/x?projectId=${projectId}` }));
    expect((await initial.json()).link.defaultModel).toBeNull();

    // PATCH a valid "<provider>:<model>" — the public view echoes it back.
    const setRes = await linkPatch(
      ev("PATCH", { body: { projectId, defaultModel: "anthropic:claude-opus-4-20250514" } }),
    );
    expect(setRes.status).toBe(200);
    expect((await setRes.json()).link.defaultModel).toBe("anthropic:claude-opus-4-20250514");

    // It persisted: a fresh GET (what the page's loadLink does) carries it.
    const afterSet = await linkGet(ev("GET", { url: `http://localhost/x?projectId=${projectId}` }));
    expect((await afterSet.json()).link.defaultModel).toBe("anthropic:claude-opus-4-20250514");
    // The DB row itself holds the raw string.
    expect((await getLinkByProjectId(projectId))?.defaultModel).toBe("anthropic:claude-opus-4-20250514");

    // PATCH null clears it back to the instance default.
    const clearRes = await linkPatch(ev("PATCH", { body: { projectId, defaultModel: null } }));
    expect(clearRes.status).toBe(200);
    expect((await clearRes.json()).link.defaultModel).toBeNull();
    expect((await getLinkByProjectId(projectId))?.defaultModel).toBeNull();
  });

  test("re-connect refreshes the persisted status options", async () => {
    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "tok" } }));
    const link = await getLinkByProjectId(projectId);
    expect(link?.statusOptions).toEqual([
      { id: "opt-todo", name: "Todo" },
      { id: "opt-doing", name: "Doing" },
    ]);
  });

  test("re-connect from pat → gh purges the stale encrypted PAT", async () => {
    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "tok" } }));
    expect(await getSecret(GH_EXT, projectId, "apiToken")).toBe("tok");

    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "gh" } }));
    // The stale PAT is gone; the link is now gh-mode.
    expect(await getSecret(GH_EXT, projectId, "apiToken")).toBeNull();
    expect((await getLinkByProjectId(projectId))?.authMode).toBe("gh");
  });
});
