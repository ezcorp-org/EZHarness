/**
 * Unit tests for `$lib/server/agent-config-extension-gate` — the write-time
 * half of the F3 fix.
 *
 * The bypass this closes: `agent_configs.extensions` holds RAW extension ids,
 * `POST /api/agent-configs` is scope `chat` + `requireAuth` (any member), and
 * `registry.getToolsForAgent` hands the named extensions' tools to the LLM
 * turn. So a member could list extensions, create a config naming an
 * admin-installed MCP extension's id, and chat with it.
 *
 * The RUNTIME half (`allowExtension` on `getToolsForAgent`) is what actually
 * protects the credential and is covered against real grants in
 * `src/__tests__/mcp-wire-gate-bypasses.integration.test.ts`. This file covers
 * the fail-fast half: the author gets a clear 400 rather than an agent that
 * silently has fewer tools than its config lists.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

let denied: string[] = [];
const findUnauthorizedExtensionIds = vi.fn(async (_ids: readonly string[], _actor: unknown) => denied);
vi.mock("$server/auth/extension-wire-authz", () => ({
  findUnauthorizedExtensionIds: (ids: readonly string[], actor: unknown) =>
    findUnauthorizedExtensionIds(ids, actor),
}));

const { rejectUnauthorizedExtensions, readExtensionIds } = await import(
  "../lib/server/agent-config-extension-gate"
);

const MEMBER = { id: "u1", role: "member" as const };

beforeEach(() => {
  denied = [];
  findUnauthorizedExtensionIds.mockClear();
});

describe("readExtensionIds", () => {
  test("returns the string ids from an array", () => {
    expect(readExtensionIds(["a", "b"])).toEqual(["a", "b"]);
  });

  test("a non-array, an empty array, and an all-garbage array are all 'nothing to check'", () => {
    // The PUT route's schema is `.passthrough()`, so this field arrives as
    // `unknown`. A malformed value must not throw here — it is simply not a
    // list of ids.
    expect(readExtensionIds(undefined)).toBeUndefined();
    expect(readExtensionIds(null)).toBeUndefined();
    expect(readExtensionIds("ext-1")).toBeUndefined();
    expect(readExtensionIds({ 0: "ext-1" })).toBeUndefined();
    expect(readExtensionIds([])).toBeUndefined();
    expect(readExtensionIds([1, true, null])).toBeUndefined();
  });

  test("mixed arrays keep only the strings", () => {
    expect(readExtensionIds(["a", 2, null, "b"])).toEqual(["a", "b"]);
  });
});

describe("rejectUnauthorizedExtensions", () => {
  test("absent or empty extensions short-circuit without consulting the gate", async () => {
    expect(await rejectUnauthorizedExtensions(undefined, MEMBER)).toBeNull();
    expect(await rejectUnauthorizedExtensions([], MEMBER)).toBeNull();
    expect(findUnauthorizedExtensionIds).not.toHaveBeenCalled();
  });

  test("an allowed list passes", async () => {
    denied = [];
    expect(await rejectUnauthorizedExtensions(["ext-ok"], MEMBER)).toBeNull();
    expect(findUnauthorizedExtensionIds).toHaveBeenCalledTimes(1);
  });

  test("a denied id returns a 400 naming it", async () => {
    denied = ["ext-mcp"];
    const res = await rejectUnauthorizedExtensions(["ext-ok", "ext-mcp"], MEMBER);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json();
    // One vocabulary with the wire route: a denied id and a nonexistent id
    // read the same. `GET /api/extensions` already lists every id to any
    // authenticated caller, so this hides nothing that surface does not.
    expect(body).toEqual({ error: "Unknown or unavailable extension(s)", unknown: ["ext-mcp"] });
  });

  test("the gate is asked at the ALL-PROJECTS coordinate", async () => {
    denied = [];
    await rejectUnauthorizedExtensions(["ext-ok"], MEMBER);
    const [ids, actor] = findUnauthorizedExtensionIds.mock.calls[0]!;
    expect(ids).toEqual(["ext-ok"]);
    // An agent config is not project-scoped, so only a NULL-project grant can
    // cover it. Deliberately NARROWER than the runtime check (which knows the
    // conversation's project) — write time may refuse what run time allows,
    // never the reverse.
    expect(actor).toEqual({ user: { id: "u1", role: "member" }, projectId: null });
  });

  test("an admin is put through the same call — the gate decides, not this helper", async () => {
    denied = [];
    await rejectUnauthorizedExtensions(["ext-mcp"], { id: "a1", role: "admin" });
    expect(findUnauthorizedExtensionIds).toHaveBeenCalledTimes(1);
    const [, actor] = findUnauthorizedExtensionIds.mock.calls[0]!;
    expect((actor as { user: { role: string } }).user.role).toBe("admin");
  });
});
