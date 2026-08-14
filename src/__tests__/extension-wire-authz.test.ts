/**
 * Unit tests for the wire-authz gate (`src/auth/extension-wire-authz.ts`) —
 * the single decision point for "may this user attach this extension to a
 * conversation?".
 *
 * Both dependencies are mocked at the import boundary rather than driven
 * through PGlite, for one reason that matters here: this module's whole
 * contract is what it does when a dependency MISBEHAVES — a user row that is
 * gone, a user that is inactive, a grants lookup that throws. Those are
 * exactly the states a real DB will not produce on demand, and they are the
 * states where a wrong answer is a security hole rather than a bug. The
 * end-to-end policy against real grants + real routes is pinned separately by
 * `src/__tests__/mcp-wire-authz.integration.test.ts`.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── getUserById: programmable per test. ───────────────────────────────
type FakeUser = { id: string; role: "admin" | "member"; status: "active" | "inactive" };
let userRows = new Map<string, FakeUser>();
let userLookupThrows = false;
const mockGetUserById = mock(async (id: string) => {
  if (userLookupThrows) throw new Error("users table unreachable");
  return userRows.get(id);
});
mock.module("../db/queries/users", () => ({ getUserById: mockGetUserById }));

// ── hasExtensionScope: programmable, including the throwing arm. ───────
let grantAnswer: boolean = false;
let grantThrows = false;
const mockHasExtensionScope = mock(
  async (_user: unknown, _query: { projectId: string | null; extensionId: string | null; scope: string }) => {
    if (grantThrows) throw new Error("grants store unreachable");
    return grantAnswer;
  },
);
mock.module("../auth/extension-rbac", () => ({ hasExtensionScope: mockHasExtensionScope }));

const {
  MCP_WIRE_SCOPE,
  isMcpExtension,
  loadWireActor,
  canWireExtension,
  partitionWirableExtensions,
} = await import("../auth/extension-wire-authz");

type Row = Parameters<typeof canWireExtension>[0];

const ADMIN = { id: "admin-1", role: "admin" as const };
const MEMBER = { id: "member-1", role: "member" as const };

/** A plain user-installed extension — the "unchanged behaviour" arm. */
function localRow(over: Partial<Row> = {}): Row {
  return {
    id: "ext-local",
    name: "analyzer",
    manifest: { kind: "extension" },
    source: "local",
    isBundled: false,
    creatorUserId: null,
    ...over,
  };
}

/** An admin-installed MCP row — the gated arm. */
function mcpRow(over: Partial<Row> = {}): Row {
  return {
    id: "ext-mcp",
    name: "weather-mcp",
    manifest: { kind: "mcp" },
    source: "mcp:stdio",
    isBundled: false,
    creatorUserId: null,
    ...over,
  };
}

beforeEach(() => {
  userRows = new Map();
  userLookupThrows = false;
  grantAnswer = false;
  grantThrows = false;
  mockGetUserById.mockClear();
  mockHasExtensionScope.mockClear();
});

afterAll(() => restoreModuleMocks());

describe("isMcpExtension", () => {
  test("either host-written signal is sufficient, and neither is required of the other", () => {
    // Both signals are written by the same host path, so agreeing on either
    // is what keeps a truncated/garbled manifest column from silently
    // dropping the gate.
    expect(isMcpExtension(mcpRow())).toBe(true);
    expect(isMcpExtension(mcpRow({ source: "local" }))).toBe(true); //  manifest only
    expect(isMcpExtension(mcpRow({ manifest: {} }))).toBe(true); //      source only
    expect(isMcpExtension(mcpRow({ manifest: null, source: "mcp:http" }))).toBe(true);
  });

  test("an ordinary extension is not MCP under any manifest shape", () => {
    expect(isMcpExtension(localRow())).toBe(false);
    expect(isMcpExtension(localRow({ manifest: null }))).toBe(false);
    expect(isMcpExtension(localRow({ manifest: undefined }))).toBe(false);
    expect(isMcpExtension(localRow({ manifest: "not-an-object" }))).toBe(false);
    expect(isMcpExtension(localRow({ manifest: { kind: "agent" } }))).toBe(false);
    expect(isMcpExtension(localRow({ source: null }))).toBe(false);
    expect(isMcpExtension(localRow({ source: undefined }))).toBe(false);
  });

  test("the source signal is prefix-anchored — a name merely CONTAINING 'mcp:' is not a match", () => {
    // `github:owner/mcp:thing` must not be swept up: over-matching here
    // would deny ordinary extensions rather than fail open, but it would
    // still be wrong, and silently so.
    expect(isMcpExtension(localRow({ source: "github:acme/mcp:tools@v1" }))).toBe(false);
  });
});

describe("loadWireActor", () => {
  test("a null/undefined user id resolves to no principal WITHOUT a DB read", async () => {
    expect(await loadWireActor(null, "proj-1")).toEqual({ user: null, projectId: "proj-1" });
    expect(await loadWireActor(undefined, null)).toEqual({ user: null, projectId: null });
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  test("an active user resolves to its id + role, and the project passes through", async () => {
    userRows.set("member-1", { id: "member-1", role: "member", status: "active" });
    expect(await loadWireActor("member-1", "proj-1")).toEqual({
      user: { id: "member-1", role: "member" },
      projectId: "proj-1",
    });
  });

  test("an unknown, an inactive, and a throwing lookup all resolve to NO principal", async () => {
    // All three are the same answer on purpose: the gate must not be able to
    // tell "deleted" from "suspended" from "database down".
    expect((await loadWireActor("ghost", null)).user).toBeNull();

    userRows.set("frozen", { id: "frozen", role: "admin", status: "inactive" });
    expect((await loadWireActor("frozen", null)).user).toBeNull();

    userLookupThrows = true;
    expect((await loadWireActor("member-1", null)).user).toBeNull();
  });
});

describe("canWireExtension — rule 1 (bundled) and rule 2 (non-MCP)", () => {
  test("a bundled row is wire-able by anyone, with no principal and no grant read", async () => {
    const row = localRow({ isBundled: true, manifest: { kind: "mcp" }, source: "mcp:stdio" });
    expect(await canWireExtension(row, { user: null, projectId: null })).toBe(true);
    expect(mockHasExtensionScope).not.toHaveBeenCalled();
  });

  test("an ordinary extension keeps today's behaviour — allowed, no grant read", async () => {
    expect(await canWireExtension(localRow(), { user: MEMBER, projectId: "proj-1" })).toBe(true);
    expect(await canWireExtension(localRow(), { user: null, projectId: null })).toBe(true);
    expect(mockHasExtensionScope).not.toHaveBeenCalled();
    // Deliberate: gating every extension on the `use` scope would deny every
    // member every extension, because the grants table is deny-by-default
    // and no shipped instance seeds rows.
  });
});

describe("canWireExtension — rule 3 (MCP) and rule 4 (fail-closed)", () => {
  test("an admin is allowed WITHOUT consulting the grants store", async () => {
    expect(await canWireExtension(mcpRow(), { user: ADMIN, projectId: "proj-1" })).toBe(true);
    expect(mockHasExtensionScope).not.toHaveBeenCalled();
  });

  test("the row's creator is allowed WITHOUT consulting the grants store", async () => {
    const row = mcpRow({ creatorUserId: MEMBER.id });
    expect(await canWireExtension(row, { user: MEMBER, projectId: "proj-1" })).toBe(true);
    expect(mockHasExtensionScope).not.toHaveBeenCalled();
  });

  test("a NULL creator matches nobody — legacy rows stay admin-only", async () => {
    // The trap this pins: `ext.creatorUserId === actor.user.id` with both
    // sides null would allow everyone. `creatorUserId` is NULL on every row
    // installed before the creator stamp existed.
    expect(await canWireExtension(mcpRow({ creatorUserId: null }), { user: MEMBER, projectId: null })).toBe(false);
    expect(await canWireExtension(mcpRow({ creatorUserId: undefined }), { user: MEMBER, projectId: null })).toBe(false);
  });

  test("a different user's creator stamp does not transfer", async () => {
    const row = mcpRow({ creatorUserId: "some-other-admin" });
    expect(await canWireExtension(row, { user: MEMBER, projectId: null })).toBe(false);
  });

  test("a member with the `use` grant is allowed, and the query uses the NAME + server-side project", async () => {
    grantAnswer = true;
    expect(await canWireExtension(mcpRow(), { user: MEMBER, projectId: "proj-1" })).toBe(true);
    expect(mockHasExtensionScope).toHaveBeenCalledTimes(1);
    const [principal, query] = mockHasExtensionScope.mock.calls[0]!;
    expect(principal).toEqual(MEMBER);
    // `extension_rbac_grants.extension_id` stores the manifest NAME, not the
    // row UUID — querying by `ext.id` would silently match nothing and the
    // grant escape hatch would be dead on arrival.
    expect(query).toEqual({ projectId: "proj-1", extensionId: "weather-mcp", scope: MCP_WIRE_SCOPE });
    // The dedicated verb, NOT `use`: `grantCovers` is NULL-covers-all, so
    // asking for `use` would have let ONE wildcard grant authorize every MCP
    // server on the instance and would have retro-authorized every grant
    // that already existed.
    expect(MCP_WIRE_SCOPE).toBe("mcp-wire");
  });

  test("a member without the grant is denied", async () => {
    grantAnswer = false;
    expect(await canWireExtension(mcpRow(), { user: MEMBER, projectId: "proj-1" })).toBe(false);
  });

  test("no acting principal denies before any grant read", async () => {
    expect(await canWireExtension(mcpRow(), { user: null, projectId: "proj-1" })).toBe(false);
    expect(mockHasExtensionScope).not.toHaveBeenCalled();
  });

  test("a throwing grants lookup DENIES rather than falling through", async () => {
    grantThrows = true;
    expect(await canWireExtension(mcpRow(), { user: MEMBER, projectId: "proj-1" })).toBe(false);
  });
});

describe("partitionWirableExtensions", () => {
  test("splits a mixed batch, preserving input order on both sides", async () => {
    const batch = [
      localRow({ id: "a", name: "alpha" }),
      mcpRow({ id: "b", name: "bravo" }),
      localRow({ id: "c", name: "charlie" }),
      mcpRow({ id: "d", name: "delta" }),
    ];
    const { allowed, deniedNames } = await partitionWirableExtensions(batch, {
      user: MEMBER,
      projectId: null,
    });
    expect(allowed.map((e) => e.id)).toEqual(["a", "c"]);
    expect(deniedNames).toEqual(["bravo", "delta"]);
  });

  test("an all-allowed batch costs zero grant reads", async () => {
    const { allowed, deniedNames } = await partitionWirableExtensions(
      [localRow({ id: "a", name: "alpha" }), localRow({ id: "b", name: "bravo" })],
      { user: MEMBER, projectId: null },
    );
    expect(allowed).toHaveLength(2);
    expect(deniedNames).toEqual([]);
    expect(mockHasExtensionScope).not.toHaveBeenCalled();
  });

  test("an empty batch is an empty verdict", async () => {
    expect(await partitionWirableExtensions([], { user: null, projectId: null })).toEqual({
      allowed: [],
      deniedNames: [],
    });
  });

  test("denial reports the NAME — that is what both call sites echo or drop", async () => {
    const { deniedNames } = await partitionWirableExtensions([mcpRow()], {
      user: MEMBER,
      projectId: null,
    });
    // The route folds these into its unknown-name 404; the mention path drops
    // them. Neither ever surfaces the id.
    expect(deniedNames).toEqual(["weather-mcp"]);
  });
});
