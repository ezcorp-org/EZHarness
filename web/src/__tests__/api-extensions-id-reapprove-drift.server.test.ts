/**
 * POST /api/extensions/[id]/reapprove-drift — route-layer contract.
 *
 * The core heal (disk-manifest load, lockfile gate, ceiling clamp,
 * atomic row update, audit) lives in
 * `src/extensions/bundled-drift-reapprove.ts` and is integration-tested
 * against the real on-disk web-search manifest in
 * `src/__tests__/bundled-drift-reapprove.test.ts`. THIS suite pins the
 * HTTP surface: auth gating (admin-only + extensions scope), the
 * 400/404/409/500 error mapping, the registry reload, and the
 * `{ extension, diffs }` response shape.
 *
 * Mocking pattern mirrors the sibling route tests in this directory
 * (extensions-reapprove-route.server.test.ts): `vi.mock("$server/…")`
 * collaborators, dynamic import of the handler AFTER mocks, forged
 * RequestEvent.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";
import { expectDenied } from "./fixtures/expect-denied";

// ── Auth middleware ───────────────────────────────────────────────────
// Real contract of `requireAdmin` (api-keys.ts): ROLE-ONLY. Returns a 403
// Response for a non-admin (or absent) principal, else null. Deliberately NOT
// `checkRole` — that one also demands the `admin` SCOPE, and this route's
// scope gate is `extensions`. Using it here would silently require BOTH
// scopes and reject the `--scopes extensions --role admin` key that is the
// documented way to drive this endpoint.
vi.mock("$lib/server/security/api-keys", () => ({
  requireAdmin: (locals: { user?: { role?: string } }): Response | null =>
    locals.user?.role === "admin"
      ? null
      : Response.json({ error: "Admin role required" }, { status: 403 }),
  requireScope: (locals: { apiKeyScopes?: string[] }, scope: string): Response | null => {
    if (!locals.apiKeyScopes) return null;
    if (locals.apiKeyScopes.includes(scope)) return null;
    return new Response(JSON.stringify({ error: "Insufficient scope" }), {
      status: 403,
    });
  },
}));

vi.mock("$lib/server/http-errors", () => ({
  errorJson: (status: number, message: string) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
}));

// ── Extension lookup (per-test row) ─────────────────────────────────
let extensionRow: Record<string, unknown> | null = null;

vi.mock("$server/db/queries/extensions", () => ({
  getExtension: vi.fn(async (_id: string) => extensionRow),
}));

// Bundled-name gate: only "web-search" counts as bundled in this suite.
vi.mock("$server/extensions/bundled", () => ({
  isBundledExtensionName: (name: string) => name === "web-search",
}));

// ── Core heal (per-test result) ─────────────────────────────────────
type CoreResult =
  | { ok: true; updated: unknown; diffs: unknown[] }
  | { ok: false; code: string; message: string };
let coreResult: CoreResult;
const reapproveBundledDrift = vi.fn(async () => coreResult);

// Read-only preview backing the GET route. Same collaborator module, so it is
// stubbed alongside the heal rather than in a second vi.mock.
type PreviewResult =
  | {
      ok: true;
      manifest: { version: string };
      grant: Record<string, unknown>;
      diffs: unknown[];
      ceilingClamped: boolean;
    }
  | { ok: false; code: string; message: string };
let previewResult: PreviewResult;
const previewBundledDrift = vi.fn(async () => previewResult);

vi.mock("$server/extensions/bundled-drift-reapprove", () => ({
  reapproveBundledDrift: (...args: unknown[]) =>
    (reapproveBundledDrift as unknown as (...a: unknown[]) => unknown)(...args),
  previewBundledDrift: (...args: unknown[]) =>
    (previewBundledDrift as unknown as (...a: unknown[]) => unknown)(...args),
}));

// ── Registry reload spy ─────────────────────────────────────────────
const reload = vi.fn(async () => {});
vi.mock("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({ reload }),
  },
}));

// ── Import handler AFTER mocks ──────────────────────────────────────
const { GET, POST } = await import("../routes/api/extensions/[id]/reapprove-drift/+server");

// ── Helpers ─────────────────────────────────────────────────────────
interface RequestEventLike {
  request: Request;
  locals: Record<string, unknown>;
  params: { id: string };
}

function makeEvent(
  role: "admin" | "member" = "admin",
  locals: Record<string, unknown> = {},
): RequestEventLike {
  return {
    request: new Request("http://localhost/api/extensions/ext-1/reapprove-drift", {
      method: "POST",
    }),
    locals: {
      user: { id: "user-1", email: "u@x", name: "u", role },
      ...locals,
    },
    params: { id: "ext-1" },
  };
}

/**
 * Non-denial invocations. Kept as a plain await — the old helper here
 * swallowed a THROWN Response and asserted on it, which is precisely why the
 * "member → 403" case below passed while production answered 500. Denials now
 * go through `expectDenied`, which fails on a throw.
 */
async function invoke(fn: () => Promise<Response> | Response): Promise<Response> {
  return await fn();
}

beforeEach(() => {
  reapproveBundledDrift.mockClear();
  previewBundledDrift.mockClear();
  reload.mockClear();
  extensionRow = {
    id: "ext-1",
    name: "web-search",
    enabled: false,
    version: "0.9.0",
    manifest: { permissions: { network: ["api.tavily.com"] } },
    grantedPermissions: { network: ["api.tavily.com"], grantedAt: {} },
  };
  coreResult = {
    ok: true,
    updated: { id: "ext-1", name: "web-search", enabled: true, version: "1.0.0" },
    diffs: [
      { field: "network", oldValue: ["api.tavily.com"], newValue: ["api.tavily.com", "searxng"] },
    ],
  };
  previewResult = {
    ok: true,
    manifest: { version: "1.0.0" },
    grant: { network: ["api.tavily.com", "searxng"], grantedAt: { network: 2 } },
    diffs: [
      { field: "network", oldValue: ["api.tavily.com"], newValue: ["api.tavily.com", "searxng"] },
    ],
    ceilingClamped: false,
  };
});

describe("POST /api/extensions/[id]/reapprove-drift", () => {
  test("admin + bundled → 200 with { extension, diffs }; core called with row + admin id; registry reloaded", async () => {
    const res = await invoke(() => POST(makeEvent() as never));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { extension: { enabled: boolean }; diffs: unknown[] };
    expect(body.extension.enabled).toBe(true);
    expect(body.diffs).toHaveLength(1);

    expect(reapproveBundledDrift).toHaveBeenCalledTimes(1);
    expect(reapproveBundledDrift).toHaveBeenCalledWith(extensionRow, "user-1");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // REGRESSION (the reported bug): a non-admin principal must RECEIVE 403.
  // Before the fix this route called the THROWING `requireRole`, so SvelteKit
  // answered 500 {"message":"Internal Error"} — reproduced live with an API
  // key minted without `--role admin`. `expectDenied` fails on a throw, so
  // this test cannot pass again while the handler throws its denial.
  test("member (non-admin) → RETURNS 403 (never throws); core never called", async () => {
    const res = await expectDenied(() => POST(makeEvent("member") as never), 403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Admin role required");
    expect(reapproveBundledDrift).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  // REGRESSION GUARD: an admin-role key scoped `extensions` is the documented
  // way to drive this endpoint (it is how the three stranded bundled
  // extensions were re-approved on the live host). A gate that also demanded
  // the `admin` scope would 403 this and break that workflow silently.
  test("admin-role key scoped `extensions` (no admin scope) → 200", async () => {
    const res = await invoke(() =>
      POST(makeEvent("admin", { apiKeyScopes: ["extensions"] }) as never),
    );
    expect(res.status).toBe(200);
    expect(reapproveBundledDrift).toHaveBeenCalledTimes(1);
  });

  test("API key principal lacking the `extensions` scope → RETURNS 403; core never called", async () => {
    const res = await expectDenied(
      () => POST(makeEvent("admin", { apiKeyScopes: ["chat"] }) as never),
      403,
    );
    expect(reapproveBundledDrift).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
  });

  test("no principal at all → RETURNS 401 (never throws)", async () => {
    const res = await expectDenied(() => POST({ ...makeEvent(), locals: {} } as never), 401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Authentication required");
    expect(reapproveBundledDrift).not.toHaveBeenCalled();
  });

  test("unknown extension id → 404", async () => {
    extensionRow = null;
    const res = await invoke(() => POST(makeEvent() as never));
    expect(res.status).toBe(404);
    expect(reapproveBundledDrift).not.toHaveBeenCalled();
  });

  test("non-bundled extension → 400; core never called", async () => {
    extensionRow = { ...extensionRow!, name: "user-installed-thing" };
    const res = await invoke(() => POST(makeEvent() as never));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/bundled/i);
    expect(reapproveBundledDrift).not.toHaveBeenCalled();
  });

  test("core lockfile-mismatch → 409; registry NOT reloaded", async () => {
    coreResult = {
      ok: false,
      code: "lockfile-mismatch",
      message: "On-disk manifest fails the manifest.lock.json check (tool-list drift)",
    };
    const res = await invoke(() => POST(makeEvent() as never));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/manifest\.lock\.json/);
    expect(reload).not.toHaveBeenCalled();
  });

  test("core manifest-unreadable → 500", async () => {
    coreResult = {
      ok: false,
      code: "manifest-unreadable",
      message: "Could not load on-disk manifest",
    };
    const res = await invoke(() => POST(makeEvent() as never));
    expect(res.status).toBe(500);
    expect(reload).not.toHaveBeenCalled();
  });

  test("core not-found (row raced away) → 404", async () => {
    coreResult = { ok: false, code: "not-found", message: "Extension 'ext-1' no longer exists" };
    const res = await invoke(() => POST(makeEvent() as never));
    expect(res.status).toBe(404);
  });

  test("core not-bundled (defensive re-check) → 400", async () => {
    coreResult = {
      ok: false,
      code: "not-bundled",
      message: "'web-search' is not a bundled extension",
    };
    const res = await invoke(() => POST(makeEvent() as never));
    expect(res.status).toBe(400);
  });
});

/**
 * GET is the read-only half: it projects the CURRENT on-disk, ceiling-clamped
 * grant so an admin can see a newly requested host before consenting. Same
 * auth gate and error mapping as POST, but it must never mutate — no core heal
 * and no registry reload.
 */
describe("GET /api/extensions/[id]/reapprove-drift", () => {
  test("admin + bundled → 200 with { version, permissions, diffs, ceilingClamped }; nothing mutated", async () => {
    const res = await invoke(() => GET(makeEvent() as never));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      version: string;
      permissions: { network: string[] };
      diffs: unknown[];
      ceilingClamped: boolean;
    };
    expect(body.version).toBe("1.0.0");
    expect(body.permissions.network).toContain("searxng");
    expect(body.diffs).toHaveLength(1);
    expect(body.ceilingClamped).toBe(false);

    expect(previewBundledDrift).toHaveBeenCalledTimes(1);
    expect(previewBundledDrift).toHaveBeenCalledWith(extensionRow);
    expect(reapproveBundledDrift).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  test("ceilingClamped is surfaced when the disk manifest exceeds the bundled ceiling", async () => {
    previewResult = {
      ok: true,
      manifest: { version: "1.0.0" },
      grant: { network: ["api.tavily.com"] },
      diffs: [],
      ceilingClamped: true,
    };
    const res = await invoke(() => GET(makeEvent() as never));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ceilingClamped: boolean };
    expect(body.ceilingClamped).toBe(true);
  });

  // Same regression as POST — the GET half had the identical throwing gate.
  test("member (non-admin) → RETURNS 403 (never throws); preview never called", async () => {
    const res = await expectDenied(() => GET(makeEvent("member") as never), 403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Admin role required");
    expect(previewBundledDrift).not.toHaveBeenCalled();
  });

  test("admin-role key scoped `extensions` (no admin scope) → 200", async () => {
    const res = await invoke(() =>
      GET(makeEvent("admin", { apiKeyScopes: ["extensions"] }) as never),
    );
    expect(res.status).toBe(200);
    expect(previewBundledDrift).toHaveBeenCalledTimes(1);
  });

  test("API key principal lacking the `extensions` scope → RETURNS 403; preview never called", async () => {
    const res = await expectDenied(
      () => GET(makeEvent("admin", { apiKeyScopes: ["chat"] }) as never),
      403,
    );
    expect(res.status).toBe(403);
    expect(previewBundledDrift).not.toHaveBeenCalled();
  });

  test("no principal at all → RETURNS 401 (never throws)", async () => {
    const res = await expectDenied(() => GET({ ...makeEvent(), locals: {} } as never), 401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Authentication required");
    expect(previewBundledDrift).not.toHaveBeenCalled();
  });

  test("unknown extension id → 404", async () => {
    extensionRow = null;
    const res = await invoke(() => GET(makeEvent() as never));
    expect(res.status).toBe(404);
    expect(previewBundledDrift).not.toHaveBeenCalled();
  });

  test("non-bundled extension → 400; preview never called", async () => {
    extensionRow = { ...extensionRow!, name: "user-installed-thing" };
    const res = await invoke(() => GET(makeEvent() as never));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/bundled/i);
    expect(previewBundledDrift).not.toHaveBeenCalled();
  });

  test("preview lockfile-mismatch → 409", async () => {
    previewResult = {
      ok: false,
      code: "lockfile-mismatch",
      message: "On-disk manifest fails the manifest.lock.json check (tool-list drift)",
    };
    const res = await invoke(() => GET(makeEvent() as never));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/manifest\.lock\.json/);
  });

  test("preview manifest-unreadable → 500", async () => {
    previewResult = {
      ok: false,
      code: "manifest-unreadable",
      message: "Could not load on-disk manifest",
    };
    const res = await invoke(() => GET(makeEvent() as never));
    expect(res.status).toBe(500);
  });

  test("preview not-bundled (defensive re-check) → 400", async () => {
    previewResult = {
      ok: false,
      code: "not-bundled",
      message: "'web-search' is not a bundled extension",
    };
    const res = await invoke(() => GET(makeEvent() as never));
    expect(res.status).toBe(400);
  });
});
