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
  creatorUserId: "admin-1",
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
  test("an admin's MCP mention is wired", async () => {
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
    expect(hasExtensionScope).toHaveBeenCalledWith(
      { id: "member-1", role: "member" },
      { projectId: "proj-1", extensionId: "weather-mcp", scope: "use" },
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
