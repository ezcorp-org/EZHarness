/**
 * Integration tests for the `$[feature:…]` expansion path inside
 * `buildPromptInput` (`src/runtime/stream-chat/build-prompt.ts`).
 *
 * These exercise the wiring between:
 *   - `applyFeatureExpansion` in `src/runtime/mention-wiring.ts`
 *   - `getFeature(projectId, name)` in `src/db/queries/features.ts`
 *   - `getProject(projectId)` (gates the project-scoped block)
 *
 * Mocking strategy mirrors `build-prompt-integration.test.ts`: stub the
 * two query modules at module level, then import `buildPromptInput` so
 * its dynamic `await import()`s resolve to our stubs.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Mock state ───────────────────────────────────────────────────────
let projectRoot: string;
let mockProject: { id: string; path: string } | undefined;

let mockFeatures: Record<string, {
  id: string;
  projectId: string;
  name: string;
  description: string;
  files: { relpath: string }[];
}> = {};
let getFeatureShouldThrow = false;
const featureCalls: Array<{ projectId: string; name: string }> = [];

mock.module("../db/queries/projects", () => ({
  getProject: async (id: string) => (mockProject?.id === id ? mockProject : undefined),
}));

mock.module("../db/queries/features", () => ({
  getFeature: async (projectId: string, name: string) => {
    featureCalls.push({ projectId, name });
    if (getFeatureShouldThrow) throw new Error("boom-feature");
    return mockFeatures[name];
  },
}));

// Conversation-extensions module is touched by the attachment lift
// branch — leave it stubbed empty so the feature-only tests don't trip
// on it. Mirrors build-prompt-integration.test.ts's setup.
mock.module("../db/queries/conversation-extensions", () => ({
  getConversationExtensionMimes: async (_id: string) => [],
}));

// IMPORTANT: import after the mocks register so the dynamic imports
// inside buildPromptInput resolve to our stubs.
import { buildPromptInput } from "../runtime/stream-chat/build-prompt";

beforeAll(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "build-prompt-feat-"));
  await writeFile(join(projectRoot, "foo.ts"), "// foo");
  mockProject = { id: "proj-1", path: projectRoot };
});

afterAll(async () => {
  await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  mockFeatures = {};
  getFeatureShouldThrow = false;
  featureCalls.length = 0;
});

// ── Happy path ───────────────────────────────────────────────────────

describe("buildPromptInput — feature expansion happy path", () => {
  test("known feature → system note prepended in 'note\\n\\nuser' shape", async () => {
    mockFeatures.chat = {
      id: "f-1",
      projectId: "proj-1",
      name: "chat",
      description: "Files under src/chat",
      files: [{ relpath: "src/chat/a.ts" }, { relpath: "src/chat/b.ts" }],
    };
    const result = await buildPromptInput("look at $[feature:chat]", {
      projectId: "proj-1",
    });

    expect(result.text).toContain("**Feature: chat**");
    expect(result.text).toContain("- src/chat/a.ts");
    expect(result.text).toContain("- src/chat/b.ts");
    // Feature-note prepends the original user message (which still
    // includes the raw token verbatim).
    expect(result.text).toContain("look at $[feature:chat]");
    expect(result.text.indexOf("**Feature: chat**")).toBeLessThan(
      result.text.indexOf("look at $[feature:chat]"),
    );
    // Note + user are separated by exactly "\n\n".
    expect(result.text).toMatch(/\*\*Feature: chat\*\*[\s\S]+?\n\nlook at \$\[feature:chat\]/);
    expect(featureCalls).toEqual([{ projectId: "proj-1", name: "chat" }]);
  });

  test("multiple features prepend in source order", async () => {
    mockFeatures.b = {
      id: "fb",
      projectId: "proj-1",
      name: "b",
      description: "Beta",
      files: [{ relpath: "src/b/1.ts" }, { relpath: "src/b/2.ts" }],
    };
    mockFeatures.a = {
      id: "fa",
      projectId: "proj-1",
      name: "a",
      description: "Alpha",
      files: [{ relpath: "src/a/1.ts" }, { relpath: "src/a/2.ts" }],
    };
    const result = await buildPromptInput(
      "first $[feature:b] then $[feature:a]",
      { projectId: "proj-1" },
    );
    const idxB = result.text.indexOf("**Feature: b**");
    const idxA = result.text.indexOf("**Feature: a**");
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeGreaterThan(idxB);
  });
});

// ── Unknown / no-op cases ────────────────────────────────────────────

describe("buildPromptInput — feature expansion no-op cases", () => {
  test("unknown feature → text unchanged from raw user message", async () => {
    const result = await buildPromptInput("see $[feature:ghost]", {
      projectId: "proj-1",
    });
    expect(result.text).toBe("see $[feature:ghost]");
    expect(result.text).not.toContain("**Feature:");
  });

  test("missing projectId → expansion entirely skipped (resolver never called)", async () => {
    mockFeatures.chat = {
      id: "f-1",
      projectId: "proj-1",
      name: "chat",
      description: "x",
      files: [{ relpath: "a.ts" }],
    };
    const result = await buildPromptInput("see $[feature:chat]", {});
    expect(result.text).toBe("see $[feature:chat]");
    expect(featureCalls).toEqual([]);
  });

  test("no $[feature:…] tokens → text unchanged", async () => {
    const result = await buildPromptInput("plain user message", {
      projectId: "proj-1",
    });
    expect(result.text).toBe("plain user message");
    expect(featureCalls).toEqual([]);
  });

  test("resolver throws → caught (non-fatal); user text passes through", async () => {
    getFeatureShouldThrow = true;
    const result = await buildPromptInput("see $[feature:chat]", {
      projectId: "proj-1",
    });
    // try/catch in build-prompt.ts swallows the error; original user text
    // still surfaces (no system note prepended).
    expect(result.text).toBe("see $[feature:chat]");
    expect(result.text).not.toContain("**Feature:");
  });
});

// ── Cross-feature integration: file + feature mention coexist ────────

describe("buildPromptInput — feature + file expansion together", () => {
  test("both @[file:…] and $[feature:…] notes prepend; file note first, feature note second", async () => {
    mockFeatures.bar = {
      id: "fbar",
      projectId: "proj-1",
      name: "bar",
      description: "Bar",
      files: [{ relpath: "src/bar/1.ts" }, { relpath: "src/bar/2.ts" }],
    };
    const result = await buildPromptInput(
      "look at @[file:foo.ts] and $[feature:bar]",
      { projectId: "proj-1" },
    );
    // build-prompt.ts runs file-mention expansion BEFORE feature
    // expansion (lines 58-66 then 75-90). After both prepends:
    //   <feature-note>\n\n<file-note>\n\n<original>
    // i.e. feature is prepended LAST so it ends up at the TOP.
    const featureIdx = result.text.indexOf("**Feature: bar**");
    const fileIdx = result.text.indexOf("[User referenced file: foo.ts");
    const userIdx = result.text.indexOf("look at @[file:foo.ts]");
    expect(featureIdx).toBeGreaterThanOrEqual(0);
    expect(fileIdx).toBeGreaterThan(featureIdx);
    expect(userIdx).toBeGreaterThan(fileIdx);
  });
});

// ── Injection guard end-to-end ───────────────────────────────────────

describe("buildPromptInput — no double-expansion across the integration boundary", () => {
  test("feature description containing other sigils flows through verbatim — no ext-wiring, no file-system note triggered for the embedded mention", async () => {
    // Mounted feature description and file paths contain other mention
    // sigils. After expansion, the LLM-facing text MUST contain those
    // strings verbatim AND must NOT have produced an extra file-system
    // note for `@[file:…]` strings that originated INSIDE the feature
    // block. The user message itself contains no @[file:…] token, so
    // the only `[User referenced file: …]` text would be one that the
    // file-resolver mistakenly picked up from the expanded feature block.
    mockFeatures.evil = {
      id: "f-evil",
      projectId: "proj-1",
      name: "evil",
      description: "see ![ext:evil] and @[file:secret.ts] and $[feature:meta]",
      files: [
        { relpath: "src/normal.ts" },
        { relpath: "src/$[feature:nested]/x.ts" },
      ],
    };
    const result = await buildPromptInput("trigger $[feature:evil]", {
      projectId: "proj-1",
    });

    // Feature block is present and contains the dangerous strings as
    // literal text.
    expect(result.text).toContain("**Feature: evil**");
    expect(result.text).toContain("![ext:evil]");
    expect(result.text).toContain("@[file:secret.ts]");
    expect(result.text).toContain("$[feature:meta]");
    expect(result.text).toContain("- src/$[feature:nested]/x.ts");

    // CRITICAL: there must be NO `[User referenced file: secret.ts]` —
    // file-mention resolution runs on the ORIGINAL userMessage, not the
    // expanded text. The "@[file:secret.ts]" appearing inside the
    // feature description must NOT trip the file-resolver.
    expect(result.text).not.toContain("[User referenced file: secret.ts");

    // Resolver was called exactly once for "evil" — no recursive spawn
    // for "meta" or "nested".
    expect(featureCalls).toEqual([{ projectId: "proj-1", name: "evil" }]);
  });
});
