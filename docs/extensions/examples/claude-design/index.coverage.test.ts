// Coverage gap-fill for the claude-design bundled extension.
//
// `index.test.ts` covers the brief-gate, knob math, and revision
// contract. This file exercises the remaining real handlers and fs
// glue the gate enforces 100%-line on:
//   - extract-design-system: greenfield extraction (drives globAsync /
//     compileGlob / the readFile JsonRpcError→null catch) + the cached
//     and force re-extract branches.
//   - package-handoff: happy path (drives listBundleFilesRelative's
//     recursive walk) + every early toolError.
//   - list-drafts / get-draft: happy + empty + missing-draft + truncation.
//   - tweak-design: missing-draft error branch.
//   - generate-design: descriptor-validation branches + "design system
//     not extracted" error.
//   - clarify-brief: per-field validation branches + missing tool-call
//     context.
//   - the two createCanvas event closures (knob-change happy / missing-
//     draftId log / error log, and brief-answer routing) via the
//     manifest-registered handlers.
//
// Test seam mirrors index.test.ts byte-for-byte: tmp dir + `.git` so
// findProjectRoot resolves locally, and a getChannel().request stub that
// routes fs RPC to real disk IO. No DB, no real channel.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getChannel, JsonRpcError } from "@ezcorp/sdk/runtime";

import { _internals, _setBriefTimeoutForTests } from "./index";
import type { DesignSystem, KnobDescriptor } from "./lib/types";

// ── In-test fs RPC stub (identical to index.test.ts) ───────────────

const ORIG_FS_ALLOWED = process.env.EZCORP_FS_ALLOWED;
const ORIG_PROJECT_ROOT = process.env.EZCORP_PROJECT_ROOT;

/** Core fs-RPC routing to real disk. `throwListFor`, when supplied,
 *  forces `ezcorp/fs.list` to throw for matching paths (drives the
 *  defensive TOCTOU catch arms). */
async function fsRpc(
  method: string,
  params: unknown,
  throwListFor?: (path: string) => boolean,
): Promise<unknown> {
  {
    const p = (params ?? {}) as Record<string, unknown>;
    const path = p.path as string;
    if (method === "ezcorp/fs.list" && throwListFor?.(path)) {
      throw new JsonRpcError(-32000, `ENOENT: directory vanished: ${path}`);
    }
    if (method === "ezcorp/fs.read") {
      if (!existsSync(path)) {
        throw new JsonRpcError(-32000, `ENOENT: no such file or directory: ${path}`);
      }
      const bytes = readFileSync(path);
      const body = btoa(String.fromCharCode.apply(null, Array.from(bytes)));
      const encoding = (p.encoding as string) ?? "utf-8";
      return { encoding, body, bytes: bytes.byteLength, resolvedPath: path };
    }
    if (method === "ezcorp/fs.write") {
      const content = p.content as string;
      const encoding = p.encoding as string;
      const bytes = encoding === "binary"
        ? Uint8Array.from(atob(content), (c) => c.charCodeAt(0))
        : new TextEncoder().encode(content);
      writeFileSync(path, bytes);
      return { bytes: bytes.byteLength, resolvedPath: path };
    }
    if (method === "ezcorp/fs.mkdir") {
      mkdirSync(path, { recursive: p.recursive === true });
      return { resolvedPath: path };
    }
    if (method === "ezcorp/fs.list") {
      if (!existsSync(path)) {
        throw new JsonRpcError(-32000, `ENOENT: no such file or directory: ${path}`);
      }
      const names = readdirSync(path);
      const entries = names.map((name) => {
        const st = statSync(join(path, name));
        return { name, isFile: st.isFile(), isDirectory: st.isDirectory() };
      });
      return { entries };
    }
    if (method === "ezcorp/fs.exists") {
      return { exists: existsSync(path) };
    }
    throw new JsonRpcError(-32601, `claude-design test stub: unexpected RPC method ${method}`);
  }
}

/** Mirrors index.test.ts's fs stub — routes the SDK's reverse-RPC fs
 *  helpers to real disk via `fsRpc`. */
function installFsStub(): void {
  const ch = getChannel();
  spyOn(ch, "request").mockImplementation((
    (method: string, params: unknown) => fsRpc(method, params)
  ) as ReturnType<typeof getChannel>["request"]);
}

/** Re-install the fs stub but make `ezcorp/fs.list` throw for any path
 *  matching `throwListFor`. Used to drive the defensive `catch` arms
 *  around `fsList` (a dir vanishing between an `exists` check and a
 *  `list` — a real TOCTOU the code guards against). Everything else
 *  routes to real disk exactly like `installFsStub`. */
function installFsStubWithListThrow(throwListFor: (path: string) => boolean): void {
  const ch = getChannel();
  spyOn(ch, "request").mockImplementation((
    (method: string, params: unknown) => fsRpc(method, params, throwListFor)
  ) as ReturnType<typeof getChannel>["request"]);
}

beforeAll(() => {
  process.env.EZCORP_FS_ALLOWED = "1";
});

afterAll(() => {
  if (ORIG_FS_ALLOWED === undefined) delete process.env.EZCORP_FS_ALLOWED;
  else process.env.EZCORP_FS_ALLOWED = ORIG_FS_ALLOWED;
});

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

// ── Tmp-dir + cwd shim (identical to index.test.ts) ────────────────

let tmpRoot: string;
let prevCwd: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "claude-design-cov-"));
  mkdirSync(join(tmpRoot, ".git"));
  prevCwd = process.cwd();
  process.chdir(tmpRoot);
  // findProjectRoot honours EZCORP_PROJECT_ROOT first — clear it so the
  // `.git` walk resolves to the tmp dir (mirrors lib/project.test.ts).
  delete process.env.EZCORP_PROJECT_ROOT;
  _internals.pendingBriefAnswers.clear();
  _setBriefTimeoutForTests(5 * 60_000);
  installFsStub();
  reregisterCanvasHandlers();
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
  if (ORIG_PROJECT_ROOT === undefined) delete process.env.EZCORP_PROJECT_ROOT;
  else process.env.EZCORP_PROJECT_ROOT = ORIG_PROJECT_ROOT;
});

function expectText(out: unknown): string {
  const o = out as { content?: Array<{ type: string; text: string }> };
  const first = o.content?.[0];
  if (!first || first.type !== "text") throw new Error("tool-result has no text content");
  return first.text;
}

function expectIsError(out: unknown): boolean {
  return (out as { isError?: boolean }).isError === true;
}

function dataRoot(): string {
  return join(tmpRoot, ".ezcorp", "extension-data", "claude-design");
}

function projectSlug(): string {
  return tmpRoot.split("/").pop() || "project";
}

function seedDesignSystem(): string {
  const slug = projectSlug();
  const dir = join(dataRoot(), "projects", slug);
  mkdirSync(join(dir, "drafts"), { recursive: true });
  writeFileSync(join(dir, "design-system.json"), JSON.stringify(FIXTURE_DS, null, 2));
  return slug;
}

function listDraftFiles(slug: string): string[] {
  return readdirSync(join(dataRoot(), "projects", slug, "drafts")).sort();
}

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
  return (JSON.parse(expectText(out)) as { draftId: string }).draftId;
}

// ── extract-design-system ──────────────────────────────────────────

describe("extract-design-system", () => {
  test("greenfield root: walks the fs (globAsync/compileGlob) and writes design-system.json", async () => {
    // Seed real source files so globAsync actually MATCHES (drives both
    // the `**/*.css` and `**/components/*.svelte` glob branches) and so
    // the GLOB_SKIP_DIRS guard is exercised (node_modules is skipped).
    writeFileSync(join(tmpRoot, "app.css"), ":root{ --x: 1px; }");
    mkdirSync(join(tmpRoot, "src", "components"), { recursive: true });
    writeFileSync(join(tmpRoot, "src", "components", "Button.svelte"), "<button/>");
    mkdirSync(join(tmpRoot, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(tmpRoot, "node_modules", "pkg", "ignored.css"), "x");

    const out = await _internals.tools["extract-design-system"]!({}, undefined as never);
    expect(expectIsError(out)).toBe(false);
    const ds = JSON.parse(expectText(out)) as DesignSystem;
    expect(ds.schemaVersion).toBe(1);
    expect(Array.isArray(ds.components)).toBe(true);
    // Button.svelte under src/components is catalogued via globAsync.
    expect(ds.components.some((c) => c.name === "Button")).toBe(true);
    // Persisted to disk.
    const dsPath = join(dataRoot(), "projects", projectSlug(), "design-system.json");
    expect(existsSync(dsPath)).toBe(true);
  });

  test("returns the cached design-system.json when present and force is not set", async () => {
    const slug = seedDesignSystem();
    const out = await _internals.tools["extract-design-system"]!(
      { projectSlug: slug },
      undefined as never,
    );
    expect(expectIsError(out)).toBe(false);
    const ds = JSON.parse(expectText(out)) as DesignSystem;
    // Returned verbatim from the seeded fixture (primary #336699 is not
    // a greenfield-default colour).
    expect(ds.colors.primary).toBe("#336699");
  });

  test("force: true bypasses the cache and re-extracts (overwrites fixture)", async () => {
    const slug = seedDesignSystem();
    const out = await _internals.tools["extract-design-system"]!(
      { projectSlug: slug, force: true },
      undefined as never,
    );
    expect(expectIsError(out)).toBe(false);
    const ds = JSON.parse(expectText(out)) as DesignSystem;
    // Re-extraction on a greenfield root yields the default palette, NOT
    // the seeded #336699 — proving `force` re-ran extractFromRoot.
    expect(ds.colors.primary).not.toBe("#336699");
  });
});

// ── package-handoff ────────────────────────────────────────────────

describe("package-handoff", () => {
  test("missing draftId → toolError", async () => {
    const out = await _internals.tools["package-handoff"]!({}, undefined as never);
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("draftId is required");
  });

  test("unknown draftId → 'draft not found' toolError", async () => {
    seedDesignSystem();
    const out = await _internals.tools["package-handoff"]!(
      { draftId: "d-nope" },
      undefined as never,
    );
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("draft not found");
  });

  test("design system missing → toolError", async () => {
    const slug = seedDesignSystem();
    const draftId = await generateDraft();
    // Delete the design-system.json so the handoff's DS read returns null.
    rmSync(join(dataRoot(), "projects", slug, "design-system.json"));
    const out = await _internals.tools["package-handoff"]!(
      { draftId },
      undefined as never,
    );
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("design system missing");
  });

  test("happy path: writes a bundle and lists its files (listBundleFilesRelative)", async () => {
    seedDesignSystem();
    const draftId = await generateDraft();
    const out = await _internals.tools["package-handoff"]!(
      { draftId, targetFramework: "react" },
      undefined as never,
    );
    expect(expectIsError(out)).toBe(false);
    const result = JSON.parse(expectText(out)) as { bundleDir: string; files: string[] };
    expect(typeof result.bundleDir).toBe("string");
    expect(Array.isArray(result.files)).toBe(true);
    expect(result.files.length).toBeGreaterThan(0);
    // Recursive walk returns sorted relative paths; the bundle dir holds
    // the written files on disk.
    expect(existsSync(result.bundleDir)).toBe(true);
    const sorted = [...result.files].sort();
    expect(result.files).toEqual(sorted);
  });
});

// ── list-drafts ────────────────────────────────────────────────────

describe("list-drafts", () => {
  test("returns [] when the drafts dir does not exist", async () => {
    // No project dir at all → drafts dir absent.
    const out = await _internals.tools["list-drafts"]!(
      { projectSlug: "never-created" },
      undefined as never,
    );
    expect(expectIsError(out)).toBe(false);
    expect(JSON.parse(expectText(out))).toEqual([]);
  });

  test("lists generated drafts newest-first, ignoring non-meta files", async () => {
    seedDesignSystem();
    await generateDraft();
    await new Promise((r) => setTimeout(r, 5));
    const second = await generateDraft();
    const out = await _internals.tools["list-drafts"]!({}, undefined as never);
    expect(expectIsError(out)).toBe(false);
    const drafts = JSON.parse(expectText(out)) as Array<{ draftId: string; prompt: string }>;
    expect(drafts.length).toBe(2);
    // Newest-first.
    expect(drafts[0]!.draftId).toBe(second);
    expect(drafts[0]!.prompt).toBe("Hero");
  });
});

// ── get-draft ──────────────────────────────────────────────────────

describe("get-draft", () => {
  test("missing draftId → toolError", async () => {
    const out = await _internals.tools["get-draft"]!({}, undefined as never);
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("draftId is required");
  });

  test("unknown draftId → 'draft not found' toolError", async () => {
    seedDesignSystem();
    const out = await _internals.tools["get-draft"]!(
      { draftId: "d-missing" },
      undefined as never,
    );
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("draft not found");
  });

  test("returns full html + meta for an existing draft", async () => {
    seedDesignSystem();
    const draftId = await generateDraft();
    const out = await _internals.tools["get-draft"]!(
      { draftId },
      undefined as never,
    );
    expect(expectIsError(out)).toBe(false);
    const parsed = JSON.parse(expectText(out)) as {
      draftId: string;
      html: string;
      fullSize: number;
    };
    expect(parsed.draftId).toBe(draftId);
    expect(parsed.html).toContain("design-tokens");
    expect(parsed.html).not.toContain("TRUNCATED");
    expect(parsed.fullSize).toBe(parsed.html.length);
  });

  test("truncates html when it exceeds maxChars", async () => {
    seedDesignSystem();
    const draftId = await generateDraft();
    const out = await _internals.tools["get-draft"]!(
      { draftId, maxChars: 32 },
      undefined as never,
    );
    const parsed = JSON.parse(expectText(out)) as { html: string; fullSize: number };
    expect(parsed.html).toContain("TRUNCATED");
    // fullSize reflects the untruncated length.
    expect(parsed.fullSize).toBeGreaterThan(32);
  });
});

// ── tweak-design error branch ──────────────────────────────────────

describe("tweak-design — error branches", () => {
  test("missing draftId → toolError", async () => {
    const out = await _internals.tweakDesign({}, undefined as never);
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("draftId is required");
  });

  test("unknown draftId → toolError surfacing the thrown message", async () => {
    seedDesignSystem();
    const out = await _internals.tweakDesign(
      { draftId: "d-absent", knobs: {} },
      undefined as never,
    );
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("draft not found");
  });
});

// ── generate-design: descriptor validation + missing DS ────────────

describe("generate-design — descriptor validation branches", () => {
  test("empty prompt → toolError", async () => {
    const out = await _internals.generateDesign({ prompt: "   " });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("prompt is required");
  });

  test("knobs not an array → toolError", async () => {
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt: "modern hero page",
      bodyMarkup: FIXTURE_BODY,
      knobs: "not-an-array",
    });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("must be an array");
  });

  test("knob descriptor not an object → toolError", async () => {
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt: "modern hero page",
      bodyMarkup: FIXTURE_BODY,
      knobs: ["nope"],
    });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("must be an object");
  });

  test("knob descriptor missing key → toolError", async () => {
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt: "modern hero page",
      bodyMarkup: FIXTURE_BODY,
      knobs: [{ label: "X", kind: "color" }],
    });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("`key`");
  });

  test("knob descriptor missing label → toolError", async () => {
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt: "modern hero page",
      bodyMarkup: FIXTURE_BODY,
      knobs: [{ key: "x", kind: "color" }],
    });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("`label`");
  });

  test("knob descriptor bad kind → toolError", async () => {
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt: "modern hero page",
      bodyMarkup: FIXTURE_BODY,
      knobs: [{ key: "x", label: "X", kind: "wibble" }],
    });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("kind");
  });

  test("select knob descriptor without options → toolError", async () => {
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt: "modern hero page",
      bodyMarkup: FIXTURE_BODY,
      knobs: [{ key: "x", label: "X", kind: "select" }],
    });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("options[]");
  });

  test("select knob descriptor WITH options is accepted", async () => {
    seedDesignSystem();
    const out = await _internals.generateDesign({
      prompt: "modern hero page",
      bodyMarkup: FIXTURE_BODY,
      knobs: [
        {
          key: "density",
          label: "Density",
          kind: "select",
          options: ["compact", "cozy"],
          var: "--color-primary",
        },
      ],
    });
    expect(expectIsError(out)).toBe(false);
  });

  test("design system not extracted → toolError", async () => {
    // No design-system.json seeded; project dir is created lazily.
    const out = await _internals.generateDesign({
      prompt: "modern hero page",
      bodyMarkup: FIXTURE_BODY,
    });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("Design system not extracted");
  });
});

// ── clarify-brief: remaining validation branches ───────────────────

function makeCtx(toolCallId?: string, conversationId?: string) {
  const metadata: Record<string, unknown> = {};
  if (toolCallId !== undefined) metadata.toolCallId = toolCallId;
  if (conversationId !== undefined) metadata.conversationId = conversationId;
  return { invocationMetadata: metadata };
}

describe("clarify-brief — remaining validation branches", () => {
  test("non-object field → toolError", async () => {
    const out = await _internals.clarifyBrief(
      { fields: ["nope"] },
      makeCtx("tc", "conv"),
    );
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("must be an object");
  });

  test("field missing label → toolError", async () => {
    const out = await _internals.clarifyBrief(
      { fields: [{ key: "tone", kind: "text" }] },
      makeCtx("tc", "conv"),
    );
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("`label`");
  });

  test("missing tool-call context → toolError", async () => {
    const out = await _internals.clarifyBrief(
      { fields: [{ key: "tone", label: "Tone", kind: "text" }] },
      makeCtx(undefined, undefined),
    );
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toContain("missing tool-call context");
  });
});

// ── createCanvas event closures ────────────────────────────────────
//
// `index.ts` registers two canvas event handlers at module-import time
// via `createCanvas`, which calls `getChannel().onRequest(...)` on the
// channel singleton. Those closures (`knob-change` / `brief-answer`)
// are the lines under test.
//
// `index.ts` calls `createCanvas` at module-evaluation time, registering
// both handlers on the channel singleton via `getChannel().onRequest`.
// The global preload's `afterEach` drops that singleton between tests,
// so each test gets a fresh channel WITHOUT those registrations.
//
// We capture the two real handler closures once — at this module's
// evaluation, right after `import "./index"` ran its top-level
// `createCanvas` — then re-register them on the current singleton in
// `beforeEach`. The captured closures still reference the original
// module's `pendingBriefAnswers` map (the same one `_internals` exposes
// and our tests register gates in), so brief-answer routing stays
// coherent. Dispatching invokes the closure with a host-shaped frame —
// exactly what the channel's inbound `handleIncoming` does for
// `ezcorp/event/<ns>:<ev>`.

type CanvasHandler = (params: unknown) => Promise<unknown> | unknown;
const KNOB_CHANGE_METHOD = "ezcorp/event/claude-design:knob-change";
const BRIEF_ANSWER_METHOD = "ezcorp/event/claude-design:brief-answer";

function readHandler(method: string): CanvasHandler | undefined {
  return (getChannel() as unknown as { handlers: Map<string, CanvasHandler> }).handlers.get(
    method,
  );
}

// Captured at module-evaluation time (before any afterEach reset when
// this file is the test entry — i.e. the isolated per-file run the
// coverage gate uses).
const capturedKnobChange = readHandler(KNOB_CHANGE_METHOD);
const capturedBriefAnswer = readHandler(BRIEF_ANSWER_METHOD);

/** Re-register the captured canvas closures on the current singleton. */
function reregisterCanvasHandlers(): void {
  const ch = getChannel();
  if (capturedKnobChange) ch.onRequest(KNOB_CHANGE_METHOD, capturedKnobChange);
  if (capturedBriefAnswer) ch.onRequest(BRIEF_ANSWER_METHOD, capturedBriefAnswer);
}

/** Invoke the registered canvas closure with a host-shaped event frame. */
async function dispatchCanvasEvent(
  event: "knob-change" | "brief-answer",
  payload: Record<string, unknown>,
): Promise<void> {
  const method = event === "knob-change" ? KNOB_CHANGE_METHOD : BRIEF_ANSWER_METHOD;
  const handler = readHandler(method);
  if (!handler) {
    throw new Error(
      `canvas handler ${method} unavailable — capture happened after a ` +
        `singleton reset (only occurs when a sibling test file imports ` +
        `index.ts first in a shared process; the coverage gate runs each ` +
        `file in its own process, so this does not affect the gate)`,
    );
  }
  await handler(payload);
}

describe("createCanvas knob-change handler", () => {
  test("missing draftId on payload → logs a structured failure line", async () => {
    seedDesignSystem();
    const captured: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (c) => {
      captured.push(typeof c === "string" ? c : String(c));
      return true;
    };
    try {
      await dispatchCanvasEvent("knob-change", {
        toolCallId: "tc",
        conversationId: "conv",
        knobs: {},
      });
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
    const all = captured.join("");
    expect(all).toContain("missing draftId on payload");
    expect(all).toContain("knob-change");
  });

  test("happy path: applies the knob to the draft", async () => {
    const slug = seedDesignSystem();
    const draftId = await generateDraft([
      { key: "primaryColor", label: "Primary", kind: "color", var: "--color-primary" },
    ]);
    await dispatchCanvasEvent("knob-change", {
      toolCallId: "tc",
      conversationId: "conv",
      draftId,
      knobs: { primaryColor: "#ff0066" },
    });
    // A revision file was written.
    const revs = listDraftFiles(slug).filter(
      (f) => f.startsWith(draftId + "__r") && f.endsWith(".html"),
    );
    expect(revs.length).toBeGreaterThan(0);
  });

  test("apply failure on missing draft → logs the error line", async () => {
    seedDesignSystem();
    const captured: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (c) => {
      captured.push(typeof c === "string" ? c : String(c));
      return true;
    };
    try {
      await dispatchCanvasEvent("knob-change", {
        toolCallId: "tc",
        conversationId: "conv",
        draftId: "d-does-not-exist",
        knobs: { primaryColor: "#000" },
      });
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
    const all = captured.join("");
    expect(all).toContain("knob-change");
    expect(all).toContain("draft not found");
  });
});

describe("createCanvas brief-answer handler", () => {
  test("routes the event into handleBriefAnswer and resolves the gate", async () => {
    const invocation = _internals.clarifyBrief(
      { fields: [{ key: "tone", label: "Tone", kind: "text" }] },
      makeCtx("tc-canvas", "conv-canvas"),
    );
    for (let i = 0; i < 20 && !_internals.pendingBriefAnswers.has("tc-canvas"); i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    await dispatchCanvasEvent("brief-answer", {
      toolCallId: "tc-canvas",
      conversationId: "conv-canvas",
      answer: "modern",
    });
    const out = await invocation;
    expect(expectIsError(out)).toBe(false);
    expect(expectText(out)).toBe("modern");
  });
});

// ── Defensive fsList catch arms ────────────────────────────────────
//
// Both `listRevisionsForDraft` and `listBundleFilesRelative` guard their
// `fsList` calls with a try/catch that degrades to "no entries" when the
// directory vanishes mid-flight (a real TOCTOU between the `exists` check
// `locateDraft` does and the subsequent `list`). Drive those arms by
// making the stub throw on `fs.list` for the specific dir.

describe("listRevisionsForDraft — degrades to original-only when drafts dir list throws", () => {
  test("fsList(draftsDir) throwing → revisions contains just the original entry", async () => {
    const slug = seedDesignSystem();
    // locateDraft relies on fs.exists for the html/meta paths, so the
    // draft still resolves; only the subsequent fs.list of `…/drafts`
    // throws — exercising the catch on index.ts:691.
    const knobs: KnobDescriptor[] = [
      { key: "primaryColor", label: "Primary", kind: "color", var: "--color-primary" },
    ];
    const draftId = await generateDraft(knobs);
    // Make a revision exist on disk so a working list would return >1.
    await _internals.applyKnobsToDraft(draftId, { primaryColor: "#ff0000" });
    // Now poison fs.list for the drafts dir and re-run list-revisions.
    installFsStubWithListThrow((path) => path.endsWith(`/${slug}/drafts`));
    const out = await _internals.listRevisions({ draftId }, undefined as never);
    expect(expectIsError(out)).toBe(false);
    const revs = JSON.parse(expectText(out)) as Array<{ isOriginal: boolean }>;
    // Only the original head survives — the revision walk swallowed the
    // throw and returned [].
    expect(revs.length).toBe(1);
    expect(revs[0]!.isOriginal).toBe(true);
  });
});

describe("globAsync — skips a subdir whose list throws mid-walk", () => {
  test("extract-design-system tolerates an unlistable subdirectory", async () => {
    // Greenfield root with a top-level css (so extraction proceeds) plus
    // a subdirectory the walker descends into. Poison fs.list for that
    // subdir so globAsync's inner walk hits its catch (index.ts:922) and
    // continues instead of crashing the whole extraction.
    writeFileSync(join(tmpRoot, "top.css"), ":root{ --x: 1px; }");
    mkdirSync(join(tmpRoot, "weird"), { recursive: true });
    writeFileSync(join(tmpRoot, "weird", "buried.css"), ":root{ --y: 2px; }");
    installFsStubWithListThrow((path) => path.endsWith("/weird"));
    const out = await _internals.tools["extract-design-system"]!({}, undefined as never);
    expect(expectIsError(out)).toBe(false);
    const ds = JSON.parse(expectText(out)) as DesignSystem;
    // Extraction still returns a valid design system despite the throw.
    expect(ds.schemaVersion).toBe(1);
  });
});

describe("listBundleFilesRelative — degrades to [] when bundle dir list throws", () => {
  test("fsList(bundleDir) throwing → handoff still succeeds with empty files", async () => {
    seedDesignSystem();
    const draftId = await generateDraft();
    // The handoff writes the bundle via fsWrite/fsMkdir (unaffected), but
    // the post-write recursive walk's fsList throws for the handoffs dir
    // — exercising the catch on index.ts:877.
    installFsStubWithListThrow((path) => path.includes("/handoffs/"));
    const out = await _internals.tools["package-handoff"]!(
      { draftId, targetFramework: "html" },
      undefined as never,
    );
    expect(expectIsError(out)).toBe(false);
    const result = JSON.parse(expectText(out)) as { bundleDir: string; files: string[] };
    expect(Array.isArray(result.files)).toBe(true);
    expect(result.files).toEqual([]);
  });
});
