/**
 * The mention-wiring gate, asserted from the VITEST side.
 *
 * `src/runtime/mention-wiring.ts` is measured by BOTH coverage legs: the bun
 * shards run it directly, and the vitest leg resolves it through
 * `web/src/routes/api/conversations/[id]/messages/+server.ts`. The two
 * emitters do not agree on which lines of this file are executable, and
 * `merge-lcov.ts` sums per `(SF, line)` — so a line only V8 considers
 * executable stays at zero forever if no vitest test ever runs the function,
 * however thoroughly the bun suites cover it.
 *
 * This is the documented remedy: assert from the vitest side, which resolves
 * both trees. The bun-side suites (`src/__tests__/mention-wiring.test.ts`,
 * `src/__tests__/mcp-wire-authz.integration.test.ts`) own the exhaustive
 * matrix against a real database; what runs here is the same authorization
 * decision through the REAL gate, with only the storage layer mocked.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const getExtensionsByNames = vi.fn();
const getExtension = vi.fn();
vi.mock("$server/db/queries/extensions", () => ({ getExtensionsByNames, getExtension }));

const getAgentConfigsByNames = vi.fn();
const getAgentConfigsByIds = vi.fn();
vi.mock("$server/db/queries/agent-configs", () => ({ getAgentConfigsByNames, getAgentConfigsByIds }));

const getConversationExtensionIds = vi.fn();
const addConversationExtensions = vi.fn();
vi.mock("$server/db/queries/conversation-extensions", () => ({
  getConversationExtensionIds,
  addConversationExtensions,
}));

// The REAL wire gate runs; only the two reads it makes are mocked.
const getUserById = vi.fn();
vi.mock("$server/db/queries/users", () => ({ getUserById }));
const hasExtensionScope = vi.fn();
vi.mock("$server/auth/extension-rbac", () => ({ hasExtensionScope }));

const { wireMentionedExtensions } = await import("$server/runtime/mention-wiring");

type Row = {
  id: string;
  name: string;
  source: string;
  isBundled: boolean;
  creatorUserId: string | null;
  manifest: { kind: string };
};

const MCP_ROW: Row = {
  id: "ext-mcp",
  name: "weather-mcp",
  source: "mcp:http",
  isBundled: false,
  // A THIRD id — neither the admin nor the member principal used below.
  // It was `admin-1` (the admin's own id), which confounded the admin test:
  // that case passed under BOTH the drop-admin-rung and drop-creator-rung
  // mutations, so it proved "the gate allowed it" without saying which rung
  // did. Each rung now has exactly one case that can explain it.
  creatorUserId: "installer-admin-9",
  manifest: { kind: "mcp" },
};
const PLAIN_ROW: Row = {
  id: "ext-plain",
  name: "notes",
  source: "local",
  isBundled: false,
  creatorUserId: null,
  manifest: { kind: "subprocess" },
};

const ROWS_BY_ID = new Map([
  [MCP_ROW.id, MCP_ROW],
  [PLAIN_ROW.id, PLAIN_ROW],
]);

beforeEach(() => {
  vi.clearAllMocks();
  getExtensionsByNames.mockImplementation(async (names: string[]) => {
    const out = new Map<string, unknown>();
    for (const row of [MCP_ROW, PLAIN_ROW]) if (names.includes(row.name)) out.set(row.name, row);
    return out;
  });
  getExtension.mockImplementation(async (id: string) => ROWS_BY_ID.get(id) ?? null);
  getAgentConfigsByNames.mockResolvedValue(new Map());
  getConversationExtensionIds.mockResolvedValue([]);
  addConversationExtensions.mockResolvedValue(undefined);
  hasExtensionScope.mockResolvedValue(false);
});

/** An active principal for `loadWireActor` to resolve. */
function user(id: string, role: "admin" | "member") {
  return { id, email: `${id}@x`, name: id, role, status: "active" };
}

describe("wireMentionedExtensions — the wire gate", () => {
  test("an admin's MCP mention is wired — by the ADMIN rung alone", async () => {
    // `admin-1` is not the row's creator and `hasExtensionScope` is false
    // (the beforeEach default), so the admin rung is the ONLY thing that can
    // explain this pass.
    getUserById.mockResolvedValue(user("admin-1", "admin"));

    const wired = await wireMentionedExtensions(
      "conv-1",
      "check ![ext:weather-mcp] please",
      "msg-1",
      { userId: "admin-1", projectId: "proj-1" },
    );

    expect(wired).toEqual(["ext-mcp"]);
    expect(addConversationExtensions).toHaveBeenCalledWith("conv-1", [
      { extensionId: "ext-mcp", messageId: "msg-1" },
    ]);
    // Pin the isolation: an admin resolves through the RBAC_ALL_SCOPES
    // sentinel, so the grants store is never consulted.
    expect(hasExtensionScope).not.toHaveBeenCalled();
  });

  test("the row's CREATOR is wired even as a plain member — by the creator rung alone", async () => {
    // A member, no grant, and the id matches `MCP_ROW.creatorUserId`. Only
    // the creator rung can explain this pass, which is what makes the admin
    // case above a genuine test of the admin rung rather than a duplicate.
    getUserById.mockResolvedValue(user("installer-admin-9", "member"));

    const wired = await wireMentionedExtensions(
      "conv-1",
      "check ![ext:weather-mcp] please",
      "msg-1",
      { userId: "installer-admin-9", projectId: "proj-1" },
    );

    expect(wired).toEqual(["ext-mcp"]);
    expect(hasExtensionScope).not.toHaveBeenCalled();
  });

  test("a member whose id merely RESEMBLES the creator's is not the creator", async () => {
    // Guards the comparison itself: it must be equality on the id, not a
    // prefix/truthiness accident.
    getUserById.mockResolvedValue(user("installer-admin-99", "member"));

    const wired = await wireMentionedExtensions(
      "conv-1",
      "check ![ext:weather-mcp] please",
      "msg-1",
      { userId: "installer-admin-99", projectId: "proj-1" },
    );

    expect(wired).toEqual([]);
  });

  test("a member with no grant has the MCP mention dropped SILENTLY", async () => {
    getUserById.mockResolvedValue(user("member-1", "member"));

    const wired = await wireMentionedExtensions(
      "conv-1",
      "check ![ext:weather-mcp] please",
      "msg-1",
      { userId: "member-1", projectId: "proj-1" },
    );

    // A no-op, not an error: the mention grammar's binding contract, and the
    // non-leaking answer (an error would confirm the name exists).
    expect(wired).toEqual([]);
    expect(addConversationExtensions).not.toHaveBeenCalled();
  });

  test("a member's `use` grant opens exactly that extension", async () => {
    getUserById.mockResolvedValue(user("member-1", "member"));
    hasExtensionScope.mockResolvedValue(true);

    const wired = await wireMentionedExtensions(
      "conv-1",
      "check ![ext:weather-mcp] please",
      "msg-1",
      { userId: "member-1", projectId: "proj-1" },
    );

    expect(wired).toEqual(["ext-mcp"]);
    // The grant is looked up by the manifest NAME (the stable slug), at the
    // conversation's project coordinate — never by row id, never from the body.
    // The verb is the DEDICATED `mcp-wire`, not `use`: matching is
    // NULL-covers-all, so asking for `use` would have let one wildcard grant
    // authorize every MCP server on the instance.
    expect(hasExtensionScope).toHaveBeenCalledWith(
      { id: "member-1", role: "member" },
      { projectId: "proj-1", extensionId: "weather-mcp", scope: "mcp-wire" },
    );
  });

  test("a non-MCP extension is unaffected by the gate", async () => {
    getUserById.mockResolvedValue(user("member-1", "member"));

    const wired = await wireMentionedExtensions(
      "conv-1",
      "take ![ext:notes] with you",
      "msg-1",
      { userId: "member-1", projectId: "proj-1" },
    );

    expect(wired).toEqual(["ext-plain"]);
  });

  test("an ![agent:…] config cannot smuggle an MCP extension past the gate", async () => {
    // The agent branch is user-authored, so leaving it ungated would make
    // `![agent:mine]` a one-hop bypass of the direct-mention gate.
    getUserById.mockResolvedValue(user("member-1", "member"));
    getAgentConfigsByNames.mockResolvedValue(
      new Map([["mine", { id: "agent-1", extensions: [MCP_ROW.id, PLAIN_ROW.id] }]]),
    );

    const wired = await wireMentionedExtensions(
      "conv-1",
      "ask ![agent:mine] about it",
      "msg-1",
      { userId: "member-1", projectId: "proj-1" },
    );

    expect(wired).toEqual(["ext-plain"]);
  });

  test("no resolvable principal wires no MCP extension at all", async () => {
    // Fail-closed: a turn whose owner cannot be resolved is not "any user".
    getUserById.mockResolvedValue(null);

    const wired = await wireMentionedExtensions(
      "conv-1",
      "![ext:weather-mcp] and ![ext:notes]",
      "msg-1",
      { userId: "ghost", projectId: "proj-1" },
    );

    expect(wired).toEqual(["ext-plain"]);
  });

  test("an extension row that vanished between lookup and re-read drops out", async () => {
    // The gate decides on COLUMNS, so the rows are re-read by id. A row
    // deleted in that window is dropped rather than wired unchecked.
    getUserById.mockResolvedValue(user("admin-1", "admin"));
    getExtension.mockResolvedValue(null);

    const wired = await wireMentionedExtensions(
      "conv-1",
      "check ![ext:weather-mcp]",
      "msg-1",
      { userId: "admin-1", projectId: "proj-1" },
    );

    expect(wired).toEqual([]);
    expect(addConversationExtensions).not.toHaveBeenCalled();
  });
});
