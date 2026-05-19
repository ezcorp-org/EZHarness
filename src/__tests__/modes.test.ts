import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

// Re-establish real settings implementation (same pattern as conversations.test.ts)
mock.module("../db/queries/settings", () => {
  const { eq } = require("drizzle-orm");
  const { settings: tbl } = require("../db/schema");
  return {
    async getAllSettings() {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl);
      return Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
    },
    async getSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      return rows[0]?.value;
    },
    async upsertSetting(key: string, value: unknown) {
      const { getDb } = require("../db/connection");
      const db = getDb();
      const rows = await db.select().from(tbl).where(eq(tbl.key, key));
      if (rows[0]) {
        await db.update(tbl).set({ value, updatedAt: new Date() }).where(eq(tbl.key, key));
      } else {
        await db.insert(tbl).values({ key, value, updatedAt: new Date() });
      }
    },
    async deleteSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      if (!rows[0]) return false;
      await getDb().delete(tbl).where(eq(tbl.key, key));
      return true;
    },
    async isListingInstalled() { return false; },
  };
});

mockDbConnection();

// Import after mock
import {
  listModes,
  getMode,
  getModeBySlug,
  createMode,
  updateMode,
  deleteMode,
} from "../db/queries/modes";
import {
  createConversation,
  updateConversation,
  resolveSystemPrompt,
} from "../db/queries/conversations";
import { createProject } from "../db/queries/projects";
import { upsertSetting, deleteSetting } from "../db/queries/settings";

let projectId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Mode Test Project", path: "/tmp/mode-test" });
  projectId = project.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

// ── Modes CRUD ────────────────────────────────────────────────────────

describe("modes CRUD", () => {
  test("listModes returns seeded built-in modes", async () => {
    const modes = await listModes();
    const builtins = modes.filter(m => m.builtin);
    expect(builtins.length).toBeGreaterThanOrEqual(2);
    const slugs = builtins.map(m => m.slug);
    expect(slugs).toContain("plan");
    expect(slugs).toContain("code-review");
  });

  test("getMode returns a built-in mode by id", async () => {
    const mode = await getMode("builtin-plan");
    expect(mode).not.toBeUndefined();
    expect(mode!.name).toBe("Plan");
    expect(mode!.slug).toBe("plan");
    expect(mode!.builtin).toBe(true);
    expect(mode!.toolRestriction).toBe("read-only");
    expect(mode!.systemPromptInstruction).toContain("planning mode");
  });

  test("getModeBySlug returns mode by slug", async () => {
    const mode = await getModeBySlug("code-review");
    expect(mode).not.toBeUndefined();
    expect(mode!.name).toBe("Code Review");
    expect(mode!.builtin).toBe(true);
  });

  test("getMode returns undefined for missing id", async () => {
    const mode = await getMode("nonexistent");
    expect(mode).toBeUndefined();
  });

  test("getModeBySlug returns undefined for missing slug", async () => {
    const mode = await getModeBySlug("nonexistent");
    expect(mode).toBeUndefined();
  });

  test("createMode creates a custom mode", async () => {
    const mode = await createMode({
      name: "Debug",
      slug: "debug",
      icon: "\u{1F41B}",
      description: "Systematic debugging",
      systemPromptInstruction: "You are in debug mode. Reproduce, hypothesize, verify.",
      toolRestriction: "all",
    });
    expect(mode.id).toBeDefined();
    expect(mode.name).toBe("Debug");
    expect(mode.slug).toBe("debug");
    expect(mode.icon).toBe("\u{1F41B}");
    expect(mode.builtin).toBe(false);
    expect(mode.toolRestriction).toBe("all");
    expect(mode.instructionPosition).toBe("prepend"); // default
  });

  test("createMode with all optional fields", async () => {
    const mode = await createMode({
      name: "Quick Answer",
      slug: "quick-answer",
      description: "Concise responses",
      systemPromptInstruction: "Be concise.",
      instructionPosition: "append",
      preferredModel: "claude-haiku-4-5-20251001",
      preferredProvider: "anthropic",
      preferredThinkingLevel: "off",
      temperature: 20,
      toolRestriction: "none",
    });
    expect(mode.instructionPosition).toBe("append");
    expect(mode.preferredModel).toBe("claude-haiku-4-5-20251001");
    expect(mode.preferredProvider).toBe("anthropic");
    expect(mode.preferredThinkingLevel).toBe("off");
    expect(mode.temperature).toBe(20);
    expect(mode.toolRestriction).toBe("none");
  });

  test("updateMode updates custom mode fields", async () => {
    const created = await createMode({
      name: "Temp Mode",
      slug: "temp-mode",
      systemPromptInstruction: "Original instruction",
    });
    const updated = await updateMode(created.id, {
      name: "Updated Mode",
      description: "Updated description",
      systemPromptInstruction: "New instruction",
      toolRestriction: "read-only",
    });
    expect(updated).not.toBeUndefined();
    expect(updated!.name).toBe("Updated Mode");
    expect(updated!.description).toBe("Updated description");
    expect(updated!.systemPromptInstruction).toBe("New instruction");
    expect(updated!.toolRestriction).toBe("read-only");
  });

  test("updateMode returns undefined for non-existent mode", async () => {
    const result = await updateMode("nonexistent", { name: "Nope" });
    expect(result).toBeUndefined();
  });

  test("updateMode prevents editing built-in modes", async () => {
    const result = await updateMode("builtin-plan", { name: "Hacked Plan" });
    expect(result).toBeUndefined();

    // Verify it wasn't changed
    const mode = await getMode("builtin-plan");
    expect(mode!.name).toBe("Plan");
  });

  test("deleteMode deletes custom mode", async () => {
    const created = await createMode({
      name: "Deletable",
      slug: "deletable",
      systemPromptInstruction: "To be deleted",
    });
    const deleted = await deleteMode(created.id);
    expect(deleted).toBe(true);

    const found = await getMode(created.id);
    expect(found).toBeUndefined();
  });

  test("deleteMode returns false for non-existent mode", async () => {
    const result = await deleteMode("nonexistent");
    expect(result).toBe(false);
  });

  test("deleteMode prevents deleting built-in modes", async () => {
    const result = await deleteMode("builtin-plan");
    expect(result).toBe(false);

    const mode = await getMode("builtin-plan");
    expect(mode).not.toBeUndefined();
  });

  test("listModes without userId returns all modes", async () => {
    const allModes = await listModes();
    const builtins = allModes.filter(m => m.builtin);
    const custom = allModes.filter(m => !m.builtin);

    expect(builtins.length).toBeGreaterThanOrEqual(2);
    // Custom modes created in earlier tests should appear
    expect(custom.length).toBeGreaterThanOrEqual(1);
  });
});

// ── extensionIds round-trip ───────────────────────────────────────────
//
// Phase: modes.extensionIds — modes can declare a tool surface as the
// union of attached extensions. The DB column is `extension_ids TEXT[]`
// so unset === null, "explicitly cleared" === []. Round-tripping that
// distinction matters: the executor reads `mode.extensionIds ?? []`
// and only takes the new-allowlist code path when the array has
// entries; null and [] both fall through to the legacy
// toolRestriction/allowedTools path.

describe("modes extensionIds round-trip", () => {
  test("createMode persists extensionIds and getMode returns the array", async () => {
    const mode = await createMode({
      name: "Ext Round-trip",
      slug: "ext-roundtrip-" + Date.now(),
      systemPromptInstruction: "Use only the attached extensions.",
      extensionIds: ["ext-a", "ext-b"],
    });
    expect(mode.extensionIds).toEqual(["ext-a", "ext-b"]);
    const fetched = await getMode(mode.id);
    expect(fetched!.extensionIds).toEqual(["ext-a", "ext-b"]);
  });

  test("createMode without extensionIds defaults to null (column is nullable)", async () => {
    // Defaulting to null (NOT []) lets the executor distinguish "field
    // never set" from "user explicitly cleared the list" — both paths
    // bypass the new allowlist filter, but the distinction shows up in
    // the API JSON the client renders.
    const mode = await createMode({
      name: "No Exts",
      slug: "no-exts-" + Date.now(),
      systemPromptInstruction: "Plain mode with no attached extensions.",
    });
    expect(mode.extensionIds).toBeNull();
    const fetched = await getMode(mode.id);
    expect(fetched!.extensionIds).toBeNull();
  });

  test("createMode with extensionIds=[] persists empty array (NOT null)", async () => {
    const mode = await createMode({
      name: "Empty Exts",
      slug: "empty-exts-" + Date.now(),
      systemPromptInstruction: "Cleared list.",
      extensionIds: [],
    });
    // PGlite stores empty array as [], not null. Asserts the column
    // didn't fall back to its default.
    expect(mode.extensionIds).toEqual([]);
    const fetched = await getMode(mode.id);
    expect(fetched!.extensionIds).toEqual([]);
  });

  test("updateMode replaces extensionIds with a new list", async () => {
    const mode = await createMode({
      name: "Update Exts",
      slug: "update-exts-" + Date.now(),
      systemPromptInstruction: "Will swap extensions.",
      extensionIds: ["old-1", "old-2"],
    });
    const updated = await updateMode(mode.id, {
      extensionIds: ["new-a", "new-b", "new-c"],
    });
    expect(updated!.extensionIds).toEqual(["new-a", "new-b", "new-c"]);
    const fetched = await getMode(mode.id);
    expect(fetched!.extensionIds).toEqual(["new-a", "new-b", "new-c"]);
  });

  test("updateMode with extensionIds=[] clears the list", async () => {
    const mode = await createMode({
      name: "Clear Exts",
      slug: "clear-exts-" + Date.now(),
      systemPromptInstruction: "Will be cleared.",
      extensionIds: ["a", "b"],
    });
    const cleared = await updateMode(mode.id, { extensionIds: [] });
    expect(cleared!.extensionIds).toEqual([]);
    const fetched = await getMode(mode.id);
    expect(fetched!.extensionIds).toEqual([]);
  });

  test("updateMode WITHOUT extensionIds key leaves the existing list untouched (partial update)", async () => {
    // The shared updateMode loop applies updates only when the value is
    // !== undefined, so a partial PUT that only renames the mode must
    // not reset extensionIds to null.
    const mode = await createMode({
      name: "Partial Update Source",
      slug: "partial-source-" + Date.now(),
      systemPromptInstruction: "Keep these.",
      extensionIds: ["keep-1", "keep-2"],
    });
    const updated = await updateMode(mode.id, { name: "Partial Update Renamed" });
    expect(updated!.name).toBe("Partial Update Renamed");
    expect(updated!.extensionIds).toEqual(["keep-1", "keep-2"]);
  });

  test("updateMode with extensionIds=null explicitly resets to null", async () => {
    // Distinct from "key omitted" (kept) — explicitly setting the value
    // to null wipes the list. Mirrors the API contract for "remove the
    // attached extensions" via PUT.
    const mode = await createMode({
      name: "Reset Source",
      slug: "reset-source-" + Date.now(),
      systemPromptInstruction: "Will be reset.",
      extensionIds: ["a"],
    });
    const reset = await updateMode(mode.id, { extensionIds: null });
    expect(reset!.extensionIds).toBeNull();
    const fetched = await getMode(mode.id);
    expect(fetched!.extensionIds).toBeNull();
  });

  test("listModes surfaces extensionIds for every row", async () => {
    // Guards against a future select() that accidentally projects a
    // narrower column set and drops the new field.
    const created = await createMode({
      name: "Listed Ext Mode",
      slug: "listed-ext-" + Date.now(),
      systemPromptInstruction: "List me.",
      extensionIds: ["listed-x"],
    });
    const all = await listModes();
    const found = all.find((m) => m.id === created.id);
    expect(found).toBeDefined();
    expect(found!.extensionIds).toEqual(["listed-x"]);
  });

  test("seeded built-in modes have extensionIds=null (no attached extensions by default)", async () => {
    // Built-ins ship with toolRestriction='read-only' and no extension
    // attachments. The migration must NOT have backfilled the column
    // with a non-null default; the executor's null-vs-empty branching
    // depends on this.
    const plan = await getMode("builtin-plan");
    const review = await getMode("builtin-code-review");
    expect(plan!.extensionIds).toBeNull();
    expect(review!.extensionIds).toBeNull();
  });
});

// ── Conversation modeId FK ────────────────────────────────────────────

describe("conversation modeId", () => {
  test("createConversation defaults modeId to null", async () => {
    const conv = await createConversation(projectId);
    expect(conv.modeId).toBeNull();
  });

  test("updateConversation sets modeId", async () => {
    const conv = await createConversation(projectId);
    const updated = await updateConversation(conv.id, { modeId: "builtin-plan" });
    expect(updated!.modeId).toBe("builtin-plan");
  });

  test("updateConversation clears modeId with null", async () => {
    const conv = await createConversation(projectId);
    await updateConversation(conv.id, { modeId: "builtin-plan" });
    const updated = await updateConversation(conv.id, { modeId: null });
    expect(updated!.modeId).toBeNull();
  });
});

// ── resolveSystemPrompt with modes ────────────────────────────────────

describe("resolveSystemPrompt with modes", () => {
  let spProjectId: string;

  beforeAll(async () => {
    const project = await createProject({ name: "SP Mode Project", path: "/tmp/sp-mode" });
    spProjectId = project.id;
  });

  test("prepend mode instruction to conversation system prompt", async () => {
    const conv = await createConversation(spProjectId);
    await updateConversation(conv.id, { systemPrompt: "You are a helpful assistant." });

    const prompt = await resolveSystemPrompt(conv.id, spProjectId, "builtin-plan");
    expect(prompt).toContain("planning mode");
    expect(prompt).toContain("You are a helpful assistant.");
    // Mode instruction comes first (prepend)
    expect(prompt!.indexOf("planning mode")).toBeLessThan(prompt!.indexOf("helpful assistant"));
  });

  test("prepend mode instruction to project-level prompt", async () => {
    const conv = await createConversation(spProjectId);
    await upsertSetting(`project:${spProjectId}:systemPrompt`, "Project-level instructions");

    const prompt = await resolveSystemPrompt(conv.id, spProjectId, "builtin-plan");
    expect(prompt).toContain("planning mode");
    expect(prompt).toContain("Project-level instructions");

    await deleteSetting(`project:${spProjectId}:systemPrompt`);
  });

  test("prepend mode instruction to global prompt", async () => {
    const conv = await createConversation(spProjectId);
    await upsertSetting("global:systemPrompt", "Global instructions");

    const prompt = await resolveSystemPrompt(conv.id, spProjectId, "builtin-plan");
    expect(prompt).toContain("planning mode");
    expect(prompt).toContain("Global instructions");

    await deleteSetting("global:systemPrompt");
  });

  test("mode instruction alone when no base prompt exists", async () => {
    const conv = await createConversation(spProjectId);

    const prompt = await resolveSystemPrompt(conv.id, spProjectId, "builtin-plan");
    expect(prompt).toContain("planning mode");
  });

  test("append instruction position", async () => {
    const appendMode = await createMode({
      name: "Append Mode",
      slug: "append-mode-" + Date.now(),
      systemPromptInstruction: "APPENDED INSTRUCTION",
      instructionPosition: "append",
    });

    const conv = await createConversation(spProjectId);
    await updateConversation(conv.id, { systemPrompt: "Base prompt." });

    const prompt = await resolveSystemPrompt(conv.id, spProjectId, appendMode.id);
    expect(prompt).toBe("Base prompt.\n\nAPPENDED INSTRUCTION");
  });

  test("replace instruction position overrides base prompt", async () => {
    const replaceMode = await createMode({
      name: "Replace Mode",
      slug: "replace-mode-" + Date.now(),
      systemPromptInstruction: "REPLACED INSTRUCTION",
      instructionPosition: "replace",
    });

    const conv = await createConversation(spProjectId);
    await updateConversation(conv.id, { systemPrompt: "This should be gone." });

    const prompt = await resolveSystemPrompt(conv.id, spProjectId, replaceMode.id);
    expect(prompt).toBe("REPLACED INSTRUCTION");
  });

  test("null modeId returns base prompt unchanged", async () => {
    const conv = await createConversation(spProjectId);
    await updateConversation(conv.id, { systemPrompt: "Just the base." });

    const prompt = await resolveSystemPrompt(conv.id, spProjectId, null);
    expect(prompt).toBe("Just the base.");
  });

  test("undefined modeId returns base prompt unchanged", async () => {
    const conv = await createConversation(spProjectId);
    await updateConversation(conv.id, { systemPrompt: "Just the base." });

    const prompt = await resolveSystemPrompt(conv.id, spProjectId, undefined);
    expect(prompt).toBe("Just the base.");
  });

  test("non-existent modeId returns base prompt unchanged", async () => {
    const conv = await createConversation(spProjectId);
    await updateConversation(conv.id, { systemPrompt: "Base stays." });

    const prompt = await resolveSystemPrompt(conv.id, spProjectId, "nonexistent-mode-id");
    expect(prompt).toBe("Base stays.");
  });

  test("mode with empty instruction returns base prompt unchanged", async () => {
    // Edge case: a mode that exists but has empty instruction (shouldn't happen via API validation, but be safe)
    const emptyMode = await createMode({
      name: "Empty Mode",
      slug: "empty-mode-" + Date.now(),
      systemPromptInstruction: "",
    });

    const conv = await createConversation(spProjectId);
    await updateConversation(conv.id, { systemPrompt: "Base prompt." });

    // Empty string is falsy, so mode instruction won't be applied
    const prompt = await resolveSystemPrompt(conv.id, spProjectId, emptyMode.id);
    expect(prompt).toBe("Base prompt.");
  });

  test("conversation-level prompt takes priority in base resolution", async () => {
    const conv = await createConversation(spProjectId);
    await updateConversation(conv.id, { systemPrompt: "Conv prompt." });
    await upsertSetting(`project:${spProjectId}:systemPrompt`, "Project prompt.");

    const prompt = await resolveSystemPrompt(conv.id, spProjectId, "builtin-plan");
    // Base should be conv-level, mode prepended
    expect(prompt).toContain("Conv prompt.");
    expect(prompt).not.toContain("Project prompt.");
    expect(prompt).toContain("planning mode");

    await deleteSetting(`project:${spProjectId}:systemPrompt`);
  });

  test("append with no base prompt returns instruction alone", async () => {
    const appendMode = await createMode({
      name: "Append No Base",
      slug: "append-no-base-" + Date.now(),
      systemPromptInstruction: "APPENDED ONLY",
      instructionPosition: "append",
    });

    const conv = await createConversation(spProjectId);
    const prompt = await resolveSystemPrompt(conv.id, spProjectId, appendMode.id);
    expect(prompt).toBe("APPENDED ONLY");
  });

  test("prepend with no base prompt returns instruction alone", async () => {
    const prependMode = await createMode({
      name: "Prepend No Base",
      slug: "prepend-no-base-" + Date.now(),
      systemPromptInstruction: "PREPENDED ONLY",
      instructionPosition: "prepend",
    });

    const conv = await createConversation(spProjectId);
    const prompt = await resolveSystemPrompt(conv.id, spProjectId, prependMode.id);
    expect(prompt).toBe("PREPENDED ONLY");
  });

  test("replace with no base prompt returns instruction alone", async () => {
    const replaceMode = await createMode({
      name: "Replace No Base",
      slug: "replace-no-base-" + Date.now(),
      systemPromptInstruction: "REPLACED ONLY",
      instructionPosition: "replace",
    });

    const conv = await createConversation(spProjectId);
    const prompt = await resolveSystemPrompt(conv.id, spProjectId, replaceMode.id);
    expect(prompt).toBe("REPLACED ONLY");
  });

  test("prepend produces exact format: instruction + newlines + base", async () => {
    const mode = await createMode({
      name: "Exact Prepend",
      slug: "exact-prepend-" + Date.now(),
      systemPromptInstruction: "MODE INSTRUCTION",
      instructionPosition: "prepend",
    });

    const conv = await createConversation(spProjectId);
    await updateConversation(conv.id, { systemPrompt: "BASE PROMPT" });

    const prompt = await resolveSystemPrompt(conv.id, spProjectId, mode.id);
    expect(prompt).toBe("MODE INSTRUCTION\n\nBASE PROMPT");
  });

  test("append produces exact format: base + newlines + instruction", async () => {
    const mode = await createMode({
      name: "Exact Append",
      slug: "exact-append-" + Date.now(),
      systemPromptInstruction: "MODE INSTRUCTION",
      instructionPosition: "append",
    });

    const conv = await createConversation(spProjectId);
    await updateConversation(conv.id, { systemPrompt: "BASE PROMPT" });

    const prompt = await resolveSystemPrompt(conv.id, spProjectId, mode.id);
    expect(prompt).toBe("BASE PROMPT\n\nMODE INSTRUCTION");
  });

  test("replace completely discards base prompt", async () => {
    const mode = await createMode({
      name: "Full Replace",
      slug: "full-replace-" + Date.now(),
      systemPromptInstruction: "ONLY THIS",
      instructionPosition: "replace",
    });

    const conv = await createConversation(spProjectId);
    await updateConversation(conv.id, { systemPrompt: "THIS SHOULD NOT APPEAR" });
    await upsertSetting(`project:${spProjectId}:systemPrompt`, "NOR THIS");
    await upsertSetting("global:systemPrompt", "NOR THIS EITHER");

    const prompt = await resolveSystemPrompt(conv.id, spProjectId, mode.id);
    expect(prompt).toBe("ONLY THIS");
    expect(prompt).not.toContain("SHOULD NOT");
    expect(prompt).not.toContain("NOR THIS");

    await deleteSetting(`project:${spProjectId}:systemPrompt`);
    await deleteSetting("global:systemPrompt");
  });

  test("code-review mode prepends review instruction", async () => {
    const conv = await createConversation(spProjectId);
    await updateConversation(conv.id, { systemPrompt: "You are helpful." });

    const prompt = await resolveSystemPrompt(conv.id, spProjectId, "builtin-code-review");
    expect(prompt).toContain("code review mode");
    expect(prompt).toContain("You are helpful.");
    // Prepend: review instruction comes first
    expect(prompt!.indexOf("code review")).toBeLessThan(prompt!.indexOf("helpful"));
  });
});

// ── Tool restriction filtering logic ──────────────────────────────────

describe("tool restriction filtering", () => {
  // Simulates the executor's tool filtering logic (executor.ts lines 524-538)
  // without needing the full streaming infrastructure
  type MockTool = { name: string };
  type MockToolDef = { name: string; category: "read" | "write" | "execute" };

  function applyToolRestriction(
    tools: MockTool[],
    toolDefs: Map<string, MockToolDef>,
    restriction: "all" | "read-only" | "none",
  ): MockTool[] {
    if (restriction === "read-only") {
      return tools.filter(t => {
        const def = toolDefs.get(t.name);
        return def ? def.category === "read" : false;
      });
    }
    if (restriction === "none") return [];
    return tools;
  }

  const allTools: MockTool[] = [
    { name: "readFile" },
    { name: "grep" },
    { name: "glob" },
    { name: "editFile" },
    { name: "shell" },
  ];

  const toolDefs = new Map<string, MockToolDef>([
    ["readFile", { name: "readFile", category: "read" }],
    ["grep", { name: "grep", category: "read" }],
    ["glob", { name: "glob", category: "read" }],
    ["editFile", { name: "editFile", category: "write" }],
    ["shell", { name: "shell", category: "execute" }],
  ]);

  test("toolRestriction 'all' keeps all tools", () => {
    const result = applyToolRestriction(allTools, toolDefs, "all");
    expect(result).toHaveLength(5);
  });

  test("toolRestriction 'read-only' filters to read category only", async () => {
    const result = applyToolRestriction(allTools, toolDefs, "read-only");
    expect(result).toHaveLength(3);
    expect(result.map(t => t.name)).toEqual(["readFile", "grep", "glob"]);
  });

  test("toolRestriction 'none' removes all tools", async () => {
    const result = applyToolRestriction(allTools, toolDefs, "none");
    expect(result).toHaveLength(0);
  });

  test("read-only excludes extension tools (not in builtinToolDefsMap)", async () => {
    const toolsWithExtension: MockTool[] = [
      ...allTools,
      { name: "ext-custom-tool" },
    ];
    const result = applyToolRestriction(toolsWithExtension, toolDefs, "read-only");
    // Extension tool not in toolDefs → excluded
    expect(result.map(t => t.name)).not.toContain("ext-custom-tool");
    expect(result).toHaveLength(3);
  });

  test("built-in plan mode has read-only restriction", async () => {
    const mode = await getMode("builtin-plan");
    expect(mode!.toolRestriction).toBe("read-only");
  });

  test("built-in code-review mode has read-only restriction", async () => {
    const mode = await getMode("builtin-code-review");
    expect(mode!.toolRestriction).toBe("read-only");
  });

  test("read-only with empty tools array returns empty", () => {
    const result = applyToolRestriction([], toolDefs, "read-only");
    expect(result).toHaveLength(0);
  });

  test("all with empty tools array returns empty", () => {
    const result = applyToolRestriction([], toolDefs, "all");
    expect(result).toHaveLength(0);
  });

  test("read-only keeps only read tools, excludes write and execute", () => {
    const result = applyToolRestriction(allTools, toolDefs, "read-only");
    const names = result.map(t => t.name);
    expect(names).toContain("readFile");
    expect(names).toContain("grep");
    expect(names).toContain("glob");
    expect(names).not.toContain("editFile");
    expect(names).not.toContain("shell");
  });
});

// ── Seeded mode field verification ──────────────────────────────────

describe("seeded built-in mode fields", () => {
  test("plan mode has correct fields", async () => {
    const mode = await getMode("builtin-plan");
    expect(mode).not.toBeUndefined();
    expect(mode!.name).toBe("Plan");
    expect(mode!.slug).toBe("plan");
    expect(mode!.builtin).toBe(true);
    expect(mode!.toolRestriction).toBe("read-only");
    expect(mode!.instructionPosition).toBe("prepend");
    expect(mode!.preferredThinkingLevel).toBe("high");
    expect(mode!.systemPromptInstruction).toBeTruthy();
    expect(mode!.description).toBeTruthy();
  });

  test("code-review mode has correct fields", async () => {
    const mode = await getMode("builtin-code-review");
    expect(mode).not.toBeUndefined();
    expect(mode!.name).toBe("Code Review");
    expect(mode!.slug).toBe("code-review");
    expect(mode!.builtin).toBe(true);
    expect(mode!.toolRestriction).toBe("read-only");
    expect(mode!.instructionPosition).toBe("prepend");
    expect(mode!.systemPromptInstruction).toBeTruthy();
    expect(mode!.description).toBeTruthy();
  });
});
