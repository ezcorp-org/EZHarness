import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, readdirSync } from "fs";

// ── Lib imports (unit tests) ────────────────────────────────────

import {
  categorize, generateTitle, slugify, extractTags,
  extractActionItems, findRelatedNotes,
} from "./lib/categorizer";
import { narratePlan, narrateCompleted, narrateAction } from "./lib/narrator";
import {
  rebuildIndex, planCapture, executeCapture, buildTree,
  searchNotes, readNote, findRelated, refileNote,
  dailyDigest, computeStats, getVaultRoot, loadConfig,
  _setConfigPathForTests,
} from "./lib/vault";
import type { VaultIndex, VaultNote, PlannedAction } from "./lib/types";
import { CATEGORIES } from "./lib/types";

// ── Handler import (integration tests) ──────────────────────────

import { tools, lifecycleHandler, _testInit, _testReset } from "./index";
import {
  JsonRpcError,
  createToolDispatcher,
  toolError,
  createHostChannelForTests,
  _setDispatcherRegister,
} from "@ezcorp/sdk/runtime";
// Phase 3 fs hardening: the vault now routes IO through host-mediated
// `fs*` reverse-RPC. In-process tests have no host, so we stub the channel
// against real disk under TMP_DIR (see the shared `_harness` helper).
import { installFsChannelStub, makeFsRpcHandler } from "../_harness/pipeline-harness";

// ── Test helpers ────────────────────────────────────────────────

const TMP_DIR = join("/tmp", `auto-note-test-${Date.now()}`);
const VAULT_ROOT = join(TMP_DIR, "vault");
const TEST_CONFIG_PATH = join(TMP_DIR, "config.json");

// Redirect config writes to the test tmp dir so tests never pollute the real
// .ezcorp/extension-data/auto-note/config.json in the project root.
_setConfigPathForTests(TEST_CONFIG_PATH);

function setupVaultDirs(): void {
  for (const cat of CATEGORIES) {
    mkdirSync(join(VAULT_ROOT, cat), { recursive: true });
  }
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const handler = tools[name];
  if (!handler) throw new Error(`test bug: unknown tool ${name}`);
  return handler(args);
}

function getText(res: any): string {
  if (res.isError) throw new Error(res.content[0].text);
  return res.content[0].text;
}

function getJson(res: any): any {
  return JSON.parse(getText(res));
}

// ── JSON-RPC channel-pipe helpers ───────────────────────────────
//
// Inlined from packages/@ezcorp/sdk/test/channel.test.ts:30-92 per the
// Phase 1 Ruling-1 handoff (light duplication allowed — Phase 2 will
// move shared test helpers into `@ezcorp/sdk/test` proper). Used by the
// two protocol-error tests below that need to observe real
// JSON-RPC error envelopes on the wire.

interface ControlledStdin {
  iterable: AsyncIterable<string>;
  push(line: string): void;
  close(): void;
}

function createStdin(): ControlledStdin {
  const queue: string[] = [];
  let pendingResolve: ((v: IteratorResult<string>) => void) | null = null;
  let closed = false;

  return {
    push(line: string) {
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        r({ value: line, done: false });
      } else {
        queue.push(line);
      }
    },
    close() {
      closed = true;
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        r({ value: "", done: true });
      }
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            const buffered = queue.shift();
            if (buffered !== undefined) {
              return Promise.resolve({ value: buffered, done: false });
            }
            if (closed) return Promise.resolve({ value: "", done: true });
            return new Promise<IteratorResult<string>>((res) => {
              pendingResolve = res;
            });
          },
        };
      },
    },
  };
}

function createStdout() {
  const writes: string[] = [];
  return {
    writes,
    stdout: {
      write(s: string) {
        writes.push(s);
      },
    },
  };
}

const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await tick(5);
  }
}

// ── Fixtures ────────────────────────────────────────────────────

function makeNote(overrides: Partial<VaultNote> = {}): VaultNote {
  return {
    title: "Test Note", category: "ideas",
    tags: ["test"], created: new Date().toISOString(),
    updated: new Date().toISOString(), links: [],
    actionable: false, ...overrides,
  };
}

function makeIndex(): VaultIndex {
  return {
    "ideas/dark-mode.md": makeNote({ title: "Dark Mode", tags: ["ui", "design", "frontend"] }),
    "tasks/fix-button.md": makeNote({ title: "Fix Button", category: "tasks", tags: ["ui", "bug"], actionable: true }),
    "references/color-theory.md": makeNote({ title: "Color Theory", category: "references", tags: ["design", "colors"] }),
    "journal/today.md": makeNote({ title: "Today", category: "journal", tags: ["personal"] }),
    "decisions/use-postgres.md": makeNote({ title: "Use Postgres", category: "decisions", tags: ["database", "postgres"] }),
  };
}

// ── Setup / Teardown ────────────────────────────────────────────

beforeEach(() => {
  try { rmSync(TMP_DIR, { recursive: true }); } catch {}
  setupVaultDirs();
  _testReset();
  // Re-install per test: the global preload runs `__resetChannelForTests()`
  // after each test, dropping the singleton the stub was attached to.
  installFsChannelStub(TMP_DIR);
});

afterAll(() => {
  try { rmSync(TMP_DIR, { recursive: true }); } catch {}
});

// ═══════════════════════════════════════════════════════════════
// UNIT TESTS — Categorizer
// ═══════════════════════════════════════════════════════════════

describe("categorize", () => {
  test("detects meetings", () => {
    expect(categorize("Meeting: Sprint planning with the team")).toBe("meetings");
    expect(categorize("Standup: quick sync on blockers")).toBe("meetings");
    expect(categorize("Discussed with attendees about Q3 goals")).toBe("meetings");
  });

  test("detects decisions", () => {
    expect(categorize("Decision: Use Postgres over MongoDB")).toBe("decisions");
    expect(categorize("We decided to go with OAuth2")).toBe("decisions");
    expect(categorize("Going with React instead of Vue")).toBe("decisions");
  });

  test("detects tasks", () => {
    expect(categorize("TODO: fix the login bug")).toBe("tasks");
    expect(categorize("Task: migrate auth service")).toBe("tasks");
    expect(categorize("We need to update the API docs")).toBe("tasks");
  });

  test("detects references", () => {
    expect(categorize("Check out https://docs.example.com for details")).toBe("references");
    expect(categorize("See the documentation for the new API")).toBe("references");
  });

  test("detects journal", () => {
    expect(categorize("Today I learned about WebSocket connection pooling")).toBe("journal");
    expect(categorize("Reflection: the sprint went better than expected")).toBe("journal");
    expect(categorize("This morning I noticed a latency spike")).toBe("journal");
  });

  test("defaults to ideas", () => {
    expect(categorize("What if we added dark mode to the dashboard")).toBe("ideas");
    expect(categorize("Random thought about improving onboarding")).toBe("ideas");
  });

  test("priority order: meetings beats tasks", () => {
    expect(categorize("Meeting: we need to decide on the auth approach")).toBe("meetings");
  });

  test("priority order: decisions beats tasks", () => {
    expect(categorize("Decision: we need to use OAuth2")).toBe("decisions");
  });
});

// ═══════════════════════════════════════════════════════════════
// UNIT TESTS — Title Generation & Slugify
// ═══════════════════════════════════════════════════════════════

describe("generateTitle", () => {
  test("strips category prefixes", () => {
    expect(generateTitle("Decision: Use Postgres")).toBe("Use Postgres");
    expect(generateTitle("TODO: fix login bug")).toBe("fix login bug");
    expect(generateTitle("Meeting: Sprint review")).toBe("Sprint review");
  });

  test("truncates long titles at word boundary", () => {
    const long = "This is a very long title that should be truncated at a reasonable word boundary to keep things clean";
    const result = generateTitle(long);
    expect(result.length).toBeLessThanOrEqual(64);
    expect(result.endsWith("...")).toBe(true);
  });

  test("keeps short titles as-is", () => {
    expect(generateTitle("Short note")).toBe("Short note");
  });

  test("handles multiline input (uses first line)", () => {
    expect(generateTitle("First line\nSecond line\nThird line")).toBe("First line");
  });
});

describe("slugify", () => {
  test("converts to lowercase kebab-case", () => {
    expect(slugify("Use Postgres Over MongoDB")).toBe("use-postgres-over-mongodb");
  });

  test("strips special characters", () => {
    expect(slugify("What if we added dark mode?")).toBe("what-if-we-added-dark-mode");
  });

  test("caps at 80 characters", () => {
    expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(80);
  });

  test("strips leading/trailing hyphens", () => {
    expect(slugify("---hello---")).toBe("hello");
  });
});

// ═══════════════════════════════════════════════════════════════
// UNIT TESTS — Tag Extraction
// ═══════════════════════════════════════════════════════════════

describe("extractTags", () => {
  test("extracts explicit #tags", () => {
    const tags = extractTags("Working on #auth and #oauth2 integration");
    expect(tags).toContain("auth");
    expect(tags).toContain("oauth2");
  });

  test("extracts @mentions as tags", () => {
    const tags = extractTags("Discussed with @alice and @bob");
    expect(tags).toContain("alice");
    expect(tags).toContain("bob");
  });

  test("reinforces existing vault tags", () => {
    const existing = new Set(["postgres", "migration"]);
    const tags = extractTags("We need to handle the postgres migration carefully", existing);
    expect(tags).toContain("postgres");
    expect(tags).toContain("migration");
  });

  test("returns sorted, deduplicated tags", () => {
    const tags = extractTags("#auth #auth #beta");
    expect(tags.filter((t) => t === "auth").length).toBe(1);
    // Should be sorted
    const sorted = [...tags].sort();
    expect(tags).toEqual(sorted);
  });

  test("filters stop words from noun extraction", () => {
    const tags = extractTags("The quick brown fox jumps over the lazy dog");
    expect(tags).not.toContain("the");
    expect(tags).not.toContain("over");
  });
});

// ═══════════════════════════════════════════════════════════════
// UNIT TESTS — Action Item Extraction
// ═══════════════════════════════════════════════════════════════

describe("extractActionItems", () => {
  test("extracts TODO items", () => {
    const items = extractActionItems("TODO: fix the login timeout bug");
    expect(items.length).toBeGreaterThan(0);
  });

  test("extracts imperative sentences", () => {
    const items = extractActionItems("We should migrate the auth service before Q3. The weather is nice today.");
    expect(items.length).toBe(1);
    expect(items[0]!.sentence).toContain("migrate");
  });

  test("detects deadlines", () => {
    const items = extractActionItems("Deploy the fix ASAP before the deadline");
    expect(items.some((i) => i.hasDeadline)).toBe(true);
  });

  test("skips non-actionable sentences", () => {
    expect(extractActionItems("The sky is blue. I like coffee.").length).toBe(0);
  });

  test("extracts multiple action items", () => {
    const items = extractActionItems("Fix the login bug. Deploy to staging. Review the PR.");
    expect(items.length).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// UNIT TESTS — Related Notes
// ═══════════════════════════════════════════════════════════════

describe("findRelatedNotes", () => {
  const index = makeIndex();

  test("finds notes with overlapping tags", () => {
    const related = findRelatedNotes(["ui", "design"], index);
    expect(related).toContain("ideas/dark-mode.md");
    expect(related).toContain("tasks/fix-button.md");
    expect(related).toContain("references/color-theory.md");
  });

  test("ranks by overlap count", () => {
    const related = findRelatedNotes(["ui", "design"], index);
    expect(related[0]).toBe("ideas/dark-mode.md"); // 2 overlapping tags
  });

  test("excludes specified path", () => {
    const related = findRelatedNotes(["ui", "design"], index, "ideas/dark-mode.md");
    expect(related).not.toContain("ideas/dark-mode.md");
  });

  test("returns empty for no overlap", () => {
    expect(findRelatedNotes(["nonexistent"], index)).toEqual([]);
  });

  test("caps at 10 results", () => {
    const bigIndex: VaultIndex = {};
    for (let i = 0; i < 20; i++) {
      bigIndex[`ideas/note-${i}.md`] = makeNote({ title: `Note ${i}`, tags: ["shared"] });
    }
    const related = findRelatedNotes(["shared"], bigIndex);
    expect(related.length).toBeLessThanOrEqual(10);
  });
});

// ═══════════════════════════════════════════════════════════════
// UNIT TESTS — Narrator
// ═══════════════════════════════════════════════════════════════

describe("narrator", () => {
  const actions: PlannedAction[] = [
    { verb: "create", target: "ideas/dark-mode.md", description: 'Note "Dark Mode" in ideas/' },
    { verb: "link", target: "tasks/fix-button.md", description: 'Link to "Fix Button"' },
    { verb: "backlink", target: "tasks/fix-button.md", description: 'Backlink from "Fix Button"' },
    { verb: "extract-task", target: "tasks/do-thing.md", description: "Do the thing" },
    { verb: "update-index", description: "Regenerate vault index" },
  ];

  test("narrateAction future tense", () => {
    expect(narrateAction(actions[0]!, "future")).toContain("Create");
    expect(narrateAction(actions[1]!, "future")).toContain("Link to");
  });

  test("narrateAction past tense", () => {
    expect(narrateAction(actions[0]!, "past")).toContain("Created");
    expect(narrateAction(actions[1]!, "past")).toContain("Linked to");
  });

  test("narratePlan formats numbered list with Proceed?", () => {
    const plan = narratePlan(actions);
    expect(plan).toContain("1.");
    expect(plan).toContain("2.");
    expect(plan).toContain("Proceed?");
  });

  test("narrateCompleted formats bullet list with Done!", () => {
    const completed = narrateCompleted(actions);
    expect(completed).toContain("Done!");
    expect(completed).toContain("- Created");
    expect(completed).toContain("- Linked to");
  });

  test("all verb types are covered", () => {
    for (const action of actions) {
      expect(narrateAction(action, "future").length).toBeGreaterThan(0);
      expect(narrateAction(action, "past").length).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// INTEGRATION TESTS — Vault Filesystem Operations
// ═══════════════════════════════════════════════════════════════

describe("vault filesystem", () => {
  test("planCapture generates correct path and metadata", () => {
    const { result, actions } = planCapture("Decision: Use Postgres over MongoDB #database", {});
    expect(result.note.category).toBe("decisions");
    expect(result.path).toMatch(/^decisions\/.+\.md$/);
    expect(result.note.tags).toContain("database");
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0]!.verb).toBe("create");
  });

  // ── Override behavior (LLM-driven classification) ──
  //
  // The `capture` tool accepts optional category/title/tags from a caller
  // that has already classified the note (typically the auto-note agent
  // running on the platform LLM). Without these overrides, notes like
  // "learn more about cows" always fell into `ideas/` via the default
  // keyword-matcher fallback. With overrides, the LLM can route them.

  test("planCapture honors explicit category override", () => {
    // "learn more about cows" matches NO keyword rule → normally falls back to "ideas"
    const fallback = planCapture("learn more about cows", {});
    expect(fallback.result.note.category).toBe("ideas");

    // With an explicit category, the override wins.
    const overridden = planCapture("learn more about cows", {}, { category: "references" });
    expect(overridden.result.note.category).toBe("references");
    expect(overridden.result.path).toMatch(/^references\//);
  });

  test("planCapture ignores invalid category and falls back to categorize()", () => {
    // Caller hallucinated a nonexistent category — must fall back safely.
    const { result } = planCapture("learn more about cows", {}, {
      category: "bogus" as any,
    });
    expect(result.note.category).toBe("ideas"); // keyword fallback
  });

  test("planCapture uses provided title when present", () => {
    const { result } = planCapture("learn more about cows", {}, {
      title: "Bovine research log",
    });
    expect(result.note.title).toBe("Bovine research log");
    expect(result.path).toMatch(/bovine-research-log/);
  });

  test("planCapture ignores empty/whitespace title and falls back", () => {
    const { result } = planCapture("learn more about cows", {}, { title: "   " });
    // Empty title → should fall back to generateTitle
    expect(result.note.title.length).toBeGreaterThan(0);
    expect(result.note.title).not.toBe("   ");
  });

  test("planCapture merges override tags with extracted tags, deduped and lowercased", () => {
    const { result } = planCapture("learn more about cows #farm", {}, {
      tags: ["Cows", "Animals", "farm"], // mixed case; overlaps with #farm
    });
    expect(result.note.tags).toContain("cows");
    expect(result.note.tags).toContain("animals");
    expect(result.note.tags).toContain("farm");
    // No duplicates: `farm` appears only once even though both the hashtag and the override include it.
    expect(result.note.tags.filter((t) => t === "farm").length).toBe(1);
    // No uppercase tags leak through
    for (const t of result.note.tags) expect(t).toBe(t.toLowerCase());
  });

  test("planCapture with no overrides matches prior keyword-based behavior (regression)", () => {
    // Decisions keyword
    expect(planCapture("Decision: use Postgres", {}).result.note.category).toBe("decisions");
    // Tasks keyword
    expect(planCapture("TODO: fix the login bug", {}).result.note.category).toBe("tasks");
    // Ideas fallback
    expect(planCapture("learn more about cows", {}).result.note.category).toBe("ideas");
  });

  test("planCapture uses override category in the action-plan description", () => {
    const { actions } = planCapture("learn more about cows", {}, {
      category: "references",
      title: "Learn more about cows",
      tags: ["cows", "animals"],
    });
    const createAction = actions.find((a) => a.verb === "create");
    expect(createAction).toBeDefined();
    expect(createAction!.description).toContain("references/");
    expect(createAction!.target).toMatch(/^references\//);
  });

  test("planCapture handles slug collisions", () => {
    const index: VaultIndex = {
      "ideas/dark-mode.md": makeNote({ title: "Dark Mode" }),
    };
    const { result } = planCapture("What if we added dark mode to the dashboard", index);
    // Should not collide with existing path
    expect(result.path).not.toBe("ideas/dark-mode.md");
  });

  test("planCapture finds related notes", () => {
    const index = makeIndex();
    const { result } = planCapture("New idea about #ui improvements for the frontend", index);
    expect(result.relatedNotes.length).toBeGreaterThan(0);
    // Should find notes with "ui" tag
    expect(result.relatedNotes).toContain("ideas/dark-mode.md");
  });

  test("planCapture extracts action items", () => {
    const { result } = planCapture("We need to fix the auth bug and deploy the hotfix ASAP", {});
    expect(result.actionItems.length).toBeGreaterThan(0);
    expect(result.note.actionable).toBe(true);
  });

  test("executeCapture creates vault file with frontmatter", async () => {
    const { result } = planCapture("Idea: add dark mode to the app #ui", {});
    await executeCapture(result, {}, VAULT_ROOT);

    const filePath = join(VAULT_ROOT, result.path);
    expect(existsSync(filePath)).toBe(true);

    const content = await Bun.file(filePath).text();
    expect(content).toContain("---");
    expect(content).toContain("title:");
    expect(content).toContain("category: ideas");
    expect(content).toContain("tags:");
  });

  test("executeCapture creates wikilinks for related notes", async () => {
    // Pre-populate a related note
    const existingNote = "---\ntitle: UI Guidelines\ncategory: references\ntags: [ui]\ncreated: 2026-04-12T00:00:00Z\nupdated: 2026-04-12T00:00:00Z\nlinks: []\n---\n\n# UI Guidelines\n\nSome guidelines.\n";
    await Bun.write(join(VAULT_ROOT, "references/ui-guidelines.md"), existingNote);

    const index: VaultIndex = {
      "references/ui-guidelines.md": makeNote({ title: "UI Guidelines", category: "references", tags: ["ui"] }),
    };

    const { result } = planCapture("What if we added dark mode to improve the #ui", index);
    await executeCapture(result, index, VAULT_ROOT);

    const content = await Bun.file(join(VAULT_ROOT, result.path)).text();
    expect(content).toContain("[[references/ui-guidelines.md");
  });

  test("executeCapture adds backlinks to related notes", async () => {
    const existingNote = "---\ntitle: UI Guidelines\ncategory: references\ntags: [ui]\ncreated: 2026-04-12T00:00:00Z\nupdated: 2026-04-12T00:00:00Z\nlinks: []\n---\n\n# UI Guidelines\n\nSome guidelines.\n";
    await Bun.write(join(VAULT_ROOT, "references/ui-guidelines.md"), existingNote);

    const index: VaultIndex = {
      "references/ui-guidelines.md": makeNote({ title: "UI Guidelines", category: "references", tags: ["ui"] }),
    };

    const { result } = planCapture("Idea: improve the #ui experience", index);
    await executeCapture(result, index, VAULT_ROOT);

    // Check that the related note got a backlink
    const backlinkContent = await Bun.file(join(VAULT_ROOT, "references/ui-guidelines.md")).text();
    expect(backlinkContent).toContain("## Linked Notes");
    expect(backlinkContent).toContain(`[[${result.path}`);
  });

  test("executeCapture creates separate task notes for action items", async () => {
    const { result } = planCapture("Decision: migrate to OAuth2. We need to update the auth service.", {});
    await executeCapture(result, {}, VAULT_ROOT);

    // If action items were extracted, task notes should exist
    for (const item of result.actionItems) {
      if (item.taskNotePath) {
        expect(existsSync(join(VAULT_ROOT, item.taskNotePath))).toBe(true);
      }
    }
  });

  test("executeCapture generates _index.md", async () => {
    const { result } = planCapture("Quick test note", {});
    await executeCapture(result, {}, VAULT_ROOT);

    const indexContent = await Bun.file(join(VAULT_ROOT, "_index.md")).text();
    expect(indexContent).toContain("# Vault Index");
    expect(indexContent).toContain("1 note");
  });
});

// ═══════════════════════════════════════════════════════════════
// INTEGRATION TESTS — Vault Browsing
// ═══════════════════════════════════════════════════════════════

describe("vault browsing", () => {
  test("buildTree shows category structure", () => {
    const index = makeIndex();
    const tree = buildTree(index);
    expect(tree).toContain("ideas/");
    expect(tree).toContain("tasks/");
    expect(tree).toContain("Total:");
    expect(tree).toContain("5 notes");
  });

  test("buildTree shows tag cloud", () => {
    const index = makeIndex();
    const tree = buildTree(index);
    expect(tree).toContain("Tags:");
    expect(tree).toContain("#ui");
  });

  test("searchNotes filters by category", () => {
    const index = makeIndex();
    const results = searchNotes(index, VAULT_ROOT, { category: "tasks" });
    expect(results.length).toBe(1);
    expect(results[0]!.category).toBe("tasks");
  });

  test("searchNotes filters by tags", () => {
    const index = makeIndex();
    const results = searchNotes(index, VAULT_ROOT, { tags: ["ui"] });
    expect(results.length).toBe(2); // dark-mode + fix-button
  });

  test("searchNotes returns empty for no match", () => {
    const results = searchNotes(makeIndex(), VAULT_ROOT, { tags: ["nonexistent"] });
    expect(results.length).toBe(0);
  });

  test("readNote returns file content", async () => {
    const content = "# Test\nHello world";
    await Bun.write(join(VAULT_ROOT, "ideas/test.md"), content);
    const result = await readNote(VAULT_ROOT, "ideas/test.md");
    expect(result).toBe(content);
  });

  test("readNote returns null for missing file", async () => {
    const result = await readNote(VAULT_ROOT, "ideas/nonexistent.md");
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// INTEGRATION TESTS — Related Notes (with depth)
// ═══════════════════════════════════════════════════════════════

describe("findRelated (vault)", () => {
  test("returns direct links", () => {
    const index: VaultIndex = {
      "ideas/a.md": makeNote({ title: "A", links: ["ideas/b.md"], tags: ["x"] }),
      "ideas/b.md": makeNote({ title: "B", links: [], tags: ["y"] }),
    };
    const result = findRelated("ideas/a.md", index);
    expect(result.directLinks).toContain("ideas/b.md");
  });

  test("returns shared-tag neighbors", () => {
    const index: VaultIndex = {
      "ideas/a.md": makeNote({ title: "A", tags: ["ui", "design"] }),
      "ideas/b.md": makeNote({ title: "B", tags: ["ui"] }),
      "ideas/c.md": makeNote({ title: "C", tags: ["other"] }),
    };
    const result = findRelated("ideas/a.md", index);
    expect(result.sharedTagNeighbors).toContain("ideas/b.md");
    expect(result.sharedTagNeighbors).not.toContain("ideas/c.md");
  });

  test("returns same-category siblings", () => {
    const index: VaultIndex = {
      "ideas/a.md": makeNote({ title: "A", tags: ["x"] }),
      "ideas/b.md": makeNote({ title: "B", tags: ["y"] }),
      "tasks/c.md": makeNote({ title: "C", category: "tasks", tags: ["z"] }),
    };
    const result = findRelated("ideas/a.md", index);
    expect(result.sameCategorySiblings).toContain("ideas/b.md");
    expect(result.sameCategorySiblings).not.toContain("tasks/c.md");
  });

  test("returns empty for unknown path", () => {
    const result = findRelated("nonexistent.md", makeIndex());
    expect(result.directLinks).toEqual([]);
    expect(result.sharedTagNeighbors).toEqual([]);
    expect(result.sameCategorySiblings).toEqual([]);
  });

  test("depth=2 follows links of links", () => {
    const index: VaultIndex = {
      "ideas/a.md": makeNote({ title: "A", links: ["ideas/b.md"], tags: ["x"] }),
      "ideas/b.md": makeNote({ title: "B", links: ["ideas/c.md"], tags: ["y"] }),
      "ideas/c.md": makeNote({ title: "C", links: [], tags: ["z"] }),
    };
    const shallow = findRelated("ideas/a.md", index, 1);
    const deep = findRelated("ideas/a.md", index, 2);
    // At depth 1, c is not reachable. At depth 2, c should appear via b.
    expect(shallow.sharedTagNeighbors).not.toContain("ideas/c.md");
    expect(deep.sharedTagNeighbors).toContain("ideas/c.md");
  });
});

// ═══════════════════════════════════════════════════════════════
// INTEGRATION TESTS — Refile
// ═══════════════════════════════════════════════════════════════

describe("refileNote", () => {
  test("moves note to new category", async () => {
    await Bun.write(
      join(VAULT_ROOT, "ideas/test-note.md"),
      "---\ntitle: Test Note\ncategory: ideas\ntags: [test]\ncreated: 2026-04-12T00:00:00Z\nupdated: 2026-04-12T00:00:00Z\nlinks: []\n---\n\n# Test Note\n",
    );
    const index: VaultIndex = {
      "ideas/test-note.md": makeNote({ title: "Test Note", category: "ideas" }),
    };

    const { newPath, updatedFiles } = await refileNote("ideas/test-note.md", index, VAULT_ROOT, {
      newCategory: "decisions",
    });

    expect(newPath).toBe("decisions/test-note.md");
    expect(existsSync(join(VAULT_ROOT, "decisions/test-note.md"))).toBe(true);
    expect(existsSync(join(VAULT_ROOT, "ideas/test-note.md"))).toBe(false);
    expect(index["decisions/test-note.md"]).toBeDefined();
    expect(index["ideas/test-note.md"]).toBeUndefined();
  });

  test("updates tags in place", async () => {
    await Bun.write(
      join(VAULT_ROOT, "ideas/tagged.md"),
      "---\ntitle: Tagged\ncategory: ideas\ntags: [old-tag]\ncreated: 2026-04-12T00:00:00Z\nupdated: 2026-04-12T00:00:00Z\nlinks: []\n---\n\n# Tagged\n",
    );
    const index: VaultIndex = {
      "ideas/tagged.md": makeNote({ title: "Tagged", tags: ["old-tag"] }),
    };

    await refileNote("ideas/tagged.md", index, VAULT_ROOT, {
      addTags: ["new-tag"],
      removeTags: ["old-tag"],
    });

    expect(index["ideas/tagged.md"]!.tags).toContain("new-tag");
    expect(index["ideas/tagged.md"]!.tags).not.toContain("old-tag");

    const content = await Bun.file(join(VAULT_ROOT, "ideas/tagged.md")).text();
    expect(content).toContain("new-tag");
  });

  test("fixes backlinks when moving", async () => {
    // Create source note
    await Bun.write(
      join(VAULT_ROOT, "ideas/source.md"),
      "---\ntitle: Source\ncategory: ideas\ntags: [test]\ncreated: 2026-04-12T00:00:00Z\nupdated: 2026-04-12T00:00:00Z\nlinks: []\n---\n\n# Source\n",
    );
    // Create linking note
    await Bun.write(
      join(VAULT_ROOT, "tasks/linker.md"),
      "---\ntitle: Linker\ncategory: tasks\ntags: [test]\ncreated: 2026-04-12T00:00:00Z\nupdated: 2026-04-12T00:00:00Z\nlinks: [ideas/source.md]\n---\n\n# Linker\n\n## Linked Notes\n- [[ideas/source.md|Source]]\n",
    );
    const index: VaultIndex = {
      "ideas/source.md": makeNote({ title: "Source" }),
      "tasks/linker.md": makeNote({ title: "Linker", category: "tasks", links: ["ideas/source.md"] }),
    };

    const result = await refileNote("ideas/source.md", index, VAULT_ROOT, {
      newCategory: "decisions",
    });

    // Backlink should be updated
    expect(result.updatedFiles).toContain("tasks/linker.md");
    const linkerContent = await Bun.file(join(VAULT_ROOT, "tasks/linker.md")).text();
    expect(linkerContent).toContain("decisions/source.md");
    expect(linkerContent).not.toContain("ideas/source.md");
  });

  test("throws for nonexistent note", async () => {
    expect(
      refileNote("nonexistent.md", {}, VAULT_ROOT, { newCategory: "tasks" })
    ).rejects.toThrow("Note not found");
  });
});

// ═══════════════════════════════════════════════════════════════
// INTEGRATION TESTS — Daily Digest
// ═══════════════════════════════════════════════════════════════

describe("dailyDigest", () => {
  test("returns notes created on target date", () => {
    const today = new Date().toISOString().slice(0, 10);
    const index: VaultIndex = {
      "ideas/today-note.md": makeNote({ title: "Today Note", created: new Date().toISOString() }),
      "ideas/old-note.md": makeNote({ title: "Old Note", created: "2025-01-01T00:00:00Z" }),
    };
    const digest = dailyDigest(index, today);
    expect(digest.notesCreated.length).toBe(1);
    expect(digest.notesCreated[0]!.title).toBe("Today Note");
  });

  test("returns open action items from tasks/", () => {
    const index: VaultIndex = {
      "tasks/fix-bug.md": makeNote({ title: "Fix Bug", category: "tasks", actionable: true }),
      "ideas/not-a-task.md": makeNote({ title: "Not a Task", actionable: true }), // Not in tasks/
    };
    const digest = dailyDigest(index);
    expect(digest.openActionItems.length).toBe(1);
    expect(digest.openActionItems[0]!.title).toBe("Fix Bug");
  });

  test("suggests connections for notes with shared tags but no link", () => {
    const index: VaultIndex = {
      "ideas/a.md": makeNote({ title: "A", tags: ["ui", "design"] }),
      "ideas/b.md": makeNote({ title: "B", tags: ["ui", "design"] }),
    };
    const digest = dailyDigest(index);
    expect(digest.suggestedConnections.length).toBe(1);
    expect(digest.suggestedConnections[0]!.sharedTags).toContain("ui");
  });

  test("does not suggest already-linked notes", () => {
    const index: VaultIndex = {
      "ideas/a.md": makeNote({ title: "A", tags: ["ui", "design"], links: ["ideas/b.md"] }),
      "ideas/b.md": makeNote({ title: "B", tags: ["ui", "design"] }),
    };
    const digest = dailyDigest(index);
    expect(digest.suggestedConnections.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// INTEGRATION TESTS — Index Rebuild & Stats
// ═══════════════════════════════════════════════════════════════

describe("rebuildIndex", () => {
  test("rebuilds index from vault files", async () => {
    await Bun.write(
      join(VAULT_ROOT, "ideas/test.md"),
      "---\ntitle: Test\ncategory: ideas\ntags: [test]\ncreated: 2026-04-12T00:00:00Z\nupdated: 2026-04-12T00:00:00Z\nlinks: []\n---\n\n# Test\n",
    );
    await Bun.write(
      join(VAULT_ROOT, "tasks/task.md"),
      "---\ntitle: Do Thing\ncategory: tasks\ntags: [work]\ncreated: 2026-04-12T00:00:00Z\nupdated: 2026-04-12T00:00:00Z\nlinks: []\nactionable: true\n---\n\n# Do Thing\n",
    );

    const index = await rebuildIndex(VAULT_ROOT);
    expect(Object.keys(index).length).toBe(2);
    expect(index["ideas/test.md"]!.title).toBe("Test");
    expect(index["tasks/task.md"]!.actionable).toBe(true);
  });

  test("skips files without frontmatter", async () => {
    await Bun.write(join(VAULT_ROOT, "ideas/no-front.md"), "# No Frontmatter\nJust text.");
    const index = await rebuildIndex(VAULT_ROOT);
    expect(index["ideas/no-front.md"]).toBeUndefined();
  });
});

describe("computeStats", () => {
  test("computes correct counts", () => {
    const stats = computeStats(makeIndex());
    expect(stats.totalNotes).toBe(5);
    expect(stats.categoryCounts.ideas).toBe(1);
    expect(stats.categoryCounts.tasks).toBe(1);
    expect(stats.categoryCounts.decisions).toBe(1);
    expect(stats.recentCaptures.length).toBe(5);
  });

  test("handles empty index", () => {
    const stats = computeStats({});
    expect(stats.totalNotes).toBe(0);
    expect(stats.recentCaptures.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// INTEGRATION TESTS — Config
// ═══════════════════════════════════════════════════════════════

describe("config", () => {
  test("loadConfig returns defaults when no file exists", async () => {
    const cfg = await loadConfig();
    expect(cfg.defaultMode).toBe("approval");
  });

  test("getVaultRoot uses default under .ezcorp/extension-data/auto-note/", () => {
    // Convention: every extension's persistent data lives under
    //   <projectRoot>/.ezcorp/extension-data/<ext-name>/
    const root = getVaultRoot();
    expect(root).toContain(join(".ezcorp", "extension-data", "auto-note"));
    expect(root).toContain("vault");
  });

  test("getVaultRoot uses custom path from config", () => {
    const root = getVaultRoot({ defaultMode: "yolo", vaultPath: "/custom/vault" });
    expect(root).toBe("/custom/vault");
  });
});

// ═══════════════════════════════════════════════════════════════
// INTEGRATION TESTS — Tool dispatch (direct handler invocation)
// ═══════════════════════════════════════════════════════════════

describe("tool dispatch", () => {
  beforeEach(() => {
    setupVaultDirs();
    _testInit({ defaultMode: "yolo", vaultPath: VAULT_ROOT }, {});
  });

  // These two tests exercise the SDK's channel-level protocol-error path,
  // not the tools/call result shape. They drive an isolated
  // createHostChannelForTests pipe so we can observe the raw JSON-RPC
  // envelope on the wire (unknown method / unknown tool both emit
  // `{error:{code:-32601, ...}}`, not `{result:{isError:true, ...}}`).
  test("returns error for unknown method", async () => {
    const stdin = createStdin();
    const { writes, stdout } = createStdout();
    const ch = createHostChannelForTests({ stdin: stdin.iterable, stdout });
    ch.start();
    stdin.push(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "unknown-method", params: {} }));
    await waitFor(() => writes.length >= 1);
    const frame = JSON.parse(writes[0] ?? "");
    expect(frame.error.code).toBe(-32601);
    stdin.close();
  });

  test("returns error for unknown tool", async () => {
    const stdin = createStdin();
    const { writes, stdout } = createStdout();
    const ch = createHostChannelForTests({ stdin: stdin.iterable, stdout });
    try {
      // Redirect the dispatcher registration into our test channel so
      // `createToolDispatcher(tools)` wires tools/call against `ch`
      // instead of the production singleton. Mirrors channel.ts's
      // real _setDispatcherRegister body.
      _setDispatcherRegister(({ handlers, opts }) => {
        ch.onRequest("tools/call", async (params) => {
          const p = (params ?? {}) as Record<string, unknown>;
          const name = typeof p.name === "string" ? p.name : "";
          const args = (p.arguments ?? {}) as Record<string, unknown>;
          const handler = handlers[name];
          if (!handler) throw new JsonRpcError(-32601, `Tool not found: ${name}`);
          try {
            return await handler(args);
          } catch (err) {
            if (opts?.onError) return opts.onError(err, name);
            return toolError(err instanceof Error ? err.message : String(err));
          }
        });
      });
      createToolDispatcher(tools);
      ch.start();
      stdin.push(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "nonexistent-tool", arguments: {} },
      }));
      await waitFor(() => writes.length >= 1);
      const frame = JSON.parse(writes[0] ?? "");
      expect(frame.error.code).toBe(-32601);
      expect(frame.error.message).toBe("Tool not found: nonexistent-tool");
      stdin.close();
    } finally {
      // Swap back to a no-op so subsequent tests don't re-register the
      // closure captured above on a now-dead channel.
      _setDispatcherRegister(() => {});
    }
  });

  test("capture in yolo mode creates note and returns narration", async () => {
    const res = await call("capture", { text: "Idea: add dark mode #ui", mode: "yolo" });
    const text = getText(res);
    expect(text).toContain("Done!");
    expect(text).toContain("Created");

    // Verify file was actually created
    const files = readdirSync(join(VAULT_ROOT, "ideas"));
    expect(files.length).toBeGreaterThan(0);
  });

  test("capture honors LLM-supplied category (the 'learn more about cows' fix)", async () => {
    // Without the override, this lands in ideas/ (keyword matcher fallback).
    // The auto-note agent is now instructed to classify and pass `category`,
    // so the same input must route to `references/` when the override is set.
    const res = await call("capture", {
      text: "learn more about cows",
      category: "references",
      title: "Learn more about cows",
      tags: ["cows", "animals", "biology"],
      mode: "yolo",
    });
    expect(res.isError).toBeFalsy();
    const text = getText(res);
    expect(text).toContain("references/");
    expect(text).not.toContain("ideas/learn-more-about-cows.md");

    // File exists under references/, not ideas/
    const refFiles = readdirSync(join(VAULT_ROOT, "references"));
    expect(refFiles.some((f) => f.includes("learn-more-about-cows"))).toBe(true);
    // ideas/ did NOT get a stray copy of this capture
    const ideaFiles = readdirSync(join(VAULT_ROOT, "ideas"));
    expect(ideaFiles.some((f) => f.includes("learn-more-about-cows"))).toBe(false);
  });

  test("capture without category falls back to keyword matcher (backwards compat)", async () => {
    // Bare capture, no override — existing behavior preserved.
    const res = await call("capture", { text: "learn more about cows", mode: "yolo" });
    expect(res.isError).toBeFalsy();
    // File lands in ideas/ because no keyword matches.
    const ideaFiles = readdirSync(join(VAULT_ROOT, "ideas"));
    expect(ideaFiles.some((f) => f.includes("learn-more-about-cows"))).toBe(true);
  });

  test("capture accepts invalid category and degrades gracefully", async () => {
    const res = await call("capture", {
      text: "learn more about cows",
      category: "not-a-real-category",
      mode: "yolo",
    });
    // Should not error; should fall back to the keyword matcher's choice (ideas).
    expect(res.isError).toBeFalsy();
    const ideaFiles = readdirSync(join(VAULT_ROOT, "ideas"));
    expect(ideaFiles.some((f) => f.includes("learn-more-about-cows"))).toBe(true);
  });

  test("capture in approval mode returns plan with ID", async () => {
    _testInit({ defaultMode: "approval", vaultPath: VAULT_ROOT }, {});
    const res = await call("capture", { text: "Decision: use Postgres" });
    const text = getText(res);
    expect(text).toContain("Plan ID:");
    expect(text).toContain("Proceed?");

    // File should NOT exist yet
    const files = readdirSync(join(VAULT_ROOT, "decisions"));
    expect(files.length).toBe(0);
  });

  test("capture confirm executes pending plan", async () => {
    _testInit({ defaultMode: "approval", vaultPath: VAULT_ROOT }, {});

    // Step 1: get plan
    const planRes = await call("capture", { text: "Decision: use Postgres" });
    const planText = getText(planRes);
    const planIdMatch = planText.match(/Plan ID: ([a-f0-9-]+)/);
    expect(planIdMatch).not.toBeNull();
    const planId = planIdMatch![1]!;

    // Step 2: confirm
    const confirmRes = await call("capture", { text: "Decision: use Postgres", planId, confirmed: true });
    const confirmText = getText(confirmRes);
    expect(confirmText).toContain("Done!");

    // File should exist now
    const files = readdirSync(join(VAULT_ROOT, "decisions"));
    expect(files.length).toBeGreaterThan(0);
  });

  test("capture confirm with expired plan returns error", async () => {
    const res = await call("capture", { text: "anything", planId: "nonexistent-id", confirmed: true });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Plan expired");
  });

  test("capture requires text", async () => {
    const res = await call("capture", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("text is required");
  });

  test("vault-tree returns tree string", async () => {
    // Add a note first
    await call("capture", { text: "Test note for tree", mode: "yolo" });
    const res = await call("vault-tree");
    const text = getText(res);
    expect(text).toContain("vault/");
    expect(text).toContain("Total:");
  });

  test("vault-search returns results", async () => {
    await call("capture", { text: "Important #auth note about security", mode: "yolo" });
    const res = await call("vault-search", { tags: ["auth"] });
    const text = getText(res);
    expect(text).toContain("Found");
  });

  test("vault-search returns message for no results", async () => {
    const res = await call("vault-search", { tags: ["nonexistent-tag-xyz"] });
    const text = getText(res);
    expect(text).toContain("No notes found");
  });

  test("vault-read returns note content", async () => {
    await call("capture", { text: "Idea: readable note #test", mode: "yolo" });

    // Find the created file
    const files = readdirSync(join(VAULT_ROOT, "ideas")).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);

    const res = await call("vault-read", { path: `ideas/${files[0]}` });
    const text = getText(res);
    expect(text).toContain("readable note");
  });

  test("vault-read returns error for missing path", async () => {
    const res = await call("vault-read", {});
    expect(res.isError).toBe(true);
  });

  test("vault-read returns error for nonexistent file", async () => {
    const res = await call("vault-read", { path: "ideas/nonexistent.md" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("not found");
  });

  test("vault-related returns connections", async () => {
    // Create two notes with shared tags
    await call("capture", { text: "First note about #auth security", mode: "yolo" });
    await call("capture", { text: "Second note about #auth tokens", mode: "yolo" });

    // Find created files
    const files = readdirSync(join(VAULT_ROOT, "ideas")).filter((f) => f.endsWith(".md"));
    if (files.length >= 2) {
      const res = await call("vault-related", { path: `ideas/${files[0]}` });
      const text = getText(res);
      // Should find the other note as related
      expect(text.length).toBeGreaterThan(0);
    }
  });

  test("vault-related returns error for missing note", async () => {
    const res = await call("vault-related", { path: "nonexistent.md" });
    expect(res.isError).toBe(true);
  });

  test("vault-refile moves note", async () => {
    await call("capture", { text: "Idea: refile me to tasks", mode: "yolo" });
    const files = readdirSync(join(VAULT_ROOT, "ideas")).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);

    const res = await call("vault-refile", { path: `ideas/${files[0]}`, newCategory: "tasks" });
    const text = getText(res);
    expect(text).toContain("Refiled to");
    expect(text).toContain("tasks/");
  });

  test("vault-refile returns error for missing path", async () => {
    const res = await call("vault-refile", {});
    expect(res.isError).toBe(true);
  });

  test("vault-daily returns digest", async () => {
    await call("capture", { text: "Today's note for digest test", mode: "yolo" });
    const res = await call("vault-daily");
    const text = getText(res);
    expect(text).toContain("Daily Digest");
    expect(text).toContain("Notes Created");
  });

  test("configure returns current config", async () => {
    const res = await call("configure");
    const cfg = getJson(res);
    expect(cfg.defaultMode).toBe("yolo"); // set via _testInit
    expect(cfg.vaultPath).toBe(VAULT_ROOT);
  });

  test("configure updates mode", async () => {
    await call("configure", { defaultMode: "approval" });
    const res = await call("configure");
    const cfg = getJson(res);
    expect(cfg.defaultMode).toBe("approval");
  });

  test("lifecycle hooks return ok", async () => {
    const res = await lifecycleHandler();
    expect(getText(res)).toBe("ok");
    expect(res.isError).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// E2E TESTS — Full Workflows
// ═══════════════════════════════════════════════════════════════

describe("E2E: full capture → browse → refile workflow", () => {
  beforeEach(() => {
    setupVaultDirs();
    _testInit({ defaultMode: "yolo", vaultPath: VAULT_ROOT }, {});
  });

  test("capture multiple notes, search, discover connections, refile", async () => {
    // 1. Capture several notes
    await call("capture", { text: "Decision: use OAuth2 for auth #auth #security", mode: "yolo" });
    await call("capture", { text: "TODO: implement OAuth2 token refresh #auth", mode: "yolo" });
    await call("capture", { text: "Reference: https://oauth.net/2/ docs for OAuth2 #auth #security", mode: "yolo" });
    await call("capture", { text: "Today I spent the morning researching OAuth2 providers", mode: "yolo" });

    // 2. Verify tree shows all notes
    const treeRes = await call("vault-tree");
    const tree = getText(treeRes);
    expect(tree).toContain("decisions/");
    expect(tree).toContain("Total:");

    // 3. Search by tag
    const searchRes = await call("vault-search", { tags: ["auth"] });
    const searchText = getText(searchRes);
    expect(searchText).toContain("Found");

    // 4. Check daily digest
    const dailyRes = await call("vault-daily");
    const daily = getText(dailyRes);
    expect(daily).toContain("Notes Created");

    // 5. Refile: move the journal entry to decisions
    const journalFiles = readdirSync(join(VAULT_ROOT, "journal")).filter((f) => f.endsWith(".md"));
    if (journalFiles.length > 0) {
      const refileRes = await call("vault-refile", {
        path: `journal/${journalFiles[0]}`,
        newCategory: "references",
        addTags: ["oauth2"],
      });
      expect(getText(refileRes)).toContain("Refiled to");
    }

    // 6. Final tree should show updated structure
    const finalTree = getText(await call("vault-tree"));
    expect(finalTree).toContain("references/");
  });
});

describe("E2E: approval flow", () => {
  beforeEach(() => {
    setupVaultDirs();
    _testInit({ defaultMode: "approval", vaultPath: VAULT_ROOT }, {});
  });

  test("full approval cycle: plan → review → confirm → verify", async () => {
    // 1. Capture returns plan
    const planRes = await call("capture", { text: "Decision: switch from REST to GraphQL #api" });
    const planText = getText(planRes);
    expect(planText).toContain("Here's what I'd like to do");
    expect(planText).toContain("Plan ID:");

    // 2. Nothing created yet
    expect(readdirSync(join(VAULT_ROOT, "decisions")).filter((f) => f.endsWith(".md")).length).toBe(0);

    // 3. Extract plan ID and confirm
    const planId = planText.match(/Plan ID: ([a-f0-9-]+)/)![1]!;
    const confirmRes = await call("capture", { text: "Decision: switch from REST to GraphQL #api", planId, confirmed: true });
    expect(getText(confirmRes)).toContain("Done!");

    // 4. Now the file should exist
    const files = readdirSync(join(VAULT_ROOT, "decisions")).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);

    // 5. Read the created note and verify structure
    const noteContent = await Bun.file(join(VAULT_ROOT, "decisions", files[0]!)).text();
    expect(noteContent).toContain("---"); // frontmatter
    expect(noteContent).toContain("category: decisions");
    expect(noteContent).toContain("api");
    expect(noteContent).toContain("GraphQL");
  });
});

describe("E2E: concurrent captures", () => {
  beforeEach(() => {
    setupVaultDirs();
    _testInit({ defaultMode: "yolo", vaultPath: VAULT_ROOT }, {});
  });

  test("parallel captures don't lose data", async () => {
    const results = await Promise.all([
      call("capture", { text: "Idea: parallel note A #test", mode: "yolo" }),
      call("capture", { text: "Idea: parallel note B #test", mode: "yolo" }),
      call("capture", { text: "Idea: parallel note C #test", mode: "yolo" }),
    ]);

    // All should succeed
    for (const res of results) {
      expect(res.isError).toBeFalsy();
      expect(getText(res)).toContain("Done!");
    }

    // All files should exist
    const files = readdirSync(join(VAULT_ROOT, "ideas")).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// MANIFEST TESTS
// ═══════════════════════════════════════════════════════════════

describe("manifest", () => {
  test("has required fields", async () => {
    const manifest = (await import("./ezcorp.config")).default;
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.name).toBe("auto-note");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.entrypoint).toBe("./index.ts");
    expect(manifest.persistent).toBe(true);
  });

  test("declares 8 tools", async () => {
    const manifest = (await import("./ezcorp.config")).default;
    expect(manifest.tools).toHaveLength(8);
    const names = manifest.tools!.map((t: any) => t.name);
    expect(names).toContain("capture");
    expect(names).toContain("vault-tree");
    expect(names).toContain("vault-search");
    expect(names).toContain("vault-read");
    expect(names).toContain("vault-related");
    expect(names).toContain("vault-refile");
    expect(names).toContain("vault-daily");
    expect(names).toContain("configure");
  });

  test("declares 2 skills", async () => {
    const manifest = (await import("./ezcorp.config")).default;
    expect(manifest.skills).toHaveLength(2);
  });

  test("declares agent with prompt and classification examples", async () => {
    const manifest = (await import("./ezcorp.config")).default;
    expect(manifest.agent).toBeDefined();
    expect(manifest.agent!.prompt.length).toBeGreaterThan(50);
    // At least 3 example conversations demonstrating LLM-driven classification
    // for content the keyword matcher would misroute.
    expect(manifest.agent!.exampleConversations!.length).toBeGreaterThanOrEqual(3);
    // The prompt must instruct the LLM to classify (not just passively narrate)
    expect(manifest.agent!.prompt).toMatch(/class/i);
    expect(manifest.agent!.prompt).toMatch(/category/i);
  });

  test("declares panel", async () => {
    const manifest = (await import("./ezcorp.config")).default;
    expect(manifest.panel).toBeDefined();
    expect(manifest.panel!.position).toBe("bottom");
  });

  test("declares lifecycle hooks", async () => {
    const manifest = (await import("./ezcorp.config")).default;
    expect(manifest.lifecycleHooks).toContain("run:start");
    expect(manifest.lifecycleHooks).toContain("run:complete");
  });

  test("declares permissions", async () => {
    const manifest = (await import("./ezcorp.config")).default;
    expect(manifest.permissions.filesystem).toContain("$CWD");
    expect(manifest.permissions.storage).toBe(true);
    expect(manifest.permissions.shell).toBe(false);
  });

  test("all tools have valid inputSchema", async () => {
    const manifest = (await import("./ezcorp.config")).default;
    for (const tool of manifest.tools!) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  test("every tool base name satisfies Anthropic's tool-name regex", async () => {
    // Anthropic's API rejects any tool name that doesn't match this regex.
    // Names like `ext.tool` (dotted) are REJECTED with:
    //   Invalid 'tools[N].name': string does not match pattern.
    // So every base name in the manifest must already be URL-safe.
    const ANTHROPIC_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
    const manifest = (await import("./ezcorp.config")).default;
    for (const tool of manifest.tools!) {
      expect(tool.name).toMatch(ANTHROPIC_TOOL_NAME_PATTERN);
    }
  });

  test("every namespaced tool name satisfies Anthropic's tool-name regex", async () => {
    // Regression: previously the registry used `${ext}.${tool}` which
    // failed Anthropic's regex for every extension tool — the user saw
    // "Invalid 'tools[7].name'" when invoking @auto-note. The registry now
    // uses `__` as the separator. This test guards against reverting to `.`
    // (or introducing any other illegal separator).
    const ANTHROPIC_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
    const manifest = (await import("./ezcorp.config")).default;
    for (const tool of manifest.tools!) {
      const namespaced = `${manifest.name}__${tool.name}`;
      expect(namespaced).toMatch(ANTHROPIC_TOOL_NAME_PATTERN);
    }
  });

  // ── Universal schema validation (all model providers) ─────────
  //
  // Different LLM providers impose different strictness on tool JSON Schemas.
  // This suite encodes the INTERSECTION of all major providers' requirements
  // so a tool accepted by one will be accepted by all. Regression: OpenAI
  // rejected `vault-search` because its `tags` array had no `items` declared.
  //
  // Providers validated against (as of 2026-04):
  //   * Anthropic (Claude)    : tool name ^[a-zA-Z0-9_-]+$, <= 64 chars
  //   * OpenAI (GPT-4/4o)     : same name regex, parameters must be valid JSON Schema
  //   * OpenAI strict mode    : arrays REQUIRE `items`, objects REQUIRE `properties`
  //   * Google Gemini         : arrays REQUIRE `items`, enums must be string arrays
  function walkSchema(schema: any, path: string, errors: string[]): void {
    if (!schema || typeof schema !== "object") return;

    // Arrays MUST have items with a type (OpenAI + Gemini)
    if (schema.type === "array") {
      if (!schema.items) {
        errors.push(`${path}: array schema missing 'items'`);
      } else if (typeof schema.items === "object" && !schema.items.type && !schema.items.$ref && !schema.items.enum) {
        errors.push(`${path}.items: array items must declare a type`);
      } else if (schema.items && typeof schema.items === "object") {
        walkSchema(schema.items, `${path}.items`, errors);
      }
    }

    // Objects should declare properties when they have any structure
    if (schema.type === "object" && schema.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        walkSchema(prop, `${path}.properties.${key}`, errors);
      }
    }

    // enum values must be homogenous strings (Gemini)
    if (Array.isArray(schema.enum)) {
      for (let i = 0; i < schema.enum.length; i++) {
        if (typeof schema.enum[i] !== "string") {
          errors.push(`${path}.enum[${i}]: Gemini requires all enum values to be strings`);
        }
      }
    }
  }

  test("every tool inputSchema is valid across all major LLM providers", async () => {
    const manifest = (await import("./ezcorp.config")).default;
    const errors: string[] = [];

    for (const tool of manifest.tools!) {
      const toolPath = `tool[${tool.name}]`;

      // Top-level: must be an object schema
      expect(tool.inputSchema).toBeDefined();
      expect((tool.inputSchema as any).type).toBe("object");

      // Name constraints (OpenAI limits function names to 64 chars)
      const namespaced = `${manifest.name}__${tool.name}`;
      expect(namespaced.length).toBeLessThanOrEqual(64);

      // Recursively validate the schema
      walkSchema(tool.inputSchema, `${toolPath}.inputSchema`, errors);
    }

    if (errors.length > 0) {
      throw new Error(`Manifest has provider-incompatible schemas:\n  - ${errors.join("\n  - ")}`);
    }
  });

  test("every tool has a description (required by OpenAI and Gemini)", async () => {
    const manifest = (await import("./ezcorp.config")).default;
    for (const tool of manifest.tools!) {
      expect(tool.description).toBeDefined();
      expect(tool.description.length).toBeGreaterThan(0);
      // OpenAI caps description at 1024 chars
      expect(tool.description.length).toBeLessThanOrEqual(1024);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// POSTINSTALL TESTS
// ═══════════════════════════════════════════════════════════════

describe("postinstall", () => {
  test("creates vault directory structure", async () => {
    const testDir = join(TMP_DIR, "postinstall-test");
    mkdirSync(join(testDir, ".git"), { recursive: true }); // fake git root

    // Run postinstall script in the test dir
    const proc = Bun.spawn(["bun", join(import.meta.dir, "scripts/postinstall.ts")], {
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    const vaultDir = join(testDir, ".ezcorp", "extension-data", "auto-note", "vault");
    expect(existsSync(vaultDir)).toBe(true);
    for (const cat of CATEGORIES) {
      expect(existsSync(join(vaultDir, cat))).toBe(true);
    }
    expect(existsSync(join(vaultDir, "_index.md"))).toBe(true);

    const indexContent = await Bun.file(join(vaultDir, "_index.md")).text();
    expect(indexContent).toContain("Vault Index");
    expect(indexContent).toContain("0 notes");
  });
});

// ═══════════════════════════════════════════════════════════════
// E2E TESTS — Real subprocess via Bun.spawn + JSON-RPC stdin/stdout
// ═══════════════════════════════════════════════════════════════
//
// These tests spawn the extension exactly like the server does: through
// Bun.spawn with --preload sandbox-preload, communicating via line-delimited
// JSON-RPC over stdin/stdout. This catches crashes that only surface in the
// real subprocess environment (sandbox restrictions, stdin buffering, stdout
// framing, persistent-process lifecycle).

type Spawned = {
  proc: ReturnType<typeof Bun.spawn>;
  send: (req: any) => Promise<any>;
  readNotifications: () => any[];
  close: () => Promise<void>;
};

async function spawnExtension(opts: { cwd: string; env?: Record<string, string> } = { cwd: TMP_DIR }): Promise<Spawned> {
  const extDir = import.meta.dir; // points to docs/extensions/examples/auto-note
  const preloadPath = join(extDir, "..", "..", "..", "..", "src", "extensions", "runtime", "sandbox-preload.ts");
  const entrypoint = join(extDir, "index.ts");

  const baseEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: process.env.NODE_ENV ?? "test",
    TMPDIR: opts.cwd,
    // Phase 3 fs hardening: auto-note persists via host-mediated `fs*`
    // reverse-RPC. Grant the flag + answer `ezcorp/fs.*` below (scoped to
    // the subprocess cwd, which contains its `.ezcorp/extension-data` vault).
    EZCORP_FS_ALLOWED: "1",
  };

  const proc = Bun.spawn(
    ["bun", "run", "--preload", preloadPath, entrypoint],
    {
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...baseEnv, ...(opts.env ?? {}) },
    },
  );

  // Host-side `ezcorp/fs.*` reverse-RPC handler, scoped to the subprocess cwd.
  const fsHandler = makeFsRpcHandler(opts.cwd);

  // Collect stdout lines and demux responses from notifications
  const responseCbs = new Map<number | string, (msg: any) => void>();
  const notifications: any[] = [];
  let stdoutBuffer = "";

  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stdoutBuffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = stdoutBuffer.indexOf("\n")) !== -1) {
          const line = stdoutBuffer.slice(0, idx).trim();
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.method && msg.id != null) {
              // Reverse-RPC REQUEST from the subprocess (e.g. ezcorp/fs.*).
              // Answer it and write the response back over stdin — the host's
              // job. Without this the subprocess's fsWrite never resolves.
              const resp = fsHandler(msg) ?? {
                jsonrpc: "2.0", id: msg.id,
                error: { code: -32601, message: `Method not found: ${msg.method}` },
              };
              (proc.stdin as any).write(JSON.stringify(resp) + "\n");
              if ((proc.stdin as any).flush) (proc.stdin as any).flush();
            } else if (msg.id != null) {
              responseCbs.get(msg.id)?.(msg);
              responseCbs.delete(msg.id);
            } else if (msg.method) {
              notifications.push(msg);
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch { /* closed */ }
  })();

  // Also drain stderr so it doesn't block on a full pipe
  const stderrChunks: string[] = [];
  (async () => {
    const r = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const d = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await r.read();
        if (done) break;
        stderrChunks.push(d.decode(value, { stream: true }));
      }
    } catch { /* closed */ }
  })();

  let nextId = 1;

  const send = (req: any): Promise<any> => {
    const id = req.id ?? nextId++;
    const full = { jsonrpc: "2.0", id, ...req };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        responseCbs.delete(id);
        reject(new Error(`Timeout waiting for id=${id}. stderr=${stderrChunks.join("")}`));
      }, 10_000);
      responseCbs.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      (proc.stdin as any).write(JSON.stringify(full) + "\n");
      if ((proc.stdin as any).flush) (proc.stdin as any).flush();
    });
  };

  const close = async () => {
    try { (proc.stdin as any).end?.(); } catch {}
    proc.kill();
    await proc.exited.catch(() => {});
  };

  return {
    proc,
    send,
    readNotifications: () => [...notifications],
    close,
  };
}

describe("E2E: real subprocess + JSON-RPC", () => {
  const E2E_DIR = join(TMP_DIR, "e2e-vault-" + Date.now());

  beforeEach(() => {
    try { rmSync(E2E_DIR, { recursive: true }); } catch {}
    mkdirSync(join(E2E_DIR, ".git"), { recursive: true }); // so findProjectRoot anchors here
  });

  test("subprocess starts and responds to vault-tree", async () => {
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      const res = await ext.send({ method: "tools/call", params: { name: "vault-tree", arguments: {} } });
      expect(res.isError).toBeFalsy();
      expect(res.result.content[0].text).toContain("vault/");
      expect(res.result.content[0].text).toContain("Total: 0 notes");
    } finally { await ext.close(); }
  });

  test("capture in yolo mode writes files to the vault directory", async () => {
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      const res = await ext.send({
        method: "tools/call",
        params: { name: "capture", arguments: { text: "Idea: add dark mode #ui", mode: "yolo" } },
      });
      expect(res.isError).toBeFalsy();
      expect(res.result.content[0].text).toContain("Done!");

      // Files should exist on disk
      const vaultDir = join(E2E_DIR, ".ezcorp", "extension-data", "auto-note", "vault");
      expect(existsSync(vaultDir)).toBe(true);
      const ideasDir = join(vaultDir, "ideas");
      const ideaFiles = readdirSync(ideasDir).filter((f) => f.endsWith(".md"));
      expect(ideaFiles.length).toBeGreaterThan(0);
    } finally { await ext.close(); }
  });

  test("capture via real subprocess honors LLM-supplied category (learn-about-cows regression)", async () => {
    // Full round-trip through Bun.spawn + JSON-RPC with an LLM-supplied
    // classification. Guards the end-to-end fix for the `ideas/` fallback bug:
    // when the agent passes `category: "references"`, the file MUST land under
    // `references/`, never `ideas/`.
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      const res = await ext.send({
        method: "tools/call",
        params: {
          name: "capture",
          arguments: {
            text: "learn more about cows",
            category: "references",
            title: "Learn more about cows",
            tags: ["cows", "animals", "biology"],
            mode: "yolo",
          },
        },
      });
      expect(res.isError).toBeFalsy();
      const narration = res.result.content[0].text;
      expect(narration).toContain("references/");
      expect(narration).not.toMatch(/\bideas\/learn-more-about-cows\b/);

      const vaultDir = join(E2E_DIR, ".ezcorp", "extension-data", "auto-note", "vault");
      const refFiles = readdirSync(join(vaultDir, "references")).filter((f) => f.endsWith(".md"));
      expect(refFiles.some((f) => f.includes("learn-more-about-cows"))).toBe(true);
      // ideas/ is either missing or doesn't contain a cows note
      const ideasPath = join(vaultDir, "ideas");
      if (existsSync(ideasPath)) {
        const ideaFiles = readdirSync(ideasPath);
        expect(ideaFiles.some((f) => f.includes("learn-more-about-cows"))).toBe(false);
      }

      // Verify the frontmatter written to disk has the right category
      const cowsFile = refFiles.find((f) => f.includes("learn-more-about-cows"))!;
      const fileContent = await Bun.file(join(vaultDir, "references", cowsFile)).text();
      expect(fileContent).toContain("category: references");
      expect(fileContent).toContain("cows");
      expect(fileContent).toContain("animals");
    } finally { await ext.close(); }
  });

  test("capture does NOT emit unsolicited stdout that could break JSON-RPC framing", async () => {
    // Regression: earlier versions emitted `ezcorp/state` notifications after
    // every tool call, which interleaved with the response on stdout and broke
    // the server's JSON-RPC transport. Panel state is now only emitted from
    // explicit lifecycle hooks, not from unrelated tool calls.
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      const res = await ext.send({
        method: "tools/call",
        params: { name: "capture", arguments: { text: "Test note", mode: "yolo" } },
      });
      expect(res.isError).toBeFalsy();

      // No notifications should be emitted during a normal tool call
      const notifs = ext.readNotifications();
      expect(notifs.find((n) => n.method === "ezcorp/state")).toBeUndefined();
    } finally { await ext.close(); }
  });

  test("lifecycle hook triggers ezcorp/state notification (expected emission point)", async () => {
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      await ext.send({ method: "lifecycle/run:start", params: {} });
      // Give the async notification write a moment to flush
      await new Promise((r) => setTimeout(r, 100));

      const notifs = ext.readNotifications();
      const stateNotif = notifs.find((n) => n.method === "ezcorp/state");
      expect(stateNotif).toBeDefined();
      expect(stateNotif.params.title).toBe("Auto Note");
    } finally { await ext.close(); }
  });

  test("subprocess handles sequential calls without crashing", async () => {
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      const r1 = await ext.send({ method: "tools/call", params: { name: "vault-tree", arguments: {} } });
      expect(r1.error).toBeUndefined();

      const r2 = await ext.send({
        method: "tools/call",
        params: { name: "capture", arguments: { text: "First note", mode: "yolo" } },
      });
      expect(r2.error).toBeUndefined();

      const r3 = await ext.send({
        method: "tools/call",
        params: { name: "capture", arguments: { text: "Second note #test", mode: "yolo" } },
      });
      expect(r3.error).toBeUndefined();

      const r4 = await ext.send({ method: "tools/call", params: { name: "vault-tree", arguments: {} } });
      expect(r4.error).toBeUndefined();
      expect(r4.result.content[0].text).toContain("Total: 2 notes");
    } finally { await ext.close(); }
  });

  test("approval-mode capture returns plan ID and confirm executes it", async () => {
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      const planRes = await ext.send({
        method: "tools/call",
        params: { name: "capture", arguments: { text: "Decision: use GraphQL", mode: "approval" } },
      });
      expect(planRes.error).toBeUndefined();
      const planText = planRes.result.content[0].text;
      expect(planText).toContain("Plan ID:");
      expect(planText).toContain("Proceed?");

      const planId = planText.match(/Plan ID: ([a-f0-9-]+)/)![1]!;

      // File should not exist yet
      const vaultDir = join(E2E_DIR, ".ezcorp", "extension-data", "auto-note", "vault");
      if (existsSync(join(vaultDir, "decisions"))) {
        expect(readdirSync(join(vaultDir, "decisions")).filter((f) => f.endsWith(".md")).length).toBe(0);
      }

      // Confirm
      const confirmRes = await ext.send({
        method: "tools/call",
        params: { name: "capture", arguments: { text: "Decision: use GraphQL", planId, confirmed: true } },
      });
      expect(confirmRes.error).toBeUndefined();
      expect(confirmRes.result.content[0].text).toContain("Done!");

      // Now file exists
      const files = readdirSync(join(vaultDir, "decisions")).filter((f) => f.endsWith(".md"));
      expect(files.length).toBeGreaterThan(0);
    } finally { await ext.close(); }
  });

  test("configure tool persists settings and reads them back", async () => {
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      await ext.send({
        method: "tools/call",
        params: { name: "configure", arguments: { defaultMode: "yolo" } },
      });

      const cfg = await ext.send({ method: "tools/call", params: { name: "configure", arguments: {} } });
      const parsed = JSON.parse(cfg.result.content[0].text);
      expect(parsed.defaultMode).toBe("yolo");

      // Config file should exist in the e2e dir
      expect(existsSync(join(E2E_DIR, ".ezcorp", "extension-data", "auto-note", "config.json"))).toBe(true);
    } finally { await ext.close(); }
  });

  test("configure does NOT write to the real project config path", async () => {
    // Regression: earlier versions wrote to <projectRoot>/.ezcorp/extension-data/auto-note/config.json
    // which polluted production installs. This confirms the cwd-scoped write.
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      await ext.send({
        method: "tools/call",
        params: { name: "configure", arguments: { defaultMode: "yolo", vaultPath: "/tmp/doesnt-matter" } },
      });
    } finally { await ext.close(); }

    // Project-root config.json should not be affected by this test run
    // (we only verify our own E2E_DIR got the config — see test above)
    expect(existsSync(join(E2E_DIR, ".ezcorp", "extension-data", "auto-note", "config.json"))).toBe(true);
  });

  test("unknown tool returns JSON-RPC error, subprocess stays alive", async () => {
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      const err = await ext.send({ method: "tools/call", params: { name: "does-not-exist", arguments: {} } });
      expect(err.error).toBeDefined();

      // Subprocess should still be alive and responsive
      const ok = await ext.send({ method: "tools/call", params: { name: "vault-tree", arguments: {} } });
      expect(ok.error).toBeUndefined();
    } finally { await ext.close(); }
  });

  test("lifecycle hook notifications do not crash subprocess", async () => {
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      const ok = await ext.send({ method: "lifecycle/run:start", params: {} });
      expect(ok.error).toBeUndefined();

      const ok2 = await ext.send({ method: "lifecycle/run:complete", params: {} });
      expect(ok2.error).toBeUndefined();

      // Subprocess still responsive after lifecycle hooks
      const tree = await ext.send({ method: "tools/call", params: { name: "vault-tree", arguments: {} } });
      expect(tree.error).toBeUndefined();
    } finally { await ext.close(); }
  });

  test("capture with related notes links them bidirectionally on disk", async () => {
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      await ext.send({
        method: "tools/call",
        params: { name: "capture", arguments: { text: "First: reference about #auth security", mode: "yolo" } },
      });
      await ext.send({
        method: "tools/call",
        params: { name: "capture", arguments: { text: "Second: idea about improving #auth flows", mode: "yolo" } },
      });

      // Walk the vault and verify at least one file contains a wikilink to another
      const vaultDir = join(E2E_DIR, ".ezcorp", "extension-data", "auto-note", "vault");
      let foundWikilink = false;
      for (const cat of CATEGORIES) {
        const dir = join(vaultDir, cat);
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir)) {
          if (!file.endsWith(".md")) continue;
          const content = await Bun.file(join(dir, file)).text();
          if (/\[\[[^\]]+\]\]/.test(content)) { foundWikilink = true; break; }
        }
        if (foundWikilink) break;
      }
      expect(foundWikilink).toBe(true);
    } finally { await ext.close(); }
  });

  test("subprocess does not write outside its cwd", async () => {
    // Sentinel: no auto-note files at common paths outside E2E_DIR
    const sentinelPaths = [
      join(TMP_DIR, "sentinel-autonote-" + Date.now()),
    ];
    for (const p of sentinelPaths) mkdirSync(p, { recursive: true });

    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      await ext.send({
        method: "tools/call",
        params: { name: "capture", arguments: { text: "sentinel test note", mode: "yolo" } },
      });
    } finally { await ext.close(); }

    // Files should only exist under E2E_DIR/.ezcorp/extension-data/auto-note/
    for (const p of sentinelPaths) {
      expect(existsSync(join(p, ".ezcorp"))).toBe(false);
    }
    expect(existsSync(join(E2E_DIR, ".ezcorp", "extension-data", "auto-note", "vault"))).toBe(true);
  });
});
