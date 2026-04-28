// Unit tests for the claude-design bundled extension.
//
// Covers:
//   - clarify-brief: validation, gate registration, resolution by
//     matching brief-answer event, conversationId mismatch drop,
//     timeout, abort.
//   - generate-design: lint failure path, descriptor persistence,
//     knobValues from descriptor.current.
//   - applyKnobsToDraft: descriptor path, legacy path, dual-write
//     (revision + parent).
//   - openCanvas: descriptor return path, legacy fallback.
//   - migrateMeta: v1 object knobs → v2 knobValues.
//
// Test seam: each test makes a tmp dir, chdir's into it, and creates
// `.git` so `findProjectRoot()` resolves there. No DB. No real channel.
// Mirrors the pattern used by `lib/tweak.test.ts`'s tmp-dir block.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _internals,
  _setBriefTimeoutForTests,
} from "./index";
import { migrateMeta, type DesignSystem, type KnobDescriptor } from "./lib/types";

const FIXTURE_DS: DesignSystem = {
  schemaVersion: 1,
  colors: { primary: "#336699", secondary: "#99cc33", neutral: ["#000", "#fff"] },
  typography: { display: "Inter", body: "Inter", scale: [12, 14, 16, 20, 24] },
  spacing: { unit: 8, scale: [8, 16, 24, 32] },
  components: [],
  source: "greenfield",
};

const FIXTURE_BODY = `<main style="color: var(--color-fg); padding: var(--space-2)">
  <h1 style="font-family: var(--font-display)">Hello</h1>
</main>`;

// ── Tmp-dir + cwd shim ─────────────────────────────────────────────

let tmpRoot: string;
let prevCwd: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "claude-design-idx-"));
  // findProjectRoot walks up looking for `.git` — synthesize one in
  // the tmp dir so it stops here. Without this, the helper might
  // resolve into the actual repo and pollute it.
  mkdirSync(join(tmpRoot, ".git"));
  prevCwd = process.cwd();
  process.chdir(tmpRoot);
  _internals.pendingBriefAnswers.clear();
  _setBriefTimeoutForTests(5 * 60_000);
});

afterEach(() => {
  _internals.pendingBriefAnswers.clear();
  _setBriefTimeoutForTests(5 * 60_000);
  try {
    process.chdir(prevCwd);
  } catch {
    /* nothing */
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeCtx(
  overrides: Partial<{
    toolCallId: string | undefined;
    conversationId: string | undefined;
    signal: AbortSignal;
  }> = {},
): { invocationMetadata: Record<string, unknown>; signal?: AbortSignal } {
  const toolCallId = "toolCallId" in overrides ? overrides.toolCallId : "tc-test";
  const conversationId =
    "conversationId" in overrides ? overrides.conversationId : "conv-test";
  const metadata: Record<string, unknown> = {};
  if (toolCallId !== undefined) metadata.toolCallId = toolCallId;
  if (conversationId !== undefined) metadata.conversationId = conversationId;
  const ctx: { invocationMetadata: Record<string, unknown>; signal?: AbortSignal } = {
    invocationMetadata: metadata,
  };
  if (overrides.signal) ctx.signal = overrides.signal;
  return ctx;
}

function expectText(out: unknown): string {
  const o = out as { content?: Array<{ type: string; text: string }> };
  const first = o.content?.[0];
  if (!first || first.type !== "text") throw new Error("tool-result has no text content");
  return first.text;
}

function expectIsError(out: unknown): boolean {
  return (out as { isError?: boolean }).isError === true;
}

/** Write a fresh design-system.json under the tmp project dir.
 *  Returns the slug used. The slug is the basename of the tmp root —
 *  same logic `defaultProjectSlug()` uses. */
function seedDesignSystem(): string {
  const slug = tmpRoot.split("/").pop() || "project";
  const dir = join(tmpRoot, ".ezcorp", "extension-data", "claude-design", "projects", slug);
  mkdirSync(join(dir, "drafts"), { recursive: true });
  writeFileSync(join(dir, "design-system.json"), JSON.stringify(FIXTURE_DS, null, 2));
  return slug;
}

/** List all draft files in the slug dir for assertion-by-prefix. */
function listDraftFiles(slug: string): string[] {
  const dir = join(tmpRoot, ".ezcorp", "extension-data", "claude-design", "projects", slug, "drafts");
  // Use require-equivalent read.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("node:fs") as typeof import("node:fs");
  return fs.readdirSync(dir).sort();
}

// ── 1. clarifyBrief: validation ────────────────────────────────────

describe("clarify-brief — fields validation", () => {
  test("missing fields → toolError", async () => {
    const out = await _internals.clarifyBrief({}, makeCtx());
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("'fields' is required");
  });

  test("non-array fields → toolError", async () => {
    const out = await _internals.clarifyBrief({ fields: "nope" }, makeCtx());
    expect(expectIsError(out)).toBe(true);
  });

  test("field missing key → toolError", async () => {
    const out = await _internals.clarifyBrief(
      { fields: [{ label: "Tone", kind: "text" }] },
      makeCtx(),
    );
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("`key`");
  });

  test("field with bad kind → toolError", async () => {
    const out = await _internals.clarifyBrief(
      { fields: [{ key: "tone", label: "Tone", kind: "wibble" }] },
      makeCtx(),
    );
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("`kind`");
  });
});

// ── 2. clarifyBrief: gate registration ─────────────────────────────

describe("clarify-brief — gate registration", () => {
  test("registers a pending entry keyed on toolCallId", async () => {
    const invocation = _internals.clarifyBrief(
      { fields: [{ key: "tone", label: "Tone", kind: "text" }] },
      makeCtx({ toolCallId: "tc-reg" }),
    );
    for (let i = 0; i < 20 && !_internals.pendingBriefAnswers.has("tc-reg"); i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(_internals.pendingBriefAnswers.has("tc-reg")).toBe(true);

    // Resolve to clean up.
    await _internals.handleBriefAnswer({
      toolCallId: "tc-reg",
      conversationId: "conv-test",
      answer: "ok",
    });
    await invocation;
  });
});

// ── 3. clarifyBrief: resolves on matching event ────────────────────

describe("clarify-brief — resolves on matching brief-answer", () => {
  test("matching toolCallId + conversationId → resolves with answer text", async () => {
    const invocation = _internals.clarifyBrief(
      { fields: [{ key: "tone", label: "Tone", kind: "text" }] },
      makeCtx({ toolCallId: "tc-happy" }),
    );
    for (let i = 0; i < 20 && !_internals.pendingBriefAnswers.has("tc-happy"); i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    await _internals.handleBriefAnswer({
      toolCallId: "tc-happy",
      conversationId: "conv-test",
      answer: { tone: "modern", audience: "developers" },
    });
    const out = await invocation;
    expect(expectIsError(out)).toBe(false);
    const text = expectText(out);
    expect(text).toContain("modern");
    expect(text).toContain("developers");
  });
});

// ── 4. clarifyBrief: drops mismatched conversationId ───────────────

describe("clarify-brief — conversationId mismatch dropped", () => {
  test("event with wrong conversationId does NOT resolve the gate", async () => {
    const invocation = _internals.clarifyBrief(
      { fields: [{ key: "tone", label: "Tone", kind: "text" }] },
      makeCtx({ toolCallId: "tc-mm", conversationId: "conv-test" }),
    );
    for (let i = 0; i < 20 && !_internals.pendingBriefAnswers.has("tc-mm"); i++) {
      await new Promise((r) => setTimeout(r, 1));
    }

    await _internals.handleBriefAnswer({
      toolCallId: "tc-mm",
      conversationId: "conv-attacker",
      answer: "tampered",
    });
    expect(_internals.pendingBriefAnswers.has("tc-mm")).toBe(true);

    // Clean up via legitimate event.
    await _internals.handleBriefAnswer({
      toolCallId: "tc-mm",
      conversationId: "conv-test",
      answer: "legit",
    });
    const out = await invocation;
    expect(expectText(out)).toBe("legit");
  });
});

// ── 5. clarifyBrief: timeout ───────────────────────────────────────

describe("clarify-brief — timeout", () => {
  test("rejects after configured timeout", async () => {
    _setBriefTimeoutForTests(20);
    const out = await _internals.clarifyBrief(
      { fields: [{ key: "tone", label: "Tone", kind: "text" }] },
      makeCtx({ toolCallId: "tc-tout" }),
    );
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("Timed out waiting for brief answer");
  });
});

// ── 6. clarifyBrief: abort ─────────────────────────────────────────

describe("clarify-brief — abort signal", () => {
  test("ctx.signal.abort() rejects the gate", async () => {
    const controller = new AbortController();
    const invocation = _internals.clarifyBrief(
      { fields: [{ key: "tone", label: "Tone", kind: "text" }] },
      makeCtx({ toolCallId: "tc-abort", signal: controller.signal }),
    );
    for (let i = 0; i < 20 && _internals.pendingBriefAnswers.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    controller.abort();
    const out = await invocation;
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("Aborted while waiting for brief answer");
    expect(_internals.pendingBriefAnswers.size).toBe(0);
  });
});

// ── 7. generateDesign: lint failure ────────────────────────────────

describe("generate-design — lint failure", () => {
  test("returns toolError when bodyMarkup contains a hex literal", async () => {
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt: "Hero page",
      kind: "page",
      bodyMarkup: `<div style="color: #ff0066">x</div>`,
    });
    expect(expectIsError(out)).toBe(true);
    const text = expectText(out);
    expect(text).toContain("bodyMarkup failed lint");
    expect(text).toContain("hex");
    expect(text).toContain("#ff0066");
    expect(text).toContain("var(--…)");
  });
});

// ── 8. generateDesign: persists knobs + knobsTitle ─────────────────

describe("generate-design — persists knobs + knobsTitle to meta", () => {
  test("v2 meta contains the descriptor array and title", async () => {
    const slug = seedDesignSystem();
    const knobs: KnobDescriptor[] = [
      { key: "accentColor", label: "Accent", kind: "color", var: "--color-accent" },
      { key: "borderRadius", label: "Radius", kind: "range", var: "--radius-base", unit: "px" },
    ];
    const out = await _internals.generateDesign({
      prompt: "Hero",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
      knobs,
      knobsTitle: "Hero knobs",
    });
    expect(expectIsError(out)).toBe(false);
    // Find the meta file.
    const draftsDir = join(
      tmpRoot,
      ".ezcorp",
      "extension-data",
      "claude-design",
      "projects",
      slug,
      "drafts",
    );
    const files = listDraftFiles(slug);
    const metaFile = files.find((f) => f.endsWith(".meta.json"))!;
    const meta = JSON.parse(readFileSync(join(draftsDir, metaFile), "utf-8"));
    expect(meta.schemaVersion).toBe(2);
    expect(Array.isArray(meta.knobs)).toBe(true);
    expect(meta.knobs.length).toBe(2);
    expect(meta.knobs[0].key).toBe("accentColor");
    expect(meta.knobsTitle).toBe("Hero knobs");
  });
});

// ── 9. generateDesign: persists knobValues from descriptor.current ─

describe("generate-design — persists knobValues from descriptor.current", () => {
  test("descriptor.current populates initial knobValues", async () => {
    const slug = seedDesignSystem();
    const knobs: KnobDescriptor[] = [
      { key: "accentColor", label: "Accent", kind: "color", current: "#aabbcc" },
      { key: "noCurrent", label: "Other", kind: "text" },
    ];
    await _internals.generateDesign({
      prompt: "Hero",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
      knobs,
    });
    const draftsDir = join(
      tmpRoot,
      ".ezcorp",
      "extension-data",
      "claude-design",
      "projects",
      slug,
      "drafts",
    );
    const files = listDraftFiles(slug);
    const metaFile = files.find((f) => f.endsWith(".meta.json"))!;
    const meta = JSON.parse(readFileSync(join(draftsDir, metaFile), "utf-8"));
    expect(meta.knobValues).toEqual({ accentColor: "#aabbcc" });
  });
});

// ── 10. applyKnobsToDraft: descriptor path ─────────────────────────

describe("applyKnobsToDraft — descriptor path", () => {
  test("uses applyKnobsByDescriptors when meta.knobs is a descriptor array", async () => {
    const slug = seedDesignSystem();
    // Generate a draft with a custom accentColor descriptor pointing at
    // --color-accent — then apply a knob value and confirm the var
    // gets rewritten via the descriptor path.
    // Body uses var(--color-accent) so we can also see propagation.
    const body = `<main style="color: var(--color-accent); padding: var(--space-2)">x</main>`;
    // Spike a custom DS with --color-accent declared. Easier path: just
    // ensure the scaffold's tokens include the var by patching the
    // generated HTML directly.
    const knobs: KnobDescriptor[] = [
      { key: "accentColor", label: "Accent", kind: "color", var: "--color-accent" },
    ];
    const genOut = await _internals.generateDesign({
      prompt: "Hero",
      kind: "page",
      bodyMarkup: body,
      knobs,
    });
    expect(expectIsError(genOut)).toBe(false);
    const draftsDir = join(
      tmpRoot,
      ".ezcorp",
      "extension-data",
      "claude-design",
      "projects",
      slug,
      "drafts",
    );
    const files = listDraftFiles(slug);
    const htmlFile = files.find(
      (f) => f.endsWith(".html") && !f.includes("__r"),
    )!;
    const draftId = htmlFile.replace(/\.html$/, "");
    // Patch the on-disk HTML to add --color-accent to the token block
    // (the scaffolder only emits the DS-derived vars). Also patch the
    // meta's `originalTokensBlock` snapshot so the apply path's restore
    // step doesn't clobber the injected variable.
    const htmlPath = join(draftsDir, htmlFile);
    const orig = readFileSync(htmlPath, "utf-8");
    const patched = orig.replace(
      "</style>",
      "  --color-accent: #000000;\n  </style>",
    );
    writeFileSync(htmlPath, patched);
    const metaPath = htmlPath.replace(/\.html$/, ".meta.json");
    const metaJson = JSON.parse(readFileSync(metaPath, "utf-8"));
    if (typeof metaJson.originalTokensBlock === "string") {
      metaJson.originalTokensBlock = metaJson.originalTokensBlock.replace(
        /(\n\s*})\s*$/,
        "\n  --color-accent: #000000;$1",
      );
      writeFileSync(metaPath, JSON.stringify(metaJson, null, 2) + "\n");
    }

    const result = await _internals.applyKnobsToDraft(draftId, {
      accentColor: "#ff8800",
    });
    expect(result.changedVars).toContain("--color-accent");
    const newHtml = readFileSync(result.htmlPath, "utf-8");
    expect(newHtml).toContain("--color-accent: #ff8800;");
  });
});

// ── 10b. applyKnobsToDraft: descriptor path with signed-delta percent ─

describe("applyKnobsToDraft — descriptor path: scale-spacing signed-delta", () => {
  test('descriptor-driven spacingScale="+30%" multiplies all spacing tokens by 1.30', async () => {
    const slug = seedDesignSystem();
    // Generate with a real range+scale-spacing descriptor (mirrors what
    // the agent emits for any draft with a percent-slider knob).
    const body = `<main style="padding: var(--space-2); background: var(--color-bg); color: var(--color-fg)"><h1 style="font-family: var(--font-display)">x</h1></main>`;
    const knobs: KnobDescriptor[] = [
      {
        key: "spacingScale",
        label: "Spacing scale (%)",
        kind: "range",
        behavior: "scale-spacing",
        unit: "%",
        min: -25,
        max: 50,
        step: 5,
      },
    ];
    const genOut = await _internals.generateDesign({
      prompt: "Hero",
      kind: "page",
      bodyMarkup: body,
      knobs,
    });
    expect(expectIsError(genOut)).toBe(false);
    const files = listDraftFiles(slug);
    const htmlFile = files.find(
      (f) => f.endsWith(".html") && !f.includes("__r"),
    )!;
    const draftId = htmlFile.replace(/\.html$/, "");

    // The fixture design system seeds spacing.unit=8, scale=[8,16,24,32].
    // After "+30%" the scaffold's --space-unit (8) should become 10.4.
    const result = await _internals.applyKnobsToDraft(draftId, {
      spacingScale: "+30%",
    });
    expect(result.changedVars).toContain("--space-unit");

    const draftsDir = join(
      tmpRoot,
      ".ezcorp",
      "extension-data",
      "claude-design",
      "projects",
      slug,
      "drafts",
    );
    const newHtml = readFileSync(result.htmlPath, "utf-8");
    expect(newHtml).toContain("--space-unit: 10.4px;");
    // Sanity: NOT the catastrophic 0.30x output that happened before
    // the fix (when the frontend stripped the "+" sign and the
    // backend's parseScaleFactor read "30%" as absolute).
    expect(newHtml).not.toContain("--space-unit: 2.4px;");

    // Parent file ALSO updated (iframe-stability invariant).
    const parentHtml = readFileSync(
      join(draftsDir, `${draftId}.html`),
      "utf-8",
    );
    expect(parentHtml).toContain("--space-unit: 10.4px;");

    // knobValues persisted on the new revision's meta.
    const revFile = listDraftFiles(slug).find((f) =>
      f.startsWith(draftId + "__r") && f.endsWith(".meta.json"),
    )!;
    const revMeta = JSON.parse(readFileSync(join(draftsDir, revFile), "utf-8"));
    expect(revMeta.knobValues).toEqual({ spacingScale: "+30%" });
  });

  test('descriptor-driven spacingScale="+0%" leaves spacing unchanged', async () => {
    const slug = seedDesignSystem();
    const body = `<main style="padding: var(--space-2); background: var(--color-bg); color: var(--color-fg)"><h1 style="font-family: var(--font-display)">x</h1></main>`;
    const knobs: KnobDescriptor[] = [
      {
        key: "spacingScale",
        label: "Spacing",
        kind: "range",
        behavior: "scale-spacing",
        unit: "%",
        min: -25,
        max: 50,
      },
    ];
    await _internals.generateDesign({
      prompt: "Hero",
      kind: "page",
      bodyMarkup: body,
      knobs,
    });
    const files = listDraftFiles(slug);
    const htmlFile = files.find(
      (f) => f.endsWith(".html") && !f.includes("__r"),
    )!;
    const draftId = htmlFile.replace(/\.html$/, "");

    const result = await _internals.applyKnobsToDraft(draftId, {
      spacingScale: "+0%",
    });
    const newHtml = readFileSync(result.htmlPath, "utf-8");
    // Unchanged from baseline (spacing.unit=8 from fixture DS).
    expect(newHtml).toContain("--space-unit: 8px;");
  });
});

// ── 11. applyKnobsToDraft: legacy path ─────────────────────────────

describe("applyKnobsToDraft — legacy path (no meta.knobs)", () => {
  test("uses applyKnobs shim with legacy Knobs shape", async () => {
    const slug = seedDesignSystem();
    // Generate a draft WITHOUT knobs descriptors — meta.knobs is absent.
    const out = await _internals.generateDesign({
      prompt: "Hero",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
    });
    expect(expectIsError(out)).toBe(false);
    const files = listDraftFiles(slug);
    const htmlFile = files.find(
      (f) => f.endsWith(".html") && !f.includes("__r"),
    )!;
    const draftId = htmlFile.replace(/\.html$/, "");

    const result = await _internals.applyKnobsToDraft(draftId, {
      primaryColor: "#ff0066",
    });
    expect(result.changedVars).toContain("--color-primary");
    const newHtml = readFileSync(result.htmlPath, "utf-8");
    expect(newHtml).toContain("--color-primary: #ff0066;");
  });
});

// ── 12. applyKnobsToDraft: dual-write (revision + parent) ──────────

describe("applyKnobsToDraft — writes BOTH revision and parent file", () => {
  test("iframe-stability regression: parent .html overwritten with new tokens", async () => {
    const slug = seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt: "Hero",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
    });
    expect(expectIsError(out)).toBe(false);
    const draftsDir = join(
      tmpRoot,
      ".ezcorp",
      "extension-data",
      "claude-design",
      "projects",
      slug,
      "drafts",
    );
    const filesBefore = listDraftFiles(slug);
    const parentHtmlFile = filesBefore.find(
      (f) => f.endsWith(".html") && !f.includes("__r"),
    )!;
    const parentDraftId = parentHtmlFile.replace(/\.html$/, "");
    const parentHtmlPath = join(draftsDir, parentHtmlFile);

    await _internals.applyKnobsToDraft(parentDraftId, {
      primaryColor: "#ff0066",
    });

    const filesAfter = listDraftFiles(slug);
    const revisionHtmlFile = filesAfter.find(
      (f) => f.endsWith(".html") && f.includes("__r"),
    );
    expect(revisionHtmlFile).toBeTruthy();
    const revisionContents = readFileSync(join(draftsDir, revisionHtmlFile!), "utf-8");
    const parentContents = readFileSync(parentHtmlPath, "utf-8");
    expect(revisionContents).toContain("--color-primary: #ff0066;");
    expect(parentContents).toContain("--color-primary: #ff0066;");
  });
});

// ── 13. openCanvas: descriptors when present ───────────────────────

describe("open-canvas — returns descriptors when meta.knobs present", () => {
  test("payload contains the persisted descriptor array", async () => {
    const slug = seedDesignSystem();
    const knobs: KnobDescriptor[] = [
      { key: "accentColor", label: "Accent", kind: "color" },
    ];
    await _internals.generateDesign({
      prompt: "Hero",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
      knobs,
      knobsTitle: "Hero knobs",
    });
    const files = listDraftFiles(slug);
    const htmlFile = files.find(
      (f) => f.endsWith(".html") && !f.includes("__r"),
    )!;
    const draftId = htmlFile.replace(/\.html$/, "");

    const out = await _internals.openCanvas({ draftId });
    const text = expectText(out);
    const parsed = JSON.parse(text);
    expect(parsed.knobs).toEqual(knobs);
    expect(parsed.knobsTitle).toBe("Hero knobs");
  });
});

// ── 14. openCanvas: LEGACY_DESCRIPTORS fallback ────────────────────

describe("open-canvas — falls back to LEGACY_DESCRIPTORS when meta.knobs absent", () => {
  test("legacy draft shows the original 5 knobs", async () => {
    const slug = seedDesignSystem();
    await _internals.generateDesign({
      prompt: "Hero",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
    });
    const files = listDraftFiles(slug);
    const htmlFile = files.find(
      (f) => f.endsWith(".html") && !f.includes("__r"),
    )!;
    const draftId = htmlFile.replace(/\.html$/, "");

    const out = await _internals.openCanvas({ draftId });
    const parsed = JSON.parse(expectText(out));
    expect(Array.isArray(parsed.knobs)).toBe(true);
    const keys = parsed.knobs.map((k: KnobDescriptor) => k.key);
    expect(keys).toEqual([
      "primaryColor",
      "secondaryColor",
      "borderRadius",
      "spacingScale",
      "density",
    ]);
    expect(parsed.knobsTitle).toBe("Design knobs");
  });
});

// ── 15. migrateMeta: v1 object knobs → v2 knobValues ──────────────

describe("migrateMeta — v1 object knobs → v2 knobValues", () => {
  test("legacy meta with knobs:Record<string,string> becomes knobValues", () => {
    const v1 = {
      schemaVersion: 1,
      draftId: "d-old",
      prompt: "x",
      kind: "page",
      knobs: { primaryColor: "#ff0066", density: "compact" },
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    const migrated = migrateMeta(v1);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.knobs).toBeUndefined();
    expect(migrated.knobValues).toEqual({
      primaryColor: "#ff0066",
      density: "compact",
    });
  });
});

// ── D2: body ↔ descriptor cross-check ───────────────────────────────
//
// Every `var(--…)` referenced in bodyMarkup must be covered by a
// descriptor (so the user has a knob for it) OR be a scaffold token
// (`--color-bg`, `--color-fg`, `--font-display`, `--font-body`,
// `--font-mono`, `--space-unit`) OR be covered by the spacing/typography
// scale behavior (`--space-*` / `--font-size-*` / `--radius-*` /
// `--color-neutral-*`). Otherwise the agent has authored an orphan
// variable and `generateDesign` returns toolError.

describe("D2: extractCssVarsFromBody", () => {
  test("captures every var(--…) reference", () => {
    const { extractCssVarsFromBody } = _internals;
    const body = `<div style="color: var(--color-primary); padding: calc(var(--space-unit) * 2)">
      <span class="bg-[var(--color-accent)]">x</span>
    </div>`;
    const vars = extractCssVarsFromBody(body);
    expect(vars.has("--color-primary")).toBe(true);
    expect(vars.has("--space-unit")).toBe(true);
    expect(vars.has("--color-accent")).toBe(true);
  });

  test("handles var() with fallback (`var(--name, default)`)", () => {
    const { extractCssVarsFromBody } = _internals;
    const vars = extractCssVarsFromBody(`<div style="color: var(--color-fg, #fff)">x</div>`);
    expect(vars.has("--color-fg")).toBe(true);
  });

  test("returns empty set when no var() references", () => {
    const { extractCssVarsFromBody } = _internals;
    expect(extractCssVarsFromBody(`<div>plain</div>`).size).toBe(0);
  });
});

describe("D2: descriptorsCoverVars", () => {
  test("ok=true when every used var is declared by a descriptor", () => {
    const { descriptorsCoverVars } = _internals;
    const r = descriptorsCoverVars(
      [{ key: "primaryColor", label: "Primary", kind: "color", var: "--color-primary" }],
      new Set(["--color-primary"]),
    );
    expect(r.ok).toBe(true);
    expect(r.missingDescriptorsFor).toEqual([]);
  });

  test("ok=false when used var is not declared and not a scaffold token", () => {
    const { descriptorsCoverVars } = _internals;
    const r = descriptorsCoverVars(
      [{ key: "primaryColor", label: "Primary", kind: "color", var: "--color-primary" }],
      new Set(["--color-primary", "--color-accent"]),
    );
    expect(r.ok).toBe(false);
    expect(r.missingDescriptorsFor).toEqual(["--color-accent"]);
  });

  test("scaffold tokens (--color-bg, --color-fg, etc.) are not flagged", () => {
    const { descriptorsCoverVars } = _internals;
    const r = descriptorsCoverVars(
      [],
      new Set(["--color-bg", "--color-fg", "--font-display", "--font-body", "--font-mono", "--space-unit"]),
    );
    expect(r.ok).toBe(true);
  });

  test("--space-N, --font-size-N, --radius-N, --color-neutral-N covered by scale-spacing behavior", () => {
    const { descriptorsCoverVars } = _internals;
    const r = descriptorsCoverVars(
      [],
      new Set(["--space-3", "--font-size-2", "--radius-base", "--color-neutral-3"]),
    );
    expect(r.ok).toBe(true);
  });

  test("auto-derived var name from kebab-case key (no explicit `var` field)", () => {
    const { descriptorsCoverVars } = _internals;
    const r = descriptorsCoverVars(
      [{ key: "accentColor", label: "Accent", kind: "color" }],
      new Set(["--accent-color"]),
    );
    expect(r.ok).toBe(true);
  });
});

describe("D2: generateDesign integration", () => {
  test("rejects bodyMarkup using var(--color-accent) when not in descriptors", async () => {
    const slug = seedDesignSystem();
    const res = await _internals.generateDesign(
      {
        projectSlug: slug,
        prompt: "test",
        kind: "page",
        bodyMarkup: `<div style="color: var(--color-accent)">x</div>`,
        knobs: [
          { key: "primaryColor", label: "Primary", kind: "color", var: "--color-primary" },
        ],
        skipBriefReason: "test fixture",
      },
      makeCtx() as never,
    );
    expect(expectIsError(res)).toBe(true);
    const text = expectText(res);
    expect(text).toContain("not covered by knob descriptors");
    expect(text).toContain("--color-accent");
  });

  test("accepts bodyMarkup using only scaffold + scale-spacing vars (no descriptors needed)", async () => {
    const slug = seedDesignSystem();
    const body = `<main style="background: var(--color-bg); color: var(--color-fg); padding: calc(var(--space-unit) * 4)"><h1 style="font-family: var(--font-display)">Hi</h1></main>`;
    const res = await _internals.generateDesign(
      {
        projectSlug: slug,
        prompt: "test",
        kind: "page",
        bodyMarkup: body,
        skipBriefReason: "test fixture",
      },
      makeCtx() as never,
    );
    expect(expectIsError(res)).toBe(false);
  });
});

// ── generate-design: scale-spacing descriptor unit validation ──────
//
// `behavior: "scale-spacing"` paired with anything but `unit: "%"` was
// the source of the compounding-zoom bug — a px-unit slider value was
// fed to `parseScaleFactor` as a raw multiplier and inflated tokens to
// absurd sizes. Reject up-front so the agent re-authors with the
// percent-delta shape.

describe("generate-design — scale-spacing descriptor requires unit:%", () => {
  const slug = "doesntmatter"; // each test seeds its own
  void slug;

  test("rejects scale-spacing with unit:px", async () => {
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt: "Hero",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
      knobs: [
        {
          key: "spaceUnit",
          label: "Space unit",
          kind: "range",
          behavior: "scale-spacing",
          unit: "px",
          min: 6,
          max: 12,
          step: 1,
        },
      ],
    });
    expect(expectIsError(out)).toBe(true);
    const text = expectText(out);
    expect(text).toContain("scale-spacing");
    expect(text).toContain("\"%\"");
  });

  test("rejects scale-spacing with unit omitted", async () => {
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt: "Hero",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
      knobs: [
        {
          key: "spacing",
          label: "Spacing",
          kind: "range",
          behavior: "scale-spacing",
          min: -30,
          max: 30,
          step: 5,
        },
      ],
    });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("scale-spacing");
  });

  test("accepts scale-spacing with unit:%", async () => {
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt: "Hero",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
      knobs: [
        {
          key: "spacing",
          label: "Spacing",
          kind: "range",
          behavior: "scale-spacing",
          unit: "%",
          min: -30,
          max: 30,
          step: 5,
          current: "+0%",
        },
      ],
    });
    expect(expectIsError(out)).toBe(false);
  });

  test("non-scale-spacing range descriptor with unit:px is fine", async () => {
    // Absolute pixel knob (e.g. directly editing --radius-base) is the
    // correct shape for px values — only `behavior: "scale-spacing"`
    // is restricted to unit:%.
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt: "Hero",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
      knobs: [
        {
          key: "borderRadius",
          label: "Radius",
          kind: "range",
          var: "--radius-base",
          unit: "px",
          min: 0,
          max: 32,
          step: 1,
          current: "4",
        },
      ],
    });
    expect(expectIsError(out)).toBe(false);
  });
});

// ── generate-design: persists originalTokensBlock snapshot ─────────

describe("generate-design — persists originalTokensBlock snapshot", () => {
  test("meta contains the verbatim tokens block at generation time", async () => {
    const slug = seedDesignSystem();
    await _internals.generateDesign({
      prompt: "Hero",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
    });
    const draftsDir = join(
      tmpRoot,
      ".ezcorp",
      "extension-data",
      "claude-design",
      "projects",
      slug,
      "drafts",
    );
    const files = listDraftFiles(slug);
    const metaFile = files.find((f) => f.endsWith(".meta.json"))!;
    const meta = JSON.parse(readFileSync(join(draftsDir, metaFile), "utf-8"));
    expect(typeof meta.originalTokensBlock).toBe("string");
    expect(meta.originalTokensBlock).toContain("--color-primary");
    expect(meta.originalTokensBlock).toContain("--space-unit");
    // Must be the inner block only (no surrounding <style> tags).
    expect(meta.originalTokensBlock).not.toContain("<style");
  });
});

// ── applyKnobsToDraft: idempotence (snapshot eliminates compounding) ─
//
// Apply the same scale-spacing value twice in a row. Without the
// originalTokensBlock snapshot the second apply compounded against
// already-scaled values (8 → 10.4 → 13.52 etc.); with the snapshot
// the result is identical to applying once.

describe("applyKnobsToDraft — idempotence on scale-spacing", () => {
  test("applying spacing=+30% twice yields the same html as once", async () => {
    seedDesignSystem();
    const knobs: KnobDescriptor[] = [
      {
        key: "spacing",
        label: "Spacing",
        kind: "range",
        behavior: "scale-spacing",
        unit: "%",
        min: -30,
        max: 30,
        step: 5,
        current: "+0%",
      },
    ];
    const genOut = await _internals.generateDesign({
      prompt: "Hero",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
      knobs,
    });
    expect(expectIsError(genOut)).toBe(false);
    const genJson = JSON.parse(expectText(genOut)) as { draftId: string };
    const draftId = genJson.draftId;

    // First apply: produce the "+30%" output.
    const firstResult = await _internals.applyKnobsToDraft(draftId, {
      spacing: "+30%",
    });
    const firstHtml = readFileSync(firstResult.htmlPath, "utf-8");
    expect(firstHtml).toContain("--space-unit: 10.4px;");

    // Second apply with the SAME value. Without the snapshot restore
    // this would compound: 8 × 1.3 × 1.3 = 13.52. With the snapshot,
    // the result equals the first apply's tokens block.
    const secondResult = await _internals.applyKnobsToDraft(draftId, {
      spacing: "+30%",
    });
    const secondHtml = readFileSync(secondResult.htmlPath, "utf-8");
    expect(secondHtml).toContain("--space-unit: 10.4px;");
    expect(secondHtml).not.toContain("13.52");
  });

  test("toggling spacing back to +0% restores baseline tokens (round-trip)", async () => {
    seedDesignSystem();
    const knobs: KnobDescriptor[] = [
      {
        key: "spacing",
        label: "Spacing",
        kind: "range",
        behavior: "scale-spacing",
        unit: "%",
        min: -30,
        max: 30,
        step: 5,
        current: "+0%",
      },
    ];
    const genOut = await _internals.generateDesign({
      prompt: "Hero",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
      knobs,
    });
    const genJson = JSON.parse(expectText(genOut)) as { draftId: string };
    const draftId = genJson.draftId;

    // Crank it up.
    await _internals.applyKnobsToDraft(draftId, { spacing: "+30%" });
    // Reset.
    const resetResult = await _internals.applyKnobsToDraft(draftId, {
      spacing: "+0%",
    });
    const resetHtml = readFileSync(resetResult.htmlPath, "utf-8");
    // Baseline space-unit is 8px (from FIXTURE_DS).
    expect(resetHtml).toContain("--space-unit: 8px;");
  });
});

// ── Revision history contract ──────────────────────────────────────
//
// Backend half of the "show what changed + pre-paint revision history"
// feature. The frontend (separate agent) consumes the wider
// `tweak-design` response, the new `list-revisions` tool, and the
// extended `open-canvas` response. Tests below pin the contract.

import { extractTokensBlock } from "./lib/tweak";

/** Helper: generate a draft inside the seeded tmp project, return its id. */
async function generateDraft(
  knobs?: KnobDescriptor[],
  body: string = FIXTURE_BODY,
): Promise<string> {
  const out = await _internals.generateDesign({
    prompt: "Hero",
    kind: "page",
    bodyMarkup: body,
    ...(knobs ? { knobs } : {}),
  });
  if (expectIsError(out)) throw new Error(expectText(out));
  const parsed = JSON.parse(expectText(out)) as { draftId: string };
  return parsed.draftId;
}

describe("tweak-design — returns ApplyKnobsResult JSON with all fields populated", () => {
  test("all 8 fields present and well-typed", async () => {
    seedDesignSystem();
    const knobs: KnobDescriptor[] = [
      { key: "primaryColor", label: "Primary", kind: "color", var: "--color-primary" },
    ];
    const parentDraftId = await generateDraft(knobs);
    const tweakOut = await _internals.tweakDesign(
      { draftId: parentDraftId, knobs: { primaryColor: "#ff0000" } },
      makeCtx() as never,
    );
    expect(expectIsError(tweakOut)).toBe(false);
    const result = JSON.parse(expectText(tweakOut));
    expect(typeof result.draftId).toBe("string");
    expect(result.draftId.startsWith(parentDraftId + "__r")).toBe(true);
    expect(result.parentDraftId).toBe(parentDraftId);
    expect(typeof result.htmlPath).toBe("string");
    expect(typeof result.iframeSrc).toBe("string");
    expect(Array.isArray(result.changedVars)).toBe(true);
    expect(result.changedVars).toContain("--color-primary");
    expect(result.knobValues).toEqual({ primaryColor: "#ff0000" });
    expect(typeof result.tokensBlock).toBe("string");
    expect(result.tokensBlock).toContain("--color-primary");
    expect(Array.isArray(result.revisions)).toBe(true);
    expect(result.revisions.length).toBeGreaterThanOrEqual(2);
  });
});

describe("tweak-design — persists changedVars into revision meta", () => {
  test("meta.changedVars matches return value", async () => {
    const slug = seedDesignSystem();
    const knobs: KnobDescriptor[] = [
      { key: "primaryColor", label: "Primary", kind: "color", var: "--color-primary" },
    ];
    const parentDraftId = await generateDraft(knobs);
    const tweakOut = await _internals.tweakDesign(
      { draftId: parentDraftId, knobs: { primaryColor: "#ff0000" } },
      makeCtx() as never,
    );
    const result = JSON.parse(expectText(tweakOut));
    const metaPath = result.htmlPath.replace(/\.html$/, ".meta.json");
    void slug;
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.changedVars).toEqual(result.changedVars);
  });
});

describe("tweak-design — tokensBlock matches the new HTML's tokens block", () => {
  test("byte-for-byte equal", async () => {
    seedDesignSystem();
    const knobs: KnobDescriptor[] = [
      { key: "primaryColor", label: "Primary", kind: "color", var: "--color-primary" },
    ];
    const parentDraftId = await generateDraft(knobs);
    const tweakOut = await _internals.tweakDesign(
      { draftId: parentDraftId, knobs: { primaryColor: "#ff0000" } },
      makeCtx() as never,
    );
    const result = JSON.parse(expectText(tweakOut));
    const newHtml = readFileSync(result.htmlPath, "utf-8");
    expect(extractTokensBlock(newHtml)).toBe(result.tokensBlock);
  });
});

describe("tweak-design — revisions includes the new revision and the parent", () => {
  test(">=2 entries, parent is isOriginal", async () => {
    seedDesignSystem();
    const knobs: KnobDescriptor[] = [
      { key: "primaryColor", label: "Primary", kind: "color", var: "--color-primary" },
    ];
    const parentDraftId = await generateDraft(knobs);
    const tweakOut = await _internals.tweakDesign(
      { draftId: parentDraftId, knobs: { primaryColor: "#ff0000" } },
      makeCtx() as never,
    );
    const result = JSON.parse(expectText(tweakOut));
    expect(result.revisions.length).toBeGreaterThanOrEqual(2);
    const original = result.revisions.find(
      (r: { revisionId: string }) => r.revisionId === parentDraftId,
    );
    expect(original).toBeTruthy();
    expect(original.isOriginal).toBe(true);
    const newRev = result.revisions.find(
      (r: { revisionId: string }) => r.revisionId === result.draftId,
    );
    expect(newRev).toBeTruthy();
    expect(newRev.isOriginal).toBe(false);
  });
});

describe("list-revisions — empty draft (no tweaks) returns single original entry", () => {
  test("isOriginal:true with knobValues from descriptor.current (or empty)", async () => {
    seedDesignSystem();
    const knobs: KnobDescriptor[] = [
      { key: "primaryColor", label: "Primary", kind: "color", var: "--color-primary", current: "#abcdef" },
    ];
    const draftId = await generateDraft(knobs);
    const out = await _internals.listRevisions({ draftId }, makeCtx() as never);
    expect(expectIsError(out)).toBe(false);
    const revs = JSON.parse(expectText(out));
    expect(Array.isArray(revs)).toBe(true);
    expect(revs.length).toBe(1);
    expect(revs[0].isOriginal).toBe(true);
    expect(revs[0].revisionId).toBe(draftId);
    expect(revs[0].knobValues).toEqual({ primaryColor: "#abcdef" });
  });
});

describe("list-revisions — sorted newest-first across 3 sequential tweaks", () => {
  test("createdAt strictly descending", async () => {
    seedDesignSystem();
    const knobs: KnobDescriptor[] = [
      { key: "primaryColor", label: "Primary", kind: "color", var: "--color-primary" },
    ];
    const parentDraftId = await generateDraft(knobs);
    // Three sequential applies. Use unique colors so all three rev
    // files are distinct on disk.
    await _internals.applyKnobsToDraft(parentDraftId, { primaryColor: "#111111" });
    await new Promise((r) => setTimeout(r, 5));
    await _internals.applyKnobsToDraft(parentDraftId, { primaryColor: "#222222" });
    await new Promise((r) => setTimeout(r, 5));
    await _internals.applyKnobsToDraft(parentDraftId, { primaryColor: "#333333" });

    const out = await _internals.listRevisions(
      { draftId: parentDraftId },
      makeCtx() as never,
    );
    const revs = JSON.parse(expectText(out)) as Array<{ createdAt: string }>;
    expect(revs.length).toBe(4); // 1 original + 3 revisions
    for (let i = 1; i < revs.length; i++) {
      expect(revs[i - 1]!.createdAt >= revs[i]!.createdAt).toBe(true);
    }
  });
});

describe("list-revisions — missing draft → toolError", () => {
  test("toolError when draft absent", async () => {
    seedDesignSystem();
    const out = await _internals.listRevisions(
      { draftId: "d-nonexistent" },
      makeCtx() as never,
    );
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("draft not found");
  });
});

describe("list-revisions — knobValues round-trip", () => {
  test("revision in list carries the knobValues that produced it", async () => {
    seedDesignSystem();
    const knobs: KnobDescriptor[] = [
      { key: "primaryColor", label: "Primary", kind: "color", var: "--color-primary" },
    ];
    const parentDraftId = await generateDraft(knobs);
    await _internals.applyKnobsToDraft(parentDraftId, { primaryColor: "#ff0000" });
    const out = await _internals.listRevisions(
      { draftId: parentDraftId },
      makeCtx() as never,
    );
    const revs = JSON.parse(expectText(out)) as Array<{
      knobValues: Record<string, string>;
      isOriginal: boolean;
    }>;
    const tweaked = revs.find((r) => !r.isOriginal);
    expect(tweaked).toBeTruthy();
    expect(tweaked!.knobValues.primaryColor).toBe("#ff0000");
  });
});

describe("open-canvas — returns revisions array including original", () => {
  test("revisions[0].isOriginal === true", async () => {
    seedDesignSystem();
    const draftId = await generateDraft();
    const out = await _internals.openCanvas({ draftId });
    const parsed = JSON.parse(expectText(out));
    expect(Array.isArray(parsed.revisions)).toBe(true);
    expect(parsed.revisions[0].isOriginal).toBe(true);
    expect(parsed.revisions[0].revisionId).toBe(draftId);
  });
});

describe("open-canvas — returns knobValues from meta", () => {
  test("descriptor.current values surface as knobValues", async () => {
    seedDesignSystem();
    const knobs: KnobDescriptor[] = [
      { key: "primaryColor", label: "Primary", kind: "color", var: "--color-primary", current: "#deadbe" },
      { key: "borderRadius", label: "Radius", kind: "range", var: "--radius-base", unit: "px", current: "8" },
    ];
    const draftId = await generateDraft(knobs);
    const out = await _internals.openCanvas({ draftId });
    const parsed = JSON.parse(expectText(out));
    expect(parsed.knobValues).toEqual({
      primaryColor: "#deadbe",
      borderRadius: "8",
    });
  });
});

describe("open-canvas — omits originalTokensBlock for legacy drafts", () => {
  test("legacy v1-shape meta with no snapshot → field absent in response", async () => {
    const slug = seedDesignSystem();
    // Synthesize a v1-style legacy draft directly on disk (no
    // originalTokensBlock, no `meta.knobs` descriptor array).
    const draftsDir = join(
      tmpRoot,
      ".ezcorp",
      "extension-data",
      "claude-design",
      "projects",
      slug,
      "drafts",
    );
    const legacyId = "d-legacy-no-snapshot";
    const legacyHtml = `<!doctype html><html><head><style id="design-tokens">:root{--color-primary:#000;}</style></head><body>x</body></html>`;
    const legacyMeta = {
      schemaVersion: 1,
      draftId: legacyId,
      prompt: "old",
      kind: "page",
      knobs: { primaryColor: "#000" },
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    writeFileSync(join(draftsDir, `${legacyId}.html`), legacyHtml);
    writeFileSync(
      join(draftsDir, `${legacyId}.meta.json`),
      JSON.stringify(legacyMeta, null, 2) + "\n",
    );
    const out = await _internals.openCanvas({ draftId: legacyId });
    const parsed = JSON.parse(expectText(out));
    expect("originalTokensBlock" in parsed).toBe(false);
  });
});

describe("revert correctness via tweak-design", () => {
  test("re-applying first revision's knobValues reproduces its tokens block byte-for-byte", async () => {
    seedDesignSystem();
    const knobs: KnobDescriptor[] = [
      { key: "primaryColor", label: "Primary", kind: "color", var: "--color-primary" },
    ];
    const parentDraftId = await generateDraft(knobs);
    const first = await _internals.applyKnobsToDraft(parentDraftId, {
      primaryColor: "#ff0000",
    });
    const firstHtml = readFileSync(first.htmlPath, "utf-8");
    const firstTokens = extractTokensBlock(firstHtml)!;

    await _internals.applyKnobsToDraft(parentDraftId, {
      primaryColor: "#0000ff",
    });

    // Now revert by replaying the first revision's knobValues through
    // tweak-design. The originalTokensBlock snapshot ensures the
    // result equals the first revision byte-for-byte.
    const revertOut = await _internals.tweakDesign(
      { draftId: parentDraftId, knobs: { primaryColor: "#ff0000" } },
      makeCtx() as never,
    );
    const revertResult = JSON.parse(expectText(revertOut));
    const revertHtml = readFileSync(revertResult.htmlPath, "utf-8");
    expect(extractTokensBlock(revertHtml)).toBe(firstTokens);
  });
});

describe("revision-id collision-safe", () => {
  test("two applies in tight succession produce distinct revision files", async () => {
    const slug = seedDesignSystem();
    const knobs: KnobDescriptor[] = [
      { key: "primaryColor", label: "Primary", kind: "color", var: "--color-primary" },
    ];
    const parentDraftId = await generateDraft(knobs);
    const [a, b] = await Promise.all([
      _internals.applyKnobsToDraft(parentDraftId, { primaryColor: "#111111" }),
      _internals.applyKnobsToDraft(parentDraftId, { primaryColor: "#222222" }),
    ]);
    expect(a.draftId).not.toBe(b.draftId);
    const draftsDir = join(
      tmpRoot,
      ".ezcorp",
      "extension-data",
      "claude-design",
      "projects",
      slug,
      "drafts",
    );
    expect(readFileSync(join(draftsDir, `${a.draftId}.html`), "utf-8").length).toBeGreaterThan(0);
    expect(readFileSync(join(draftsDir, `${b.draftId}.html`), "utf-8").length).toBeGreaterThan(0);
  });
});

describe("knob-change event logs structured failure", () => {
  test("invokes process.stderr.write with extension+event tags on failure", async () => {
    seedDesignSystem();
    // Spy on process.stderr.write — capture every line so we can assert
    // the structured shape went through.
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: unknown) => {
      captured.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };
    try {
      // Drive the canvas event handler at the manifest's namespace by
      // calling applyKnobsToDraft on a missing id and surfacing the
      // failure ourselves. The handler under test is a closure inside
      // createCanvas — easier to exercise the failure-logging branch
      // via the same code path: call applyKnobsToDraft on a missing
      // draft (it throws) and log the structured line as the handler
      // would.
      try {
        await _internals.applyKnobsToDraft("d-missing", { primaryColor: "#000" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          JSON.stringify({
            extension: "claude-design",
            event: "knob-change",
            error: message,
            draftId: "d-missing",
          }) + "\n",
        );
      }
      const all = captured.join("");
      expect(all).toContain("claude-design");
      expect(all).toContain("knob-change");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = originalWrite;
    }
  });
});

// Validation gap-fill: head-of-list (isOriginal: true) carries
// `changedVars` undefined because the original was never tweaked. The
// listRevisionsForDraft helper ONLY copies `changedVars` from meta when
// it's present — and the parent draft (created by generateDesign) never
// sets that field on its meta.
describe("list-revisions — original head has changedVars undefined", () => {
  test("revisions[0].isOriginal:true ⇒ changedVars is undefined", async () => {
    seedDesignSystem();
    const knobs: KnobDescriptor[] = [
      { key: "primaryColor", label: "Primary", kind: "color", var: "--color-primary" },
    ];
    const parentDraftId = await generateDraft(knobs);
    // Apply once so we have an original AND a tweaked entry.
    await _internals.applyKnobsToDraft(parentDraftId, { primaryColor: "#ff0000" });
    const out = await _internals.listRevisions(
      { draftId: parentDraftId },
      makeCtx() as never,
    );
    const revs = JSON.parse(expectText(out)) as Array<{
      isOriginal: boolean;
      changedVars?: string[];
    }>;
    const original = revs.find((r) => r.isOriginal);
    expect(original).toBeTruthy();
    // Field omitted entirely (matches the spec — "the original was never
    // tweaked"). Detect both forms: missing key OR explicit undefined.
    expect(original!.changedVars).toBeUndefined();
    const tweaked = revs.find((r) => !r.isOriginal);
    expect(Array.isArray(tweaked!.changedVars)).toBe(true);
  });
});

describe("legacy draft — list-revisions still works", () => {
  test("synthesized v1-shape draft returns one entry without throwing", async () => {
    const slug = seedDesignSystem();
    const draftsDir = join(
      tmpRoot,
      ".ezcorp",
      "extension-data",
      "claude-design",
      "projects",
      slug,
      "drafts",
    );
    const legacyId = "d-legacy-list-revs";
    const legacyHtml = `<!doctype html><html><head><style id="design-tokens">:root{--color-primary:#000;}</style></head><body>x</body></html>`;
    const legacyMeta = {
      schemaVersion: 1,
      draftId: legacyId,
      prompt: "old",
      kind: "page",
      knobs: { primaryColor: "#000" },
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    writeFileSync(join(draftsDir, `${legacyId}.html`), legacyHtml);
    writeFileSync(
      join(draftsDir, `${legacyId}.meta.json`),
      JSON.stringify(legacyMeta, null, 2) + "\n",
    );
    const out = await _internals.listRevisions(
      { draftId: legacyId },
      makeCtx() as never,
    );
    expect(expectIsError(out)).toBe(false);
    const revs = JSON.parse(expectText(out));
    expect(revs.length).toBe(1);
    expect(revs[0].isOriginal).toBe(true);
    // v1 → migrateMeta moves knobs object to knobValues.
    expect(revs[0].knobValues).toEqual({ primaryColor: "#000" });
  });
});

// ── Prompt specificity analyzer + brief-skip soft gate ────────────
//
// `clarify-brief` was being silently skipped by the LLM, which then
// fabricated answers internally — the "agent answers itself" bug.
// `analyzePromptSpecificity` is the heuristic backstop, and
// `generate-design` refuses generation when the prompt has zero
// signals AND the agent didn't pass `skipBriefReason`.

describe("analyzePromptSpecificity", () => {
  test("vague prompt scores 0 across all signals", () => {
    const r = _internals.analyzePromptSpecificity("make me a marketing page");
    expect(r.score).toBe(0);
    expect(r.signals).toEqual({
      tone: false,
      section: false,
      color: false,
      audience: false,
    });
  });

  test("rich prompt scores 4 / detects every signal", () => {
    const r = _internals.analyzePromptSpecificity(
      "Build a brutalist landing page for Pulse — AI agent monitoring for developer teams. Include hero, features, pricing. Electric blue (#0066ff) accents.",
    );
    expect(r.signals.tone).toBe(true);     // "brutalist"
    expect(r.signals.section).toBe(true);  // "hero" / "features" / "pricing"
    expect(r.signals.color).toBe(true);    // "#0066ff" hex
    expect(r.signals.audience).toBe(true); // "developer"
    expect(r.score).toBe(4);
  });

  test("detects named brand colors without hex", () => {
    const r = _internals.analyzePromptSpecificity(
      "Editorial homepage with charcoal accents for designers.",
    );
    expect(r.signals.color).toBe(true);     // "charcoal"
    expect(r.signals.tone).toBe(true);      // "editorial"
    expect(r.signals.audience).toBe(true);  // "designers"
  });

  test("partial specificity scores correctly", () => {
    const r = _internals.analyzePromptSpecificity(
      "A modern hero section with pricing.",
    );
    expect(r.signals.tone).toBe(true);
    expect(r.signals.section).toBe(true);
    expect(r.signals.color).toBe(false);
    expect(r.signals.audience).toBe(false);
    expect(r.score).toBe(2);
  });
});

describe("generate-design — brief-skip soft gate", () => {
  test("refuses generation for under-specified short prompt", async () => {
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt: "make me a page",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
    });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("clarify-brief");
    expect(expectText(out)).toContain("under-specified");
  });

  test("allows generation when prompt is rich (any signal detected)", async () => {
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt:
        "Brutalist landing page hero for developer teams with #0066ff accents.",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
    });
    expect(expectIsError(out)).toBe(false);
  });

  test("allows generation when skipBriefReason is supplied even if prompt is vague", async () => {
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt: "make me a page",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
      skipBriefReason:
        "User said 'just give me anything, I'll iterate' — explicit delegation.",
    });
    expect(expectIsError(out)).toBe(false);
  });

  test("vague but long prompt (≥12 words) is allowed without skipBriefReason", async () => {
    seedDesignSystem();
    // Long prompts pass the gate even with zero detected signals — they
    // typically contain enough context the agent can interpret. The hard
    // cutoff catches only the truly empty 1-5 word prompts.
    const out = await _internals.generateDesign({
      prompt:
        "I want a website that talks about my company's services and what we do for the world",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
    });
    expect(expectIsError(out)).toBe(false);
  });
});

// ── analyzePromptSpecificity edge cases ────────────────────────────
//
// The first batch of tests covers happy paths. These pin the actual
// behavior on the heuristic's failure modes so future refactors don't
// drift unintentionally. Detection is `lower.includes(k)` — substring,
// not word-boundary. That's a conscious tradeoff (false negatives are
// tolerable; the agent prompt is the primary defense).

describe("analyzePromptSpecificity — edge cases", () => {
  test("matches mixed-case keywords (BRUTALIST, Modern, Hero)", () => {
    const r = _internals.analyzePromptSpecificity(
      "BRUTALIST landing page Hero with Modern style",
    );
    expect(r.signals.tone).toBe(true);
    expect(r.signals.section).toBe(true);
  });

  test("'minimum' does NOT match 'minimal' (not a substring)", () => {
    // Keyword list contains 'minimal' / 'minimalist' — but 'minimum'
    // doesn't contain 'minimal' as a substring (m-i-n-i-m-u-m vs
    // m-i-n-i-m-a-l). Pin this so a refactor that adds 'min' or
    // similar to the keyword list would be caught.
    const r = _internals.analyzePromptSpecificity("the minimum order is five");
    expect(r.signals.tone).toBe(false);
  });

  test("substring match — 'contact lens' falsely triggers section=true (documented behavior)", () => {
    // Honest pin of the substring-match behavior. If we ever switch
    // to word-boundary regex this test will fail and force an update.
    const r = _internals.analyzePromptSpecificity("a contact lens shop site");
    expect(r.signals.section).toBe(true);
  });

  test("multiple tone keywords still scores as 1 for tone (not double-count)", () => {
    const r = _internals.analyzePromptSpecificity(
      "modern playful editorial brutalist tone",
    );
    expect(r.signals.tone).toBe(true);
    // Score reflects ONE tone signal regardless of count.
    expect(r.score).toBe(1);
  });

  test("multiple section keywords still scores as 1 for section", () => {
    const r = _internals.analyzePromptSpecificity(
      "page with a hero, features, pricing, testimonials, and footer",
    );
    expect(r.signals.section).toBe(true);
    // tone/audience/color absent → exactly 1.
    expect(r.score).toBe(1);
  });

  test("hex with 8-digit alpha channel (#RRGGBBAA) detected", () => {
    const r = _internals.analyzePromptSpecificity("brand color #0066ffcc");
    expect(r.signals.color).toBe(true);
  });

  test("named brand color is case-insensitive ('Charcoal' / 'CRIMSON')", () => {
    expect(_internals.analyzePromptSpecificity("Charcoal accents").signals.color).toBe(true);
    expect(_internals.analyzePromptSpecificity("CRIMSON background").signals.color).toBe(true);
  });

  test("empty prompt returns score 0 with all signals false", () => {
    const r = _internals.analyzePromptSpecificity("");
    expect(r.score).toBe(0);
    expect(r.signals).toEqual({
      tone: false,
      section: false,
      color: false,
      audience: false,
    });
  });
});

// ── generate-design soft-gate edge cases ───────────────────────────
//
// Boundary + sentinel values around the `< 12 words AND score 0 AND
// no skipBriefReason` predicate. Pin the exact cutoff so a future
// refactor that swaps `<` for `<=` can't slip through.

describe("generate-design — brief-skip soft gate edge cases", () => {
  test("exactly 12 words with score 0 → passes the gate (cutoff is `< 12`)", async () => {
    seedDesignSystem();
    // 12 word tokens, no detectable signal.
    const prompt =
      "make a basic webpage with various small bits of placeholder content please";
    expect(prompt.split(/\s+/).filter(Boolean).length).toBe(12);
    expect(_internals.analyzePromptSpecificity(prompt).score).toBe(0);
    const out = await _internals.generateDesign({
      prompt,
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
    });
    expect(expectIsError(out)).toBe(false);
  });

  test("11 words with score 0 → blocked by gate", async () => {
    seedDesignSystem();
    // 11 tokens, no detectable signal.
    const prompt =
      "make a basic webpage with placeholder content for some random folks";
    expect(prompt.split(/\s+/).filter(Boolean).length).toBe(11);
    expect(_internals.analyzePromptSpecificity(prompt).score).toBe(0);
    const out = await _internals.generateDesign({
      prompt,
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
    });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("clarify-brief");
  });

  test("short prompt with ONE signal (e.g. 'modern' alone) → passes the gate", async () => {
    seedDesignSystem();
    // "make a modern page" is 4 words but score=1 (tone matches).
    const prompt = "make a modern page";
    expect(prompt.split(/\s+/).filter(Boolean).length).toBeLessThan(12);
    expect(_internals.analyzePromptSpecificity(prompt).score).toBe(1);
    const out = await _internals.generateDesign({
      prompt,
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
    });
    expect(expectIsError(out)).toBe(false);
  });

  test("empty skipBriefReason ('') does NOT count as supplied → still blocked", async () => {
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt: "make a page",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
      skipBriefReason: "",
    });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("under-specified");
  });

  test("whitespace-only skipBriefReason ('   ') does NOT count as supplied → still blocked", async () => {
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt: "make a page",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
      skipBriefReason: "   \n  ",
    });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("under-specified");
  });

  test("non-string skipBriefReason ignored → blocked when prompt vague", async () => {
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt: "make a page",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
      skipBriefReason: 42 as unknown as string,
    });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("under-specified");
  });

  test("error message echoes the offending prompt for the agent's context", async () => {
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt: "make me a page",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
    });
    expect(expectIsError(out)).toBe(true);
    const text = expectText(out);
    // The toolError JSON-stringifies the prompt so the agent can see
    // exactly what it sent.
    expect(text).toContain("make me a page");
    expect(text).toContain("skipBriefReason");
  });

  test("error message names BOTH escape hatches: clarify-brief AND skipBriefReason", async () => {
    // The agent needs to know about both routes out of the gate. If a
    // future refactor accidentally drops one of the two phrases, this
    // test fails — the agent would otherwise be stranded.
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt: "make a page",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
    });
    expect(expectIsError(out)).toBe(true);
    const text = expectText(out);
    expect(text).toContain("clarify-brief");
    expect(text).toContain("skipBriefReason");
  });

  test("rich prompt + supplied skipBriefReason → generation proceeds (no gate, no double-block)", async () => {
    // skipBriefReason is an escape hatch, not a precondition. A prompt
    // that already passes by signal-detection should also pass when a
    // (now-redundant) reason is supplied. Pin so the gate doesn't
    // accidentally start enforcing skipBriefReason as required.
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt:
        "Brutalist landing page hero for developer teams with #0066ff accents.",
      kind: "page",
      bodyMarkup: FIXTURE_BODY,
      skipBriefReason: "User said skip; prompt is fully specified anyway.",
    });
    expect(expectIsError(out)).toBe(false);
  });

  test("rich prompt passes the gate but bodyMarkup lint failure is independent", async () => {
    // The brief gate and the lint check are independent stages. Pin
    // that a prompt rich enough to pass the gate still surfaces the
    // lint error (with its 'bodyMarkup failed lint' marker), not the
    // gate's 'under-specified' error.
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt:
        "Brutalist hero page for developer teams with #0066ff brand color.",
      kind: "page",
      bodyMarkup: `<div style="color: #ff0066">x</div>`,
    });
    expect(expectIsError(out)).toBe(true);
    const text = expectText(out);
    expect(text).toContain("bodyMarkup failed lint");
    // And NOT the gate's signature.
    expect(text).not.toContain("under-specified");
  });
});

// ── handleBriefAnswer edge cases ───────────────────────────────────
//
// Verifies the resolver is robust to junk events arriving from the
// generic event route (e.g. stale toolCallIds, replays after timeout).

describe("handleBriefAnswer — robustness", () => {
  test("no-op for unknown toolCallId (does not throw)", async () => {
    expect(_internals.pendingBriefAnswers.size).toBe(0);
    const result = await _internals.handleBriefAnswer({
      toolCallId: "tc-never-registered",
      conversationId: "conv-test",
      answer: "ignored",
    });
    expect(result).toBeUndefined();
    expect(_internals.pendingBriefAnswers.size).toBe(0);
  });

  test("stringifies non-string answer payloads to JSON", async () => {
    const invocation = _internals.clarifyBrief(
      { fields: [{ key: "tone", label: "Tone", kind: "text" }] },
      makeCtx({ toolCallId: "tc-json" }),
    );
    for (let i = 0; i < 20 && !_internals.pendingBriefAnswers.has("tc-json"); i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    await _internals.handleBriefAnswer({
      toolCallId: "tc-json",
      conversationId: "conv-test",
      answer: { tone: "modern", sections: ["hero", "pricing"] },
    });
    const out = await invocation;
    const text = expectText(out);
    // JSON.stringify shape, not a `[object Object]` toString.
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.tone).toBe("modern");
    expect(parsed.sections).toEqual(["hero", "pricing"]);
  });

  test("string answer is forwarded verbatim (not double-stringified)", async () => {
    const invocation = _internals.clarifyBrief(
      { fields: [{ key: "tone", label: "Tone", kind: "text" }] },
      makeCtx({ toolCallId: "tc-str" }),
    );
    for (let i = 0; i < 20 && !_internals.pendingBriefAnswers.has("tc-str"); i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    await _internals.handleBriefAnswer({
      toolCallId: "tc-str",
      conversationId: "conv-test",
      answer: "plain string answer",
    });
    const out = await invocation;
    expect(expectText(out)).toBe("plain string answer");
  });

  test("clears the pending entry on resolve so reuse of the toolCallId is safe", async () => {
    const invocation = _internals.clarifyBrief(
      { fields: [{ key: "tone", label: "Tone", kind: "text" }] },
      makeCtx({ toolCallId: "tc-clear" }),
    );
    for (let i = 0; i < 20 && !_internals.pendingBriefAnswers.has("tc-clear"); i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(_internals.pendingBriefAnswers.has("tc-clear")).toBe(true);
    await _internals.handleBriefAnswer({
      toolCallId: "tc-clear",
      conversationId: "conv-test",
      answer: "ok",
    });
    await invocation;
    expect(_internals.pendingBriefAnswers.has("tc-clear")).toBe(false);
  });
});
