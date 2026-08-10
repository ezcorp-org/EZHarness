import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());
import { parseMentions } from "../../web/src/lib/mention-logic";

// Test parseMentions directly (pure function, no mocking needed)
describe("parseMentions", () => {
  test("extracts ext mentions", () => {
    const result = parseMentions("Hello ![ext:analyzer] please analyze");
    expect(result).toEqual([{ kind: "ext", name: "analyzer", start: 6, end: 21 }]);
  });

  test("extracts agent mentions", () => {
    const result = parseMentions("![agent:Code Assistant] help me");
    expect(result).toEqual([{ kind: "agent", name: "Code Assistant", start: 0, end: 23 }]);
  });

  test("extracts multiple mentions", () => {
    const result = parseMentions("![ext:analyzer] and ![agent:Helper]");
    expect(result).toHaveLength(2);
    expect(result[0]!.kind).toBe("ext");
    expect(result[1]!.kind).toBe("agent");
  });

  test("extracts file mentions", () => {
    const result = parseMentions("look at @[file:src/app.ts]");
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("file");
    expect(result[0]!.name).toBe("src/app.ts");
  });

  test("extracts mixed-sigil mentions together", () => {
    const result = parseMentions("![agent:Bot] please read @[file:a.ts] with ![ext:lint]");
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.kind)).toEqual(["agent", "file", "ext"]);
  });

  test("returns empty for no mentions", () => {
    expect(parseMentions("just a normal message")).toEqual([]);
  });

  test("returns empty for empty string", () => {
    expect(parseMentions("")).toEqual([]);
  });

  test("extracts workflow mentions", () => {
    const result = parseMentions("run ![workflow:deploy-prod] please");
    expect(result).toEqual([{ kind: "workflow", name: "deploy-prod", start: 4, end: 27 }]);
  });

  test("keeps the workflow kind distinct from the other ! kinds", () => {
    const result = parseMentions("![agent:A] ![ext:B] ![team:C] ![EZ:D] ![workflow:E]");
    expect(result.map((m) => m.kind)).toEqual(["agent", "ext", "team", "EZ", "workflow"]);
  });

  test("does not match legacy @[agent:…] tokens (graceful degradation)", () => {
    expect(parseMentions("@[agent:Legacy]")).toEqual([]);
    expect(parseMentions("@[ext:legacy]")).toEqual([]);
    expect(parseMentions("@[team:OldTeam]")).toEqual([]);
  });
});

// Test wireMentionedExtensions with mocked DB
describe("wireMentionedExtensions", () => {
  // After the N+1 batching pass, mention-wiring resolves names through
  // `getExtensionsByNames` / `getAgentConfigsByNames` (returning a
  // Map<name, row>) instead of the per-name helpers. The mocks stub the
  // batch APIs and a thin `lookupBy` test helper builds the Map from a
  // record so existing assertions read like before.
  const mockGetExtsByNames = mock(async (_names: string[]) => new Map<string, unknown>());
  const mockGetAgentsByNames = mock(async (_names: string[]) => new Map<string, unknown>());
  const mockGetConvExtIds = mock(() => Promise.resolve([] as string[]));
  const mockAddConvExts = mock(() => Promise.resolve());

  /**
   * Build a Map from name → row that the batch helpers would have
   * returned. Names not in the record are absent from the Map (matches
   * production behaviour: `IN (...)` simply returns no rows for them).
   */
  function mapFromRecord(record: Record<string, unknown>): Map<string, unknown> {
    const m = new Map<string, unknown>();
    for (const [k, v] of Object.entries(record)) m.set(k, v);
    return m;
  }

  beforeEach(() => {
    mockGetExtsByNames.mockClear();
    mockGetAgentsByNames.mockClear();
    mockGetConvExtIds.mockClear();
    mockAddConvExts.mockClear();

    // Reset module mocks
    mock.module("../db/queries/extensions", () => ({
      getExtensionsByNames: mockGetExtsByNames,
    }));
    mock.module("../db/queries/agent-configs", () => ({
      getAgentConfigsByNames: mockGetAgentsByNames,
      getAgentConfigsByIds: async () => new Map<string, unknown>(),
    }));
    mock.module("../db/queries/conversation-extensions", () => ({
      getConversationExtensionIds: mockGetConvExtIds,
      addConversationExtensions: mockAddConvExts,
    }));
  });

  async function loadWire() {
    // Fresh import to pick up mocks
    const mod = await import("../runtime/mention-wiring");
    return mod.wireMentionedExtensions;
  }

  test("resolves ext mention to extension ID", async () => {
    mockGetExtsByNames.mockResolvedValueOnce(
      mapFromRecord({ analyzer: { id: "ext-123", name: "analyzer" } }) as any,
    );
    mockGetConvExtIds.mockResolvedValue([]);

    const wire = await loadWire();
    const result = await wire("conv-1", "![ext:analyzer] do stuff", "msg-1");

    expect(mockGetExtsByNames).toHaveBeenCalledWith(["analyzer"]);
    expect(mockAddConvExts).toHaveBeenCalledWith("conv-1", [
      { extensionId: "ext-123", messageId: "msg-1" },
    ]);
    expect(result).toEqual(["ext-123"]);
  });

  test("resolves agent mention to its extension IDs", async () => {
    mockGetAgentsByNames.mockResolvedValueOnce(
      mapFromRecord({
        Helper: { id: "agent-1", name: "Helper", extensions: ["ext-a", "ext-b"] },
      }) as any,
    );
    mockGetConvExtIds.mockResolvedValue([]);

    const wire = await loadWire();
    const result = await wire("conv-1", "![agent:Helper] help", "msg-1");

    expect(result).toEqual(expect.arrayContaining(["ext-a", "ext-b"]));
  });

  test("deduplicates against existing conversation extensions", async () => {
    mockGetExtsByNames.mockResolvedValueOnce(mapFromRecord({ analyzer: { id: "ext-123" } }) as any);
    mockGetConvExtIds.mockResolvedValue(["ext-123"]);

    const wire = await loadWire();
    const result = await wire("conv-1", "![ext:analyzer] do stuff", "msg-1");

    expect(result).toEqual([]);
    expect(mockAddConvExts).not.toHaveBeenCalled();
  });

  test("returns empty for no mentions", async () => {
    const wire = await loadWire();
    const result = await wire("conv-1", "normal message", "msg-1");

    expect(result).toEqual([]);
    expect(mockGetExtsByNames).not.toHaveBeenCalled();
  });

  test("skips unknown extension names gracefully", async () => {
    mockGetExtsByNames.mockResolvedValueOnce(new Map() as any);
    const wire = await loadWire();
    const result = await wire("conv-1", "![ext:nonexistent] stuff", "msg-1");

    expect(result).toEqual([]);
  });

  test("skips unknown agent names gracefully", async () => {
    mockGetAgentsByNames.mockResolvedValueOnce(new Map() as any);
    const wire = await loadWire();
    const result = await wire("conv-1", "![agent:Unknown] stuff", "msg-1");

    expect(result).toEqual([]);
  });

  test("ignores @[file:…] mentions (does not wire any extension)", async () => {
    const wire = await loadWire();
    const result = await wire("conv-1", "read @[file:src/app.ts]", "msg-1");

    expect(result).toEqual([]);
    expect(mockGetExtsByNames).not.toHaveBeenCalled();
    expect(mockGetAgentsByNames).not.toHaveBeenCalled();
  });

  test("ignores ![workflow:…] mentions (does not wire any extension)", async () => {
    // Shares the `!` sigil with ext/agent, so a workflow whose name
    // matches an extension must NOT pull that extension's tools into the
    // conversation. The kind filter is what prevents it — no DB round
    // trip is even attempted.
    const wire = await loadWire();
    const result = await wire("conv-1", "run ![workflow:analyzer]", "msg-1");

    expect(result).toEqual([]);
    expect(mockGetExtsByNames).not.toHaveBeenCalled();
    expect(mockGetAgentsByNames).not.toHaveBeenCalled();
    expect(mockAddConvExts).not.toHaveBeenCalled();
  });

  test("a workflow token alongside an ext token wires ONLY the extension", async () => {
    mockGetExtsByNames.mockResolvedValueOnce(
      mapFromRecord({ analyzer: { id: "ext-123", name: "analyzer" } }) as any,
    );
    mockGetConvExtIds.mockResolvedValue([]);

    const wire = await loadWire();
    const result = await wire("conv-1", "![workflow:analyzer] then ![ext:analyzer]", "msg-1");

    // Only the ext token contributed a name to the lookup.
    expect(mockGetExtsByNames).toHaveBeenCalledWith(["analyzer"]);
    expect(result).toEqual(["ext-123"]);
  });
});
