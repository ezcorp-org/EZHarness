// Tests for lib/handoff.ts — bundle writer.
//
// Locks down the contract documented in knowledge/handoff-format-spec.md:
//   - All required files appear in the bundle.
//   - IMPLEMENT.md has the four required sections (Overview/Tokens/
//     Components/Pages).
//   - tokens.css is extracted from the DRAFT (post-tweaks), not the
//     design-system.json snapshot. [C1 from the Phase B review]
//   - Starter files for each target framework import tokens.css.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getChannel, JsonRpcError } from "@ezcorp/sdk/runtime";

import type { DesignSystem, DraftMeta } from "./types";
import { writeHandoffBundle } from "./handoff";

// ── In-test fs RPC stub ─────────────────────────────────────────────
//
// `writeHandoffBundle` routes IO through `@ezcorp/sdk/runtime`'s
// `fsMkdir` + `fsWrite` (Phase 3 host-mediated reverse-RPC). Bun unit
// tests run in-process with no host, so we stub `getChannel().request`
// for `mkdir` + `write` and route to real disk IO under the tmp dir.

const ORIG_FS_ALLOWED = process.env.EZCORP_FS_ALLOWED;

function installFsStub(): void {
  const ch = getChannel();
  spyOn(ch, "request").mockImplementation((async (
    method: string,
    params: unknown,
  ): Promise<unknown> => {
    const p = (params ?? {}) as Record<string, unknown>;
    const path = p.path as string;
    if (method === "ezcorp/fs.mkdir") {
      mkdirSync(path, { recursive: p.recursive === true });
      return { resolvedPath: path };
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
    throw new JsonRpcError(-32601, `handoff test stub: unexpected RPC method ${method}`);
  }) as ReturnType<typeof getChannel>["request"]);
}

const TEST_DRAFT_HTML = `<!doctype html>
<html><head>
<style id="design-tokens">
:root {
  --color-primary: #ff0066;
  --color-secondary: #0066ff;
  --space-unit: 12px;
  --space-1: 12px;
  --font-display: "Söhne Breit";
  --font-body: "Söhne";
}
</style>
</head><body>tweaked content</body></html>`;

const TEST_DESIGN_SYSTEM: DesignSystem = {
  schemaVersion: 1,
  colors: {
    // INTENTIONALLY different from the draft's tokens — proves
    // tokens.css reflects the draft, not the snapshot.
    primary: "#999999",
    secondary: "#666666",
    neutral: ["#0a0a0a", "#fafafa"],
  },
  typography: {
    display: "Inter",
    body: "Inter",
    scale: [12, 16, 24, 48],
  },
  spacing: {
    unit: 8, // also different from draft (12)
    scale: [4, 8, 16, 32],
  },
  components: [{ name: "Button", path: "src/Button.svelte" }],
  source: "tailwind",
};

const TEST_META: DraftMeta = {
  schemaVersion: 1,
  draftId: "d-abc__rxyz",
  parentDraftId: "d-abc",
  prompt: "A dashboard for the executor",
  kind: "page",
  knobs: { primaryColor: "#ff0066", spacingScale: "+50%" },
  createdAt: "2026-04-26T20:00:00.000Z",
};

let tmpRoot: string;

beforeAll(() => {
  process.env.EZCORP_FS_ALLOWED = "1";
  tmpRoot = mkdtempSync(join(tmpdir(), "claude-design-handoff-test-"));
  installFsStub();
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
  if (ORIG_FS_ALLOWED === undefined) delete process.env.EZCORP_FS_ALLOWED;
  else process.env.EZCORP_FS_ALLOWED = ORIG_FS_ALLOWED;
});

async function bundleAt(subdir: string, framework: "react" | "svelte" | "vue" | "html"): Promise<string> {
  // Re-install stub — the global preload's afterEach drops the channel
  // singleton between tests.
  installFsStub();
  const dir = join(tmpRoot, subdir);
  await writeHandoffBundle({
    bundleDir: dir,
    draftHtml: TEST_DRAFT_HTML,
    draftMeta: TEST_META,
    designSystem: TEST_DESIGN_SYSTEM,
    targetFramework: framework,
  });
  return dir;
}

// ── Bundle completeness ────────────────────────────────────────────

describe("writeHandoffBundle — file inventory", () => {
  test("creates every spec'd file", async () => {
    const dir = await bundleAt("inventory", "react");
    for (const path of [
      "README.md",
      "IMPLEMENT.md",
      "design.html",
      "design-system.json",
      "tokens.css",
      "knob-trail.json",
      "starter/DesignDraft.tsx",
      "agents/claude-design-implement.md",
    ]) {
      expect(existsSync(join(dir, path))).toBe(true);
    }
  });

  test("design.html is byte-identical to input", async () => {
    const dir = await bundleAt("byte", "html");
    const content = readFileSync(join(dir, "design.html"), "utf-8");
    expect(content).toBe(TEST_DRAFT_HTML);
  });

  test("design-system.json is the snapshot, not the draft tokens", async () => {
    const dir = await bundleAt("snapshot", "react");
    const content = JSON.parse(readFileSync(join(dir, "design-system.json"), "utf-8"));
    expect(content.colors.primary).toBe("#999999"); // from snapshot, not "#ff0066"
    expect(content.spacing.unit).toBe(8);
  });
});

// ── tokens.css C1 fix ──────────────────────────────────────────────

describe("writeHandoffBundle — tokens.css drift fix [C1]", () => {
  test("tokens.css reflects the DRAFT's token values, not the snapshot", async () => {
    const dir = await bundleAt("c1", "react");
    const css = readFileSync(join(dir, "tokens.css"), "utf-8");
    // Draft: primary=#ff0066, secondary=#0066ff, --space-unit=12px
    expect(css).toContain("--color-primary: #ff0066;");
    expect(css).toContain("--color-secondary: #0066ff;");
    expect(css).toContain("--space-unit: 12px;");
    // Snapshot values must NOT leak through.
    expect(css).not.toContain("#999999");
    expect(css).not.toContain("#666666");
  });

  test("tokens.css starts with :root and is balanced", async () => {
    const dir = await bundleAt("balanced", "react");
    const css = readFileSync(join(dir, "tokens.css"), "utf-8");
    expect(css.trim().startsWith(":root {")).toBe(true);
    expect(css.trim().endsWith("}")).toBe(true);
  });

  test("throws when draft HTML has no token block", async () => {
    installFsStub();
    const dir = join(tmpRoot, "no-block");
    await expect(
      writeHandoffBundle({
        bundleDir: dir,
        draftHtml: "<html><body>nothing</body></html>",
        draftMeta: TEST_META,
        designSystem: TEST_DESIGN_SYSTEM,
        targetFramework: "react",
      }),
    ).rejects.toThrow(/missing/);
  });
});

// ── IMPLEMENT.md contract ──────────────────────────────────────────

describe("writeHandoffBundle — IMPLEMENT.md contract", () => {
  test("contains the four required sections", async () => {
    const dir = await bundleAt("sections", "react");
    const md = readFileSync(join(dir, "IMPLEMENT.md"), "utf-8");
    expect(md).toMatch(/^##\s+Overview$/m);
    expect(md).toMatch(/^##\s+Tokens$/m);
    expect(md).toMatch(/^##\s+Components$/m);
    expect(md).toMatch(/^##\s+Pages$/m);
  });

  test("Components section lists catalogued components", async () => {
    const dir = await bundleAt("comp", "react");
    const md = readFileSync(join(dir, "IMPLEMENT.md"), "utf-8");
    expect(md).toContain("`Button`");
    expect(md).toContain("`src/Button.svelte`");
  });

  test("Tokens section embeds the JSON snapshot for grep-ability", async () => {
    const dir = await bundleAt("tokens-section", "react");
    const md = readFileSync(join(dir, "IMPLEMENT.md"), "utf-8");
    expect(md).toContain("```json");
    expect(md).toContain('"schemaVersion": 1');
  });
});

// ── Starter scaffolds per framework ────────────────────────────────

describe("writeHandoffBundle — starter scaffolds", () => {
  for (const fw of ["react", "svelte", "vue"] as const) {
    test(`${fw} starter imports tokens.css`, async () => {
      const dir = await bundleAt(`starter-${fw}`, fw);
      const ext = fw === "react" ? "tsx" : fw === "svelte" ? "svelte" : "vue";
      const content = readFileSync(join(dir, "starter", `DesignDraft.${ext}`), "utf-8");
      expect(content).toContain("tokens.css");
    });
  }

  test("html starter is the draft itself (not a stub)", async () => {
    const dir = await bundleAt("starter-html", "html");
    const content = readFileSync(join(dir, "starter", "design.html"), "utf-8");
    expect(content).toBe(TEST_DRAFT_HTML);
  });
});

// ── knob-trail.json contract ──────────────────────────────────────

describe("writeHandoffBundle — knob-trail.json", () => {
  test("captures single-hop knobs from parent", async () => {
    const dir = await bundleAt("trail", "react");
    const trail = JSON.parse(readFileSync(join(dir, "knob-trail.json"), "utf-8"));
    expect(trail.draftId).toBe("d-abc__rxyz");
    expect(trail.parentDraftId).toBe("d-abc");
    expect(trail.knobs).toEqual({ primaryColor: "#ff0066", spacingScale: "+50%" });
  });
});

// ── Slash-command stub ────────────────────────────────────────────

describe("writeHandoffBundle — agents stub", () => {
  test("ships a frontmatter'd slash-command stub", async () => {
    const dir = await bundleAt("agents", "react");
    const stub = readFileSync(join(dir, "agents", "claude-design-implement.md"), "utf-8");
    expect(stub).toContain("---");
    expect(stub).toContain("name: claude-design-implement");
    expect(stub).toContain("description:");
  });
});
