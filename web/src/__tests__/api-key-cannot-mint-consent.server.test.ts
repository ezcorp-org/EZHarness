/**
 * R-4, proven by attack rather than by assertion.
 *
 * A workflow run parks on an `approval` step precisely so that a PERSON
 * decides. Answering one is therefore the consent boundary. Before this, the
 * answer route gated on `requireScope(locals, "chat")` — which passes for any
 * `chat`-scoped API key — so a LEAKED KEY WAS A CONSENT-MINTING KEY and the
 * approval mechanism was decorative against exactly the threat it exists for.
 *
 * Every other test of this route hand-writes `locals`. That is fine for
 * wiring, but it cannot prove the attack, because the thing under suspicion
 * is precisely whether a real key produces locals that the route accepts. So
 * this file MINTS A REAL `ezk_` KEY, stores it exactly as the mint route
 * does, and drives the REAL `verifyApiKey` → REAL `attachBearerAuth` →
 * REAL route handler chain from an `Authorization: Bearer …` header. The only
 * fakes are the settings/users stores (there is no DB here) and the
 * `answerApproval` chokepoint, which is spied so "was consent spent?" is a
 * call count rather than an inference from a status code.
 *
 * On the pre-fix tree this file's central test FAILS: the key answers, and
 * the chokepoint is called. That before/after is the deliverable.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  apiKeyHashIndexKey,
  apiKeySettingsKey,
  generateApiKey,
  type ApiKeyScope,
} from "$server/auth/api-key";

// ── The stores `verifyApiKey` and `attachBearerAuth` read ────────────────
// In-memory stand-ins for the settings table and the users table. Seeded per
// test by `mintKeyFor`, so the key material under test is genuinely produced
// by `generateApiKey()` and genuinely re-derived by `hashApiKey` inside
// `verifyApiKey` — neither is stubbed.
const store = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  users: new Map<string, { id: string; name: string; role: string; status: string }>(),
}));

vi.mock("$server/db/queries/settings", () => ({
  getSetting: async (key: string) => store.settings.get(key),
  getAllSettings: async () => Object.fromEntries(store.settings),
  upsertSetting: async (key: string, value: unknown) => {
    store.settings.set(key, value);
  },
}));

vi.mock("$server/db/queries/users", () => ({
  getUserById: async (id: string) => store.users.get(id),
}));

const chokepoint = vi.hoisted(() => ({ answerApproval: vi.fn() }));
vi.mock("$server/runtime/workflow-answer-approval", () => ({
  answerApproval: chokepoint.answerApproval,
}));

vi.mock("$server/auth/extension-rbac", () => ({
  hasExtensionScope: vi.fn(async () => true),
}));

const { attachBearerAuth } = await import("$lib/server/security/bearer-auth");
const { POST } = await import("../routes/api/workflows/approvals/[id]/+server");

const OK_RUN = { id: "run-1", workflowName: "ship-it", status: "success", steps: [] };
const OWNER = { id: "u-owner", name: "Owner", role: "member", status: "active" };

beforeEach(() => {
  store.settings.clear();
  store.users.clear();
  store.users.set(OWNER.id, OWNER);
  chokepoint.answerApproval
    .mockReset()
    .mockResolvedValue({ ok: true, run: OK_RUN, consentAllUsed: false });
});

/**
 * Mint a real key for `userId` and store it the way the mint route does:
 * the canonical `apikey:<userId>:<keyId>` row plus the `apikeyhash:<hash>`
 * index row. Returns the RAW token — the only thing an attacker who leaked a
 * key would hold.
 */
function mintKeyFor(
  userId: string,
  scopes: ApiKeyScope[],
  role: "member" | "admin" = "member",
): string {
  const { raw, hash, keyId } = generateApiKey();
  store.settings.set(apiKeySettingsKey(userId, keyId), {
    hash,
    userId,
    scopes,
    role,
    name: "leaked-key",
    createdAt: Date.now(),
  });
  store.settings.set(apiKeyHashIndexKey(hash), { userId, keyId });
  return raw;
}

/**
 * Run the REAL bearer pipeline over `Authorization: Bearer <raw>` and hand
 * back the `locals` the SvelteKit hook would have built. Loopback address +
 * no forwarding headers is the most PERMISSIVE input the pipeline accepts,
 * so nothing here is refused for an incidental reason.
 */
async function localsFromBearer(raw: string): Promise<Record<string, unknown>> {
  const locals: Record<string, unknown> = {};
  await attachBearerAuth(
    {
      locals: locals as never,
      remoteAddress: "127.0.0.1",
      proxyForwardedHeadersPresent: false,
      onBehalfOfHeader: null,
    },
    `Bearer ${raw}`,
  );
  return locals;
}

function answerRequest(locals: Record<string, unknown>, id = "ap-1") {
  return {
    url: new URL(`http://localhost/api/workflows/approvals/${id}`),
    locals,
    params: { id },
    request: new Request(`http://localhost/api/workflows/approvals/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: "approve" }),
    }),
  } as never;
}

describe("a leaked API key cannot mint consent", () => {
  test("the attack setup is real: a minted key DOES authenticate", async () => {
    // Without this the refusal below would be unfalsifiable — a key that
    // failed to verify would also be refused, and for the wrong reason.
    const raw = mintKeyFor(OWNER.id, ["chat"]);
    const locals = await localsFromBearer(raw);
    expect(locals.user).toMatchObject({ id: OWNER.id, role: "member" });
    expect(locals.apiKeyScopes).toEqual(["chat"]);
    // …and it satisfies the gate this route USED to have.
    const { hasRequiredScope } = await import("$server/auth/api-key");
    expect(hasRequiredScope(locals.apiKeyScopes as ApiKeyScope[], "chat")).toBe(true);
  });

  test("a `chat`-scoped key is REFUSED at the answer route, and spends nothing", async () => {
    const raw = mintKeyFor(OWNER.id, ["chat"]);
    const res = await POST(answerRequest(await localsFromBearer(raw)));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Interactive session required" });
    // The whole point. A refusal that had already called the chokepoint
    // would have granted the consent and then reported an error about it.
    expect(chokepoint.answerApproval).not.toHaveBeenCalled();
  });

  test("neither does an ADMIN-role, admin-scoped key belonging to an admin", async () => {
    // The maximum-authority key the system can mint. `answerApproval`'s
    // ownership branch short-circuits on `isAdmin`, so if this one got
    // through it could clear ANY user's gate on ANY run.
    store.users.set("u-admin", { id: "u-admin", name: "A", role: "admin", status: "active" });
    const raw = mintKeyFor("u-admin", ["read", "chat", "extensions", "admin"], "admin");
    const locals = await localsFromBearer(raw);
    expect(locals.user).toMatchObject({ role: "admin" });

    const res = await POST(answerRequest(locals));
    expect(res.status).toBe(403);
    expect(chokepoint.answerApproval).not.toHaveBeenCalled();
  });

  test("the bearer pipeline stamps `api-key`, which is what makes it refusable", async () => {
    // The discrimination is on a POSITIVELY-stamped method, not on the
    // absence of `apiKeyScopes`. Pinning the stamp here means a future edit
    // that drops it fails HERE, next to the reason, rather than silently
    // re-opening the hole at the route.
    const raw = mintKeyFor(OWNER.id, ["chat"]);
    expect((await localsFromBearer(raw)).authMethod).toBe("api-key");
  });

  test("the SAME user, at a browser, CAN answer — the gate is on method, not identity", async () => {
    // The control. Refusing the key while refusing the human too would be a
    // broken route, not a closed hole. `authMethod: "session"` is verbatim
    // what `hooks.server.ts` stamps after verifying the session-cookie JWT.
    const res = await POST(
      answerRequest({
        user: { id: OWNER.id, email: "", name: OWNER.name, role: "member" },
        authMethod: "session",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ run: OK_RUN, consentAllUsed: false });
    expect(chokepoint.answerApproval).toHaveBeenCalledTimes(1);
    // Answered as the human, under their own id and their own (non-admin)
    // authority — not as some ambient system actor. `kind: "user"` is what
    // makes that last clause literal rather than rhetorical: the two
    // non-human kinds are different shapes, so "this route answered as the
    // clock" is now a failing assertion instead of a null userId nobody
    // would have looked at.
    expect(chokepoint.answerApproval.mock.calls[0]![2]).toEqual({
      kind: "user",
      userId: OWNER.id,
      isAdmin: false,
    });
  });
});

// ── The stamping invariant, structurally ────────────────────────────────
//
// `requireSessionAuth` allowlists a POSITIVELY-stamped method, which is only
// stronger than sniffing `apiKeyScopes` if every auth site actually stamps.
// A new auth site that populated `locals.user` and forgot would fail CLOSED
// at the gate (its principals could not answer approvals) rather than open —
// but "closed and mysteriously broken" is still a bug, and it would surface
// in production rather than here. So the rule is checked where it is cheap.

const WEB_SRC = join(process.cwd(), "src");

function productionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    // Tests hand-build `locals` constantly; they are not auth sites.
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...productionTsFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const ASSIGNS_USER = /\blocals\.user\s*=[^=]/;
const ASSIGNS_METHOD = /\blocals\.authMethod\s*=[^=]/;
const authSites = productionTsFiles(WEB_SRC).filter((f) =>
  ASSIGNS_USER.test(readFileSync(f, "utf8")),
);

describe("every auth site declares HOW it authenticated", () => {
  test("the sweep finds the known auth sites (it is not vacuous)", () => {
    // A walk that matched nothing would pass forever. Today there are
    // exactly two: the cookie-session hook and the bearer router. A THIRD
    // appearing here is the review prompt — someone must decide whether its
    // principals may spend a consent gate.
    expect(authSites.map((f) => f.slice(WEB_SRC.length + 1)).sort()).toEqual([
      "hooks.server.ts",
      "lib/server/security/bearer-auth.ts",
    ]);
  });

  test.each(authSites.map((f) => [f.slice(WEB_SRC.length + 1), f]))(
    "%s stamps locals.authMethod alongside locals.user",
    (_label, file) => {
      expect(ASSIGNS_METHOD.test(readFileSync(file, "utf8"))).toBe(true);
    },
  );
});
