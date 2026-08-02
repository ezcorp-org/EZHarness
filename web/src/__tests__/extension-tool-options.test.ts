import { test, expect, describe } from "bun:test";
import {
  groupToolOptions,
  namespacedToolName,
  parseExtensionList,
  toToolOptions,
  TOOL_NAMESPACE_SEPARATOR,
  type ExtensionToolSource,
} from "$lib/extension-tool-options";

// ---------------------------------------------------------------------------
// Shared normalization of GET /api/extensions, used by both the agent form's
// per-extension tool checklist and the workflow builder's tool-step picker.
// The `.svelte` callers are thin bindings over these, so every branch —
// especially the malformed-payload ones — is exercised here.
// ---------------------------------------------------------------------------

describe("namespacedToolName", () => {
  test("joins with a double underscore, not a dot", () => {
    // Anthropic's tool-name pattern rejects dots, so the registry namespaces
    // with `__`; a dot here produces a step that validates and then fails at
    // dispatch with an unknown tool.
    expect(TOOL_NAMESPACE_SEPARATOR).toBe("__");
    expect(namespacedToolName("extension-author", "create_extension")).toBe(
      "extension-author__create_extension",
    );
  });
});

describe("parseExtensionList", () => {
  const entry = {
    id: "notes",
    name: "Notes",
    manifest: { tools: [{ name: "add", description: "Add a note" }] },
  };

  test("reads a bare array", () => {
    expect(parseExtensionList([entry])).toEqual([
      { id: "notes", name: "Notes", tools: [{ name: "add", description: "Add a note" }] },
    ]);
  });

  test("reads an { extensions } envelope", () => {
    // The endpoint has served both shapes; tolerating one silently blanks
    // the picker under the other.
    expect(parseExtensionList({ extensions: [entry] })).toHaveLength(1);
  });

  test("falls back to the id when no display name is present", () => {
    expect(parseExtensionList([{ id: "notes" }])[0].name).toBe("notes");
  });

  test("yields an empty tool list for an extension exposing none", () => {
    expect(parseExtensionList([{ id: "notes", manifest: {} }])[0].tools).toEqual([]);
    expect(parseExtensionList([{ id: "notes" }])[0].tools).toEqual([]);
  });

  test("normalizes a missing tool description to null", () => {
    const [ext] = parseExtensionList([{ id: "n", manifest: { tools: [{ name: "add" }] } }]);
    expect(ext.tools[0].description).toBeNull();
  });

  test("skips entries and tools that lack a usable name", () => {
    // One malformed record must not blank out the whole picker.
    const parsed = parseExtensionList([
      null,
      "nope",
      { name: "no id" },
      { id: "ok", manifest: { tools: [{ name: "good" }, { description: "nameless" }, 7] } },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].tools).toEqual([{ name: "good", description: null }]);
  });

  test("returns an empty list for payloads that are not extension lists", () => {
    expect(parseExtensionList(undefined)).toEqual([]);
    expect(parseExtensionList(null)).toEqual([]);
    expect(parseExtensionList("boom")).toEqual([]);
    expect(parseExtensionList({ extensions: "not-an-array" })).toEqual([]);
  });
});

describe("toToolOptions", () => {
  const sources: ExtensionToolSource[] = [
    { id: "notes", name: "Notes", tools: [{ name: "add" }, { name: "remove", description: "d" }] },
    { id: "empty", name: "Empty", tools: [] },
  ];

  test("emits one namespaced option per tool", () => {
    expect(toToolOptions(sources)).toEqual([
      { extension: "notes", extensionLabel: "Notes", tool: "add", value: "notes__add", description: null },
      { extension: "notes", extensionLabel: "Notes", tool: "remove", value: "notes__remove", description: "d" },
    ]);
  });

  test("drops extensions exposing no tools", () => {
    // An empty <optgroup> is a dead row in the picker.
    expect(toToolOptions(sources).some((o) => o.extension === "empty")).toBe(false);
  });
});

describe("groupToolOptions", () => {
  test("groups by extension, preserving encounter order", () => {
    const groups = groupToolOptions(
      toToolOptions([
        { id: "a", name: "A", tools: [{ name: "one" }, { name: "two" }] },
        { id: "b", name: "B", tools: [{ name: "three" }] },
      ]),
    );
    expect(groups.map((g) => g.extension)).toEqual(["a", "b"]);
    expect(groups[0].label).toBe("A");
    expect(groups[0].options.map((o) => o.tool)).toEqual(["one", "two"]);
    expect(groups[1].options).toHaveLength(1);
  });

  test("returns nothing for no options", () => {
    expect(groupToolOptions([])).toEqual([]);
  });
});
