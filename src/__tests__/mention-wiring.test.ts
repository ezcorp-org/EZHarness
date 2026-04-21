import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());
import { parseMentions } from "../../web/src/lib/mention-logic";

// Test parseMentions directly (pure function, no mocking needed)
describe("parseMentions", () => {
  test("extracts ext mentions", () => {
    const result = parseMentions("Hello ![ext:analyzer] please analyze");
    expect(result).toEqual([
      { kind: "ext", name: "analyzer", start: 6, end: 21 },
    ]);
  });

  test("extracts agent mentions", () => {
    const result = parseMentions("![agent:Code Assistant] help me");
    expect(result).toEqual([
      { kind: "agent", name: "Code Assistant", start: 0, end: 23 },
    ]);
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
    const result = parseMentions(
      "![agent:Bot] please read @[file:a.ts] with ![ext:lint]",
    );
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.kind)).toEqual(["agent", "file", "ext"]);
  });

  test("returns empty for no mentions", () => {
    expect(parseMentions("just a normal message")).toEqual([]);
  });

  test("returns empty for empty string", () => {
    expect(parseMentions("")).toEqual([]);
  });

  test("does not match legacy @[agent:…] tokens (graceful degradation)", () => {
    expect(parseMentions("@[agent:Legacy]")).toEqual([]);
    expect(parseMentions("@[ext:legacy]")).toEqual([]);
    expect(parseMentions("@[team:OldTeam]")).toEqual([]);
  });
});

// Test wireMentionedExtensions with mocked DB
describe("wireMentionedExtensions", () => {
  const mockGetExtByName = mock(() => Promise.resolve(null));
  const mockGetAgentByName = mock(() => Promise.resolve(null));
  const mockGetConvExtIds = mock(() => Promise.resolve([] as string[]));
  const mockAddConvExts = mock(() => Promise.resolve());

  beforeEach(() => {
    mockGetExtByName.mockClear();
    mockGetAgentByName.mockClear();
    mockGetConvExtIds.mockClear();
    mockAddConvExts.mockClear();

    // Reset module mocks
    mock.module("../db/queries/extensions", () => ({
      getExtensionByName: mockGetExtByName,
    }));
    mock.module("../db/queries/agent-configs", () => ({
      getAgentConfigByName: mockGetAgentByName,
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
    mockGetExtByName.mockResolvedValue({ id: "ext-123", name: "analyzer" } as any);
    mockGetConvExtIds.mockResolvedValue([]);

    const wire = await loadWire();
    const result = await wire("conv-1", "![ext:analyzer] do stuff", "msg-1");

    expect(mockGetExtByName).toHaveBeenCalledWith("analyzer");
    expect(mockAddConvExts).toHaveBeenCalledWith("conv-1", [
      { extensionId: "ext-123", messageId: "msg-1" },
    ]);
    expect(result).toEqual(["ext-123"]);
  });

  test("resolves agent mention to its extension IDs", async () => {
    mockGetAgentByName.mockResolvedValue({
      id: "agent-1",
      name: "Helper",
      extensions: ["ext-a", "ext-b"],
    } as any);
    mockGetConvExtIds.mockResolvedValue([]);

    const wire = await loadWire();
    const result = await wire("conv-1", "![agent:Helper] help", "msg-1");

    expect(result).toEqual(expect.arrayContaining(["ext-a", "ext-b"]));
  });

  test("deduplicates against existing conversation extensions", async () => {
    mockGetExtByName.mockResolvedValue({ id: "ext-123" } as any);
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
    expect(mockGetExtByName).not.toHaveBeenCalled();
  });

  test("skips unknown extension names gracefully", async () => {
    mockGetExtByName.mockResolvedValue(null);
    const wire = await loadWire();
    const result = await wire("conv-1", "![ext:nonexistent] stuff", "msg-1");

    expect(result).toEqual([]);
  });

  test("skips unknown agent names gracefully", async () => {
    mockGetAgentByName.mockResolvedValue(null);
    const wire = await loadWire();
    const result = await wire("conv-1", "![agent:Unknown] stuff", "msg-1");

    expect(result).toEqual([]);
  });

  test("ignores @[file:…] mentions (does not wire any extension)", async () => {
    const wire = await loadWire();
    const result = await wire("conv-1", "read @[file:src/app.ts]", "msg-1");

    expect(result).toEqual([]);
    expect(mockGetExtByName).not.toHaveBeenCalled();
    expect(mockGetAgentByName).not.toHaveBeenCalled();
  });
});
