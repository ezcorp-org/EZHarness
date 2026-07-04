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
// The board's current Status columns — mutable so a test can simulate the owner
// adding/renaming a column between connect and a later refresh.
let boardStatusOptions = [
  { id: "opt-todo", name: "Todo" },
  { id: "opt-doing", name: "Doing" },
];
mock.module("../client", () => ({
  createGithubClient: () => ({
    // Default to the single fixed board, but let the multi-board test connect
    // two DISTINCT boards via the `board-a`/`board-b` URL sentinels (a fixed id
    // would collide on UNIQUE(project, board)).
    resolveBoardFromUrl: async (url: string) => ({
      boardNodeId: url === "board-a" || url === "board-b" ? `PVT_${url}` : "PVT_kanban",
      title: "Team Kanban",
      ownerLogin: "acme",
      statusFieldId: "FIELD_status",
      statusOptions: boardStatusOptions,
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
// REAL extension-RBAC resolver + grants queries (DB-backed) — this is the
// integration proof of the deny-by-default enforcement on the routes.
mock.module("$server/auth/extension-rbac", () => require("../../../auth/extension-rbac"));
mock.module("$server/db/queries/projects", () => require("../../../db/queries/projects"));
mock.module("$server/db/queries/github-projects", () => require("../../../db/queries/github-projects"));
mock.module("$server/extensions/secrets-store", () => require("../../../extensions/secrets-store"));
mock.module("$server/integrations/github-projects/client", () => require("../client"));
mock.module("$server/integrations/github-projects/auth", () => require("../auth"));
mock.module("$server/integrations/github-projects/spawn", () => require("../spawn"));
mock.module("$server/integrations/github-projects/types", () => require("../types"));
mock.module("$server/integrations/github-projects/bus-registry", () => require("../bus-registry"));
mock.module("$server/logger", () => require("../../../logger"));

// Real query modules + helpers (DB-backed via mockDbConnection).
const { createProject } = await import("../../../db/queries/projects");
const { createUser } = await import("../../../db/queries/users");
// REAL RBAC grant rows — deny-by-default means the acting member needs them.
const { upsertGrant, getGrant, deleteGrant } = await import("../../../db/queries/extension-rbac");
// The host-only secrets store: read the stored PAT plaintext for assertions.
const { getSecret, setSecret, deleteSecret } = await import("../../../extensions/secrets-store");
const { boardTokenName, resolveLinkAuth } = await import("../auth");
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
const { POST: refreshColumns } = await import(
  "../../../../web/src/routes/api/integrations/github-projects/link/refresh-columns/+server"
);

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

const USER = { id: "user-1", email: "u@test.local", name: "U", role: "member" as const };

function ev(method: string, opts: { body?: unknown; url?: string; user?: typeof USER } = {}) {
  const url = new URL(opts.url ?? "http://localhost/api/integrations/github-projects/link");
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (opts.body !== undefined && method !== "GET") init.body = JSON.stringify(opts.body);
  return {
    request: new Request(url.toString(), init),
    url,
    params: {},
    locals: { user: opts.user ?? USER },
  } as any;
}

let projectId: string;

beforeEach(async () => {
  await setupTestDb();
  validationResult = { ok: true, scopes: ["repo", "project"], missingScopes: [] };
  boardStatusOptions = [
    { id: "opt-todo", name: "Todo" },
    { id: "opt-doing", name: "Doing" },
  ];
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
  // Deny-by-default RBAC: give the acting MEMBER an extension-scoped,
  // NULL-project grant (github-projects across ALL projects) covering every
  // scope the lifecycle tests exercise. Seeded AFTER the extensions row —
  // `extension_rbac_grants.extension_id` FKs `extensions.name`.
  await upsertGrant({
    userId: USER.id,
    projectId: null,
    extensionId: GH_EXT,
    scopes: ["use", "configure", "secrets", "approve-runs"],
    grantedByUserId: null,
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

  test("malformed defaultModel → 400 (validated before board resolution), nothing persisted", async () => {
    const res = await connect(
      ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "t", defaultModel: "noprovider" } }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("provider");
    // Fast-fail is BEFORE token/board resolution — nothing persists.
    expect(await getSecret(GH_EXT, projectId, "apiToken")).toBeNull();
    expect(await getLinkByProjectId(projectId)).toBeNull();
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

  test("GET reflects the connection (array), then PATCH pause flips enabled (token retained)", async () => {
    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "tok" } }));
    const linkId = (await getLinkByProjectId(projectId))!.id;

    const getRes = await linkGet(ev("GET", { url: `http://localhost/x?projectId=${projectId}` }));
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.links).toHaveLength(1);
    expect(getBody.links[0].enabled).toBe(true);
    expect(getBody.links[0].hasTokenOverride).toBe(false); // shared token
    // The link view exposes NO token field.
    expect(getBody.links[0]).not.toHaveProperty("token");

    const patchRes = await linkPatch(ev("PATCH", { body: { projectId, linkId, enabled: false } }));
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

    const res = await linkDelete(ev("DELETE", { body: { projectId, linkId: link!.id } }));
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
    const linkId = (await getLinkByProjectId(projectId))!.id;

    // Map ONLY one of them (Doing). Before the fix, a reload then rendered just
    // this one column keyed by its bare option id ("opt-doing") shown AS the
    // name, and the unmapped column (Todo) vanished — because the editor fell
    // back to Object.keys(columnActionMap).
    const patchRes = await linkPatch(
      ev("PATCH", {
        body: { projectId, linkId, columnActionMap: { "opt-doing": { action: "plan", autoSpawn: false } } },
      }),
    );
    expect(patchRes.status).toBe(200);

    // A fresh GET is exactly what the page's loadLinks() does after a reload. It
    // MUST carry the board's FULL, NAMED column list (the data the editor
    // renders), independent of which columns happen to be mapped.
    const getRes = await linkGet(ev("GET", { url: `http://localhost/x?projectId=${projectId}` }));
    expect(getRes.status).toBe(200);
    const link = (await getRes.json()).links[0];
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
    const linkId = (await getLinkByProjectId(projectId))!.id;

    // A fresh connect leaves defaultModel null (the instance default).
    const initial = await linkGet(ev("GET", { url: `http://localhost/x?projectId=${projectId}` }));
    expect((await initial.json()).links[0].defaultModel).toBeNull();

    // PATCH a valid "<provider>:<model>" — the public view echoes it back.
    const setRes = await linkPatch(
      ev("PATCH", { body: { projectId, linkId, defaultModel: "anthropic:claude-opus-4-20250514" } }),
    );
    expect(setRes.status).toBe(200);
    expect((await setRes.json()).link.defaultModel).toBe("anthropic:claude-opus-4-20250514");

    // It persisted: a fresh GET (what the page's loadLinks does) carries it.
    const afterSet = await linkGet(ev("GET", { url: `http://localhost/x?projectId=${projectId}` }));
    expect((await afterSet.json()).links[0].defaultModel).toBe("anthropic:claude-opus-4-20250514");
    // The DB row itself holds the raw string.
    expect((await getLinkByProjectId(projectId))?.defaultModel).toBe("anthropic:claude-opus-4-20250514");

    // PATCH null clears it back to the instance default.
    const clearRes = await linkPatch(ev("PATCH", { body: { projectId, linkId, defaultModel: null } }));
    expect(clearRes.status).toBe(200);
    expect((await clearRes.json()).link.defaultModel).toBeNull();
    expect((await getLinkByProjectId(projectId))?.defaultModel).toBeNull();
  });

  test("defaultPermissionMode round-trips: connect → GET (null) → PATCH sets it → GET reflects it → null clears", async () => {
    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "tok" } }));
    const linkId = (await getLinkByProjectId(projectId))!.id;

    // A fresh connect (no permission mode given) leaves it null — the board
    // spawn bridge falls back to "yolo".
    const initial = await linkGet(ev("GET", { url: `http://localhost/x?projectId=${projectId}` }));
    expect((await initial.json()).links[0].defaultPermissionMode).toBeNull();

    // PATCH a valid runtime mode — the public view echoes it back + it persists.
    const setRes = await linkPatch(ev("PATCH", { body: { projectId, linkId, defaultPermissionMode: "auto-edit" } }));
    expect(setRes.status).toBe(200);
    expect((await setRes.json()).link.defaultPermissionMode).toBe("auto-edit");
    const afterSet = await linkGet(ev("GET", { url: `http://localhost/x?projectId=${projectId}` }));
    expect((await afterSet.json()).links[0].defaultPermissionMode).toBe("auto-edit");
    expect((await getLinkByProjectId(projectId))?.defaultPermissionMode).toBe("auto-edit");

    // PATCH null clears it back to the board's "yolo" fallback.
    const clearRes = await linkPatch(ev("PATCH", { body: { projectId, linkId, defaultPermissionMode: null } }));
    expect(clearRes.status).toBe(200);
    expect((await clearRes.json()).link.defaultPermissionMode).toBeNull();
    expect((await getLinkByProjectId(projectId))?.defaultPermissionMode).toBeNull();
  });

  test("invalid defaultPermissionMode → 400 (validated before board resolution), nothing persisted", async () => {
    const res = await connect(
      ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "t", defaultPermissionMode: "plan" } }),
    );
    expect(res.status).toBe(400);
    expect(await getLinkByProjectId(projectId)).toBeNull();
  });

  test("refresh-columns: re-fetches a legacy/empty link's columns host-side + persists them (no PAT re-entry)", async () => {
    // Connect stores the board (Todo + Doing) AND the encrypted PAT.
    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "tok" } }));
    const linkId = (await getLinkByProjectId(projectId))!.id;

    // Simulate the exact production bug: a link whose columns were never stored
    // (the migration backfilled status_options = '[]', which can't recover real
    // names). The editor would then show raw option-ids + drop unmapped columns.
    await getTestDb().execute(
      sql`UPDATE github_projects_links SET status_options = '[]'::jsonb WHERE project_id = ${projectId}`,
    );
    expect((await getLinkByProjectId(projectId))?.statusOptions).toEqual([]);

    // Meanwhile the board owner added a third column (Done) on GitHub.
    boardStatusOptions = [
      { id: "opt-todo", name: "Todo" },
      { id: "opt-doing", name: "Doing" },
      { id: "opt-done", name: "Done" },
    ];

    // Refresh resolves the credential HOST-SIDE (the stored PAT — never re-typed)
    // and re-reads the board. No token in the request body.
    const res = await refreshColumns(ev("POST", { body: { projectId, linkId } }));
    expect(res.status).toBe(200);
    const refreshed = await res.json();
    expect(refreshed.link.statusOptions).toEqual(boardStatusOptions);

    // It PERSISTED: a fresh GET (what the page's loadLinks does) carries the full,
    // named, COMPLETE column set — including the newly-added "Done".
    const getRes = await linkGet(ev("GET", { url: `http://localhost/x?projectId=${projectId}` }));
    const row = (await getRes.json()).links[0];
    expect(row.statusOptions).toHaveLength(3);
    expect(row.statusOptions.map((o: { name: string }) => o.name)).toEqual(["Todo", "Doing", "Done"]);
    // The DB row itself updated, including the resolved Status field id.
    const dbRow = await getLinkByProjectId(projectId);
    expect(dbRow?.statusOptions).toHaveLength(3);
    expect(dbRow?.statusFieldId).toBe("FIELD_status");
  });

  test("refresh-columns: no stored credential → 401 and the saved columns are left UNTOUCHED", async () => {
    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "tok" } }));
    const linkId = (await getLinkByProjectId(projectId))!.id;
    // Connect persisted the board's two columns.
    expect((await getLinkByProjectId(projectId))?.statusOptions).toHaveLength(2);

    // Purge the stored PAT so the host-side credential can no longer be resolved.
    await deleteSecret(GH_EXT, projectId, "apiToken");
    expect(await getSecret(GH_EXT, projectId, "apiToken")).toBeNull();

    // Refresh can't resolve a credential → 401, and it must NOT wipe the saved
    // columns (a transient failure must never degrade the editor to id-only).
    const res = await refreshColumns(ev("POST", { body: { projectId, linkId } }));
    expect(res.status).toBe(401);
    expect((await getLinkByProjectId(projectId))?.statusOptions).toEqual([
      { id: "opt-todo", name: "Todo" },
      { id: "opt-doing", name: "Doing" },
    ]);
  });

  test("re-connecting the SAME board refreshes the persisted status options", async () => {
    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "tok" } }));
    const link = await getLinkByProjectId(projectId);
    expect(link?.statusOptions).toEqual([
      { id: "opt-todo", name: "Todo" },
      { id: "opt-doing", name: "Doing" },
    ]);
  });

  test("re-connect ('Replace token') PRESERVES the board's config — column map, defaults, interval, paused state", async () => {
    // Connect, then configure the board the way a user would.
    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "tok" } }));
    const linkId = (await getLinkByProjectId(projectId))!.id;
    const configured = await linkPatch(
      ev("PATCH", {
        body: {
          projectId,
          linkId,
          columnActionMap: { "opt-doing": { action: "execute", autoSpawn: true, doneStatusOptionId: "opt-todo" } },
          defaultModel: "ollama:gemma4:e2b",
          defaultPermissionMode: "ask",
          pollIntervalSec: 300,
          enabled: false, // paused
        },
      }),
    );
    expect(configured.status).toBe(200);

    // Rotate the token — the page's "Replace token" body shape: NO config
    // fields, board-scope override. Before the fix, upsertLink's
    // onConflictDoUpdate reset every omitted field (map → {}, model/mode →
    // null, interval → 60) AND un-paused the board.
    const res = await connect(
      ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "rotated_tok", tokenScope: "board" } }),
    );
    expect(res.status).toBe(200);

    const link = (await getLinkByProjectId(projectId))!;
    expect(link.id).toBe(linkId); // same row (conflict UPDATE, not insert)
    expect(link.columnActionMap).toEqual({
      "opt-doing": { action: "execute", autoSpawn: true, doneStatusOptionId: "opt-todo" },
    });
    expect(link.defaultModel).toBe("ollama:gemma4:e2b");
    expect(link.defaultPermissionMode).toBe("ask");
    expect(link.pollIntervalSec).toBe(300);
    expect(link.enabled).toBe(false); // still paused — rotate must not resume
    // And the rotated token landed as this board's override.
    expect(await getSecret(GH_EXT, projectId, boardTokenName(linkId))).toBe("rotated_tok");
  });

  test("re-connect with body-PRESENT defaults still applies them (the connect form sets them legitimately)", async () => {
    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "tok", defaultModel: "ollama:gemma4:e2b", defaultPermissionMode: "ask" } }));
    const linkId = (await getLinkByProjectId(projectId))!.id;

    // Re-connect the SAME board with NEW explicit defaults → they win.
    const res = await connect(
      ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "tok2", defaultModel: "openai:gpt-4o", defaultPermissionMode: "yolo" } }),
    );
    expect(res.status).toBe(200);
    const link = (await getLinkByProjectId(projectId))!;
    expect(link.id).toBe(linkId);
    expect(link.defaultModel).toBe("openai:gpt-4o");
    expect(link.defaultPermissionMode).toBe("yolo");
  });

  test("PATCH response reports hasTokenOverride:true for a board carrying its own token", async () => {
    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "board_tok", tokenScope: "board" } }));
    const linkId = (await getLinkByProjectId(projectId))!.id;
    expect(await getSecret(GH_EXT, projectId, boardTokenName(linkId))).toBe("board_tok");

    // The page adopts the PATCH response wholesale (replaceLink) — it must
    // carry the recomputed override flag, not the publicLinkView default.
    const res = await linkPatch(ev("PATCH", { body: { projectId, linkId, enabled: false } }));
    expect(res.status).toBe(200);
    expect((await res.json()).link.hasTokenOverride).toBe(true);
  });

  test("re-connect at SHARED scope purges the stale override; auth then resolves the NEW shared token", async () => {
    // Board connects shared, then gains a per-board override.
    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "old_shared" } }));
    const linkId = (await getLinkByProjectId(projectId))!.id;
    await setSecret(GH_EXT, projectId, boardTokenName(linkId), "stale_override");
    expect(await resolveLinkAuth((await getLinkByProjectId(projectId))!)).toEqual({
      mode: "pat",
      token: "stale_override", // the override shadows the shared token
    });

    // Re-connect the SAME board with a NEW shared token. Before the fix the
    // override survived and kept shadowing it forever.
    const res = await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "new_shared", tokenScope: "shared" } }));
    expect(res.status).toBe(200);
    expect(await getSecret(GH_EXT, projectId, boardTokenName(linkId))).toBeNull();
    expect(await getSecret(GH_EXT, projectId, "apiToken")).toBe("new_shared");
    expect(await resolveLinkAuth((await getLinkByProjectId(projectId))!)).toEqual({
      mode: "pat",
      token: "new_shared",
    });
  });

  test("PATCH with a stale doneStatusOptionId → 400 with a named error (what the page surfaces per-card)", async () => {
    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "tok" } }));
    const linkId = (await getLinkByProjectId(projectId))!.id;
    const res = await linkPatch(
      ev("PATCH", {
        body: {
          projectId,
          linkId,
          columnActionMap: { "opt-doing": { action: "plan", autoSpawn: false, doneStatusOptionId: "opt-deleted-on-github" } },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("doneStatusOptionId");
  });

  test("re-connect of the SAME board pat → gh purges THIS board's override but keeps the shared token (other boards may use it)", async () => {
    // First board (PVT_kanban) connects with a shared token.
    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "tok" } }));
    const linkId = (await getLinkByProjectId(projectId))!.id;
    expect(await getSecret(GH_EXT, projectId, "apiToken")).toBe("tok");
    // Give this board a per-board override too.
    await setSecret(GH_EXT, projectId, boardTokenName(linkId), "board_tok");
    expect(await getSecret(GH_EXT, projectId, boardTokenName(linkId))).toBe("board_tok");

    // Re-connect the SAME board as gh. The per-board override is purged; the
    // SHARED project token is retained (a sibling board could still resolve it).
    await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "gh" } }));
    expect((await getLinkByProjectId(projectId))?.authMode).toBe("gh");
    expect(await getSecret(GH_EXT, projectId, boardTokenName(linkId))).toBeNull();
    expect(await getSecret(GH_EXT, projectId, "apiToken")).toBe("tok");
  });
});

describe("github-projects multi-board lifecycle (real DB)", () => {
  test("a project connects to TWO boards: shared token reused on the 2nd, per-board override on it, DELETE purges correctly", async () => {
    const { listLinksByProjectId } = await import("../../../db/queries/github-projects");

    // Board A connects with the SHARED project token.
    await connect(ev("POST", { body: { projectId, boardUrl: "board-a", authMode: "pat", token: "shared_tok" } }));
    expect(await getSecret(GH_EXT, projectId, "apiToken")).toBe("shared_tok");

    // Board B connects with NO typed token → reuses the shared project token,
    // and ALSO sets a per-board override (tokenScope 'board').
    await connect(ev("POST", { body: { projectId, boardUrl: "board-b", authMode: "pat", token: "b_override", tokenScope: "board" } }));

    const links = await listLinksByProjectId(projectId);
    expect(links).toHaveLength(2);
    const linkA = links.find((l) => l.boardUrl === "board-a")!;
    const linkB = links.find((l) => l.boardUrl === "board-b")!;
    expect(linkA).toBeDefined();
    expect(linkB).toBeDefined();
    // Board B carries its own override; board A uses the shared token.
    expect(await getSecret(GH_EXT, projectId, boardTokenName(linkB.id))).toBe("b_override");
    expect(await getSecret(GH_EXT, projectId, boardTokenName(linkA.id))).toBeNull();
    expect(await getSecret(GH_EXT, projectId, "apiToken")).toBe("shared_tok");

    // GET surfaces BOTH boards as an array; only board B reports a token override.
    const getRes = await linkGet(ev("GET", { url: `http://localhost/x?projectId=${projectId}` }));
    const views = (await getRes.json()).links as Array<{ id: string; boardUrl: string; hasTokenOverride: boolean }>;
    expect(views).toHaveLength(2);
    expect(views.find((v) => v.id === linkB.id)!.hasTokenOverride).toBe(true);
    expect(views.find((v) => v.id === linkA.id)!.hasTokenOverride).toBe(false);

    // DELETE board B → purges ITS override; board A remains, so the SHARED token
    // is retained.
    await linkDelete(ev("DELETE", { body: { projectId, linkId: linkB.id } }));
    expect(await getSecret(GH_EXT, projectId, boardTokenName(linkB.id))).toBeNull();
    expect(await getSecret(GH_EXT, projectId, "apiToken")).toBe("shared_tok");
    expect(await listLinksByProjectId(projectId)).toHaveLength(1);

    // DELETE the LAST board (A) → now the shared token is purged too.
    await linkDelete(ev("DELETE", { body: { projectId, linkId: linkA.id } }));
    expect(await getSecret(GH_EXT, projectId, "apiToken")).toBeNull();
    expect(await listLinksByProjectId(projectId)).toHaveLength(0);
  });
});

describe("github-projects extension RBAC (real resolver + real grant rows)", () => {
  /** A second MEMBER with NO grants (deny-by-default target). */
  async function seedMember(id = crypto.randomUUID()) {
    const user = { id, email: `m${id.slice(0, 8)}@test.local`, name: "M", role: "member" as const };
    await createUser({ id: user.id, email: user.email, passwordHash: "x", name: user.name, role: user.role });
    return user;
  }

  async function expect403Naming(res: Response, scope: string) {
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(`Missing extension scope '${scope}' for github-projects`);
  }

  test("member with NO grant: 403 per verb naming the scope; grant → 200; revoke → 403 again", async () => {
    const member = await seedMember();

    // No grant → every surface denies, each naming ITS scope.
    await expect403Naming(
      await linkGet(ev("GET", { url: `http://localhost/x?projectId=${projectId}`, user: member })),
      "use",
    );
    await expect403Naming(
      await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "gh" }, user: member })),
      "configure",
    );
    expect(await getLinkByProjectId(projectId)).toBeNull(); // nothing persisted

    // Grant use+configure PROJECT-scoped → both flip to 200.
    await upsertGrant({
      userId: member.id,
      projectId,
      extensionId: GH_EXT,
      scopes: ["use", "configure"],
      grantedByUserId: USER.id,
    });
    expect(
      (await linkGet(ev("GET", { url: `http://localhost/x?projectId=${projectId}`, user: member }))).status,
    ).toBe(200);
    expect(
      (await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "gh" }, user: member }))).status,
    ).toBe(200);

    // Revoke (delete the row) → deny-by-default returns.
    const row = await getGrant(member.id, projectId, GH_EXT);
    expect(row).toBeDefined();
    expect(await deleteGrant(row!.id)).toBe(true);
    await expect403Naming(
      await linkGet(ev("GET", { url: `http://localhost/x?projectId=${projectId}`, user: member })),
      "use",
    );
  });

  test("connect that WRITES a token needs `secrets` on top of `configure` — and stores nothing until granted", async () => {
    const member = await seedMember();
    await upsertGrant({
      userId: member.id,
      projectId,
      extensionId: GH_EXT,
      scopes: ["use", "configure"],
      grantedByUserId: USER.id,
    });
    const denied = await connect(
      ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "ghp_member" }, user: member }),
    );
    await expect403Naming(denied, "secrets");
    expect(await getSecret(GH_EXT, projectId, "apiToken")).toBeNull();
    expect(await getLinkByProjectId(projectId)).toBeNull();

    await upsertGrant({
      userId: member.id,
      projectId,
      extensionId: GH_EXT,
      scopes: ["use", "configure", "secrets"],
      grantedByUserId: USER.id,
    });
    const ok = await connect(
      ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "ghp_member" }, user: member }),
    );
    expect(ok.status).toBe(200);
    expect(await getSecret(GH_EXT, projectId, "apiToken")).toBe("ghp_member");
  });

  test("a PROJECT-scoped grant does NOT leak to another project; a NULL-project grant covers them all", async () => {
    const member = await seedMember();
    const projB = await createProject({ name: "Other Project", path: "/tmp/other" });
    await upsertGrant({
      userId: member.id,
      projectId, // project A only
      extensionId: GH_EXT,
      scopes: ["use"],
      grantedByUserId: USER.id,
    });
    expect(
      (await linkGet(ev("GET", { url: `http://localhost/x?projectId=${projectId}`, user: member }))).status,
    ).toBe(200);
    await expect403Naming(
      await linkGet(ev("GET", { url: `http://localhost/x?projectId=${projB.id}`, user: member })),
      "use",
    );

    // The seeded USER holds an extension-scoped NULL-project grant — it
    // covers BOTH projects (NULL-covers-all on the project axis).
    expect(
      (await linkGet(ev("GET", { url: `http://localhost/x?projectId=${projectId}` }))).status,
    ).toBe(200);
    expect(
      (await linkGet(ev("GET", { url: `http://localhost/x?projectId=${projB.id}` }))).status,
    ).toBe(200);
  });

  test("an ADMIN with no grant rows passes (implicit all scopes); opaque 404 ordering survives denial", async () => {
    const adminId = crypto.randomUUID();
    const admin = { id: adminId, email: `a${adminId.slice(0, 8)}@test.local`, name: "A", role: "admin" as const };
    await createUser({ id: admin.id, email: admin.email, passwordHash: "x", name: admin.name, role: admin.role });
    expect(
      (await linkGet(ev("GET", { url: `http://localhost/x?projectId=${projectId}`, user: admin }))).status,
    ).toBe(200);
    expect(
      (await connect(ev("POST", { body: { projectId, boardUrl: "u", authMode: "pat", token: "t" }, user: admin }))).status,
    ).toBe(200);

    // A NO-grant member probing a nonexistent link still sees the opaque 404
    // (resolution first), never a 403 confirming/denying anything.
    const member = await seedMember();
    const res = await linkPatch(
      ev("PATCH", { body: { projectId, linkId: "does-not-exist", enabled: false }, user: member }),
    );
    expect(res.status).toBe(404);
  });
});
