/**
 * GET /api/tools — caller-executed-tool parity (spec §3.5).
 *
 * `/api/tools` is what the chat header's tool badge and popover render, so a
 * caller tool the runtime WILL wire but this endpoint does not list is a
 * silent lie to the user — and a `caller` toggle that revokes at runtime but
 * not here is the same lie in reverse. Both directions are pinned by driving
 * the REAL handler over the REAL `computeModeToolScope` + `applyToolFilters`
 * pair the executor runs, with only the IO leaves mocked.
 *
 * ── WHY THIS SUITE IS VITEST AND MUST STAY VITEST ────────────────────────
 *
 * `web/src/lib/server/scoped-tools.ts` is pinned at 100% and is measured by
 * the vitest leg alone. A `bun:test` under `src/` that imported it would add
 * bun-only zero-hit `DA` records on the declaration lines of its multi-line
 * signatures — lines V8 never emits — and `merge-lcov.ts` sums per (SF,
 * line), so the module's coverage would DROP without a line of it becoming
 * less tested. See the coverage trap in the root CLAUDE.md.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const getAllTools = vi.fn(() => [] as Array<{ name: string; description: string }>);
const getExtensionType = vi.fn(() => "extension");
const getExtensionDescription = vi.fn((_ext: string): string | undefined => undefined);
const getToolsForExtension = vi.fn(
  (_id: string) => [] as Array<{ name: string; originalName: string }>,
);
vi.mock("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      getAllTools,
      getExtensionType,
      getExtensionDescription,
      getToolsForExtension,
    }),
  },
}));

const getMode = vi.fn();
vi.mock("$server/db/queries/modes", () => ({ getMode }));

const getConversation = vi.fn();
vi.mock("$server/db/queries/conversations", () => ({ getConversation }));

vi.mock("$lib/server/context", () => ({ ensureInitialized: vi.fn(async () => {}) }));

const { GET } = await import("../routes/api/tools/+server");
// NOT mocked: the real cached built-in registry is the subject of the
// non-mutation test below.
const { getBuiltInToolMetadata } = await import("$server/runtime/tools/builtin-registry");

const owner = { id: "user-1", email: "u@x", name: "U", role: "member" };

interface ToolRow {
  name: string;
  extension: string;
  extensionType: string;
  extensionDescription?: string;
}

function call(query = "") {
  return GET({
    locals: { user: owner },
    url: new URL(`http://localhost/api/tools${query}`),
  } as never);
}

async function rows(res: Response): Promise<ToolRow[]> {
  const body = await res.json();
  return body.tools as ToolRow[];
}

async function callerNames(res: Response): Promise<string[]> {
  return (await rows(res))
    .filter((t) => t.extension === "caller")
    .map((t) => t.name)
    .sort();
}

const DECLARED = [
  { name: "open_app", description: "Open an app", parameters: { type: "object" } },
  { name: "capture_screen", description: "Screenshot", parameters: { type: "object" } },
];

/** A root conversation owned by `owner`, carrying declarations + a toggle map. */
function conversation(over: Record<string, unknown> = {}) {
  return {
    id: "conv-1",
    userId: "user-1",
    parentConversationId: null,
    modeId: null,
    extensionTools: null,
    metadata: { callerTools: DECLARED },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getExtensionType.mockReturnValue("extension");
  getAllTools.mockReturnValue([]);
  getToolsForExtension.mockReturnValue([]);
});

describe("GET /api/tools — declared caller tools surface", () => {
  test("they list under extension 'caller' with the category description", async () => {
    getConversation.mockResolvedValue(conversation());
    const res = await call("?conversationId=conv-1");
    expect(res.status).toBe(200);
    const caller = (await rows(res)).filter((t) => t.extension === "caller");
    expect(caller.map((t) => t.name).sort()).toEqual(["capture_screen", "open_app"]);
    // `BuiltInToolMeta` has no `extension` field — `extension` is DERIVED
    // downstream as `t.category`, which is why `category: "caller"` is what
    // makes the toggle key and the listing agree.
    expect(caller[0]!.extensionType).toBe("built-in");
    expect(caller[0]!.extensionDescription).toBe(
      "Tools executed on your connected client device",
    );
  });

  test("a conversation with no declarations lists none", async () => {
    getConversation.mockResolvedValue(conversation({ metadata: { goal: "unrelated" } }));
    expect(await callerNames(await call("?conversationId=conv-1"))).toEqual([]);
  });

  test("a mode-only call lists none — a declaration is per-conversation", async () => {
    getMode.mockResolvedValue({ id: "mode-1", extensionIds: null, toolRestriction: null });
    expect(await callerNames(await call("?modeId=mode-1"))).toEqual([]);
    expect(getConversation).not.toHaveBeenCalled();
  });
});

describe("GET /api/tools — the conversation's `caller` toggle is a REAL revocation", () => {
  test("an empty subset (master toggle OFF) removes every caller tool", async () => {
    getConversation.mockResolvedValue(conversation({ extensionTools: { caller: [] } }));
    expect(await callerNames(await call("?conversationId=conv-1"))).toEqual([]);
  });

  test("a non-empty subset keeps exactly what it names", async () => {
    getConversation.mockResolvedValue(
      conversation({ extensionTools: { caller: ["open_app"] } }),
    );
    expect(await callerNames(await call("?conversationId=conv-1"))).toEqual(["open_app"]);
  });

  test("the subset may name the namespaced form too", async () => {
    getConversation.mockResolvedValue(
      conversation({ extensionTools: { caller: ["_caller__capture_screen"] } }),
    );
    expect(await callerNames(await call("?conversationId=conv-1"))).toEqual(["capture_screen"]);
  });

  test("an absent `caller` key means all of them, unchanged", async () => {
    getConversation.mockResolvedValue(
      conversation({ extensionTools: { "ext-other": ["x"] } }),
    );
    expect(await callerNames(await call("?conversationId=conv-1"))).toEqual([
      "capture_screen",
      "open_app",
    ]);
  });
});

describe("GET /api/tools — the built-in metadata cache is never mutated", () => {
  test("one user's caller tools do not leak into the next request", async () => {
    // `getBuiltInToolMetadata()` hands back the process-wide `_cachedTools`
    // array BY REFERENCE. A `.push()` here would graft these declarations
    // onto every subsequent /api/tools response for the life of the process —
    // a cross-user leak with no error and no expiry. This is the test that
    // makes the spread in `resolveScopedTools` load-bearing rather than a
    // stylistic choice.
    const before = getBuiltInToolMetadata();
    const snapshot = [...before];

    getConversation.mockResolvedValue(conversation());
    expect(await callerNames(await call("?conversationId=conv-1"))).toHaveLength(2);

    const after = getBuiltInToolMetadata();
    // Same array object, same contents — nothing was appended to the cache.
    expect(after).toBe(before);
    expect(after).toEqual(snapshot);
    expect(after.some((t) => t.category === "caller")).toBe(false);

    // And the very next request, for a conversation with NO declarations,
    // sees none of the previous one's tools.
    getConversation.mockResolvedValue(conversation({ id: "conv-2", metadata: null }));
    expect(await callerNames(await call("?conversationId=conv-2"))).toEqual([]);
  });
});
