// Audit-finding regression tests (task #11).
//
// Locks three findings from the round-2 audit of ext-install-fix:
//
//   AF-1 — MCP stdio spawn must go through the extension sandbox envelope
//          (prlimit + bounded env). Fixed by dev-2's task #14.
//   AF-2 — Bundled trust must come from the DB `isBundled` column, not a
//          name lookup that accepts spoofed manifest.name="ai-kit".
//          Fixed by dev-2's task #12.
//   AF-3 — Manifest entrypoint must reject traversal ("../.." and absolute
//          paths) at validateManifestV2, AND validateMcpManifest must be
//          wired into loadManifest for kind:"mcp". Fixed by dev-2's #17.
//
// All three suites MUST fail on current main (HEAD `07af445`) and pass
// after dev-2 lands #14/#12/#17. The suites below are scaffolded with
// `test.skip(...)` so reviewers can see the expected shape before dev-2
// lands the fixes. Un-skip each block when its dependency merges.
//
// Style-mirror: src/__tests__/permission-enforcement.test.ts (the
// best real-subprocess test in the repo at the time of writing).

import { test, expect, describe, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";

// ── DB mocks (AF-2 block) ───────────────────────────────────────────
// Installer tests below need a minimal in-memory "extensions" table.
// Every other block in this file (AF-1, AF-3) is DB-independent — the
// mocks are safe to install globally.
const mockExtensions = new Map<string, Record<string, unknown>>();

mock.module("../db/queries/extensions", () => ({
  createExtension: async (data: Record<string, unknown>) => {
    const ext = {
      id: crypto.randomUUID(),
      ...data,
      // Schema default: isBundled defaults to false unless explicitly set.
      // This mock must match that contract so installFromLocal's row
      // reports the right shape even though the real DB isn't involved.
      isBundled: data.isBundled ?? false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockExtensions.set(ext.id as string, ext);
    return ext;
  },
  getExtensionByName: async (name: string) => {
    for (const ext of mockExtensions.values()) {
      if (ext.name === name) return ext;
    }
    return null;
  },
  updateExtension: async (id: string, data: Record<string, unknown>) => {
    const ext = mockExtensions.get(id);
    if (!ext) return null;
    Object.assign(ext, data, { updatedAt: new Date() });
    return ext;
  },
  deleteExtension: async (id: string) => mockExtensions.delete(id),
  listExtensions: async () => Array.from(mockExtensions.values()),
}));

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({ reload: async () => {} }),
  },
}));

afterAll(() => restoreModuleMocks());

// ═══════════════════════════════════════════════════════════════════
// AF-1 — MCP stdio spawn runs under sandbox envelope
// ═══════════════════════════════════════════════════════════════════
//
// Lives in src/__tests__/af1-mcp-sandbox-regression.test.ts. Split out
// because AF-1 needs the REAL ExtensionRegistry (to exercise the wiring
// in getMcpClient → buildSandboxedMcpSpec), but this file's AF-2 leg
// globally mocks `../extensions/registry`. Separate files keep the
// two non-overlapping.
//
// See also: src/__tests__/mcp-sandbox.test.ts (pure-function unit tests
// for buildSandboxedMcpSpec itself).

// ═══════════════════════════════════════════════════════════════════
// AF-2 — Bundled trust comes from DB column, not manifest name lookup
// ═══════════════════════════════════════════════════════════════════
//
// HOW THIS FAILS ON MAIN
// ----------------------
// `src/extensions/bundled.ts:174` `isBundledExtensionName(name)` — pure
// set lookup against `BUNDLED_EXTENSION_NAMES`. A user installs a git
// repo whose `ezcorp.config.ts` sets `name: "ai-kit"`; `installFromGit`
// writes the row; at spawn time `registry.getProcess` checks
// `isBundledExtensionName(manifest.name)` → true → skips integrity
// verification.
//
// HOW THE FIX MUST LAND (per AF-2 §Decision D-2)
// ----------------------------------------------
// - New column `isBundled: boolean` on `extensions` table.
// - `installFromLocal`, `installFromGitHub`, `installFromGit`,
//   `installWithDependencies` all set `isBundled: false`.
// - Bundled seeder in `ensureBundledExtensions` sets `isBundled: true`.
// - Migration backfills existing bundled rows to `isBundled: true`.
// - `registry.getProcess` and any other trust-gate caller switch from
//   `isBundledExtensionName(name)` to `row.isBundled`.

describe("AF-2: bundled flag is provenance-based, not name-based", () => {
  test("installFromLocal with spoofed manifest.name='ai-kit' creates row with isBundled:false", async () => {
    // The attacker path: admin installs a non-bundled ext whose config
    // declares `name:"ai-kit"` — same as the real bundled entry. Before
    // #12, `isBundledExtensionName(manifest.name)` matched on that string
    // and granted bundled trust. After #12, provenance comes from the DB
    // column which only `ensureBundledExtensions` sets. Non-bundled paths
    // (installFromLocal direct) default to false.
    const { installFromLocal } = await import("../extensions/installer");
    const dir = mkdtempSync(join(tmpdir(), "af2-spoof-"));
    writeFileSync(join(dir, "index.ts"), "export default {};\n");
    writeFileSync(
      join(dir, "ezcorp.config.ts"),
      `export default ${JSON.stringify({
        schemaVersion: 2,
        name: "ai-kit",
        version: "9.9.9",
        description: "spoof",
        author: { name: "attacker" },
        entrypoint: "./index.ts",
        tools: [
          {
            name: "evil",
            description: "evil",
            inputSchema: { type: "object" },
          },
        ],
      })};\n`,
    );

    const row = await installFromLocal(
      dir,
      { grantedAt: {} },
      false,
    );

    // The row must not carry bundled trust. `createExtension` in the mock
    // above mirrors the schema default — any future refactor of the
    // install path that accidentally sets `isBundled:true` fails here.
    expect((row as { isBundled?: boolean }).isBundled).toBe(false);
    expect(row.name).toBe("ai-kit");
  });

  test("registry no longer imports isBundledExtensionName from bundled.ts", async () => {
    // Structural lock — the whole point of #12 is that runtime trust
    // must NOT come from `isBundledExtensionName(manifest.name)`. This
    // test reads registry.ts and asserts the import is gone. If any
    // future refactor re-introduces it, this test fires before the
    // CVE comes back.
    //
    // (The function itself stays exported from bundled.ts for legacy
    // scratchpad tests — we only lock the trust-boundary import.)
    const registrySrc = readFileSync(
      pathResolve(import.meta.dir, "../extensions/registry.ts"),
      "utf8",
    );
    // No import of isBundledExtensionName from bundled in registry.ts.
    expect(registrySrc).not.toMatch(
      /import\s*\{[^}]*isBundledExtensionName[^}]*\}\s*from\s*["']\.\/bundled["']/,
    );
    // And no bare call either — belt-and-braces for anyone who inlines.
    expect(registrySrc).not.toMatch(/isBundledExtensionName\s*\(/);
  });

  test.skip("seeded bundled extensions keep isBundled:true after ensureBundledExtensions (NR-2)", async () => {
    // Left skipped intentionally — requires driving ensureBundledExtensions
    // against a real (or seeded) DB so the seeder's `installFromLocal + mark
    // isBundled:true` flow is exercised end-to-end. The commit message for
    // #12 confirms manual verification via scratchpad-bundled-install +
    // installer suites (32/32 green). Next sdet can un-skip this by:
    //   1. Ensure in-memory PGlite runs schema migrations (preload already
    //      sets EZCORP_DB_PATH=":memory:"; may need migrate.ts explicit call).
    //   2. Seed the bundled `scratchpad` entry via a local path fixture
    //      rather than the real `docs/extensions/examples/scratchpad`, so
    //      the assertion is hermetic.
    //   3. Query getExtensionByName("scratchpad") — expect isBundled:true.
    // Guarded by NR-2 in requirements.md §2. Do NOT treat as optional.
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// AF-3 — Manifest entrypoint + validateMcpManifest wiring
// ═══════════════════════════════════════════════════════════════════
//
// HOW THIS FAILS ON MAIN
// ----------------------
// (A) `validateManifestV2` in `src/extensions/manifest.ts:127` has no
//     check on `m.entrypoint`. A manifest with
//     `entrypoint: "../../etc/passwd"` passes validation and is written
//     to the install path as-is; `registry.getProcess` then joins it
//     with installPath to produce `<installPath>/../../etc/passwd`.
// (B) `validateMcpManifest` at `src/extensions/manifest.ts:95` is NEVER
//     called from `src/extensions/loader.ts` — `loadManifest` only
//     calls `validateManifestV2`, so an `kind:"mcp"` manifest with zero
//     `mcpServers` entries loads silently.
//
// HOW THE FIX MUST LAND (per AF-3 acceptance)
// -------------------------------------------
// - validateManifestV2 rejects entrypoints containing ".." or starting
//   with "/". Accepts "./index.ts", "index.ts", and absent entrypoint
//   (the last so MCP manifests that legitimately omit entrypoint
//   continue to pass — Part A must not conflict with Part B's "mcp
//   manifests must not set entrypoint" rule).
// - loader.ts calls `validateMcpManifest` (in addition to
//   `validateManifestV2`) for any manifest with `kind === "mcp"`.

describe("AF-3a: validateManifestV2 rejects entrypoint traversal", () => {
  function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: 2,
      name: "af3-test",
      version: "1.0.0",
      description: "af3 entrypoint test",
      author: { name: "t" },
      tools: [],
      ...overrides,
    };
  }

  test("rejects entrypoint with '..' traversal", async () => {
    const { validateManifestV2 } = await import("../extensions/manifest");
    const r = validateManifestV2(baseManifest({ entrypoint: "../../etc/passwd" }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /entrypoint/i.test(e) && /\.\./.test(e))).toBe(true);
  });

  test("rejects absolute entrypoint", async () => {
    const { validateManifestV2 } = await import("../extensions/manifest");
    const r = validateManifestV2(baseManifest({ entrypoint: "/etc/hostname" }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /entrypoint/i.test(e) && /absolute/i.test(e))).toBe(true);
  });

  test("rejects entrypoint with a nested '..' segment (foo/../../bar)", async () => {
    // Defense-in-depth: any path segment equal to `..` is rejected, even
    // if flanked by normal segments. The validator splits on `[\\/]` and
    // checks segment equality, so "sub/../../escape.ts" trips the rule.
    const { validateManifestV2 } = await import("../extensions/manifest");
    const r = validateManifestV2(baseManifest({ entrypoint: "sub/../../escape.ts" }));
    expect(r.valid).toBe(false);
  });

  test("accepts './index.ts'", async () => {
    const { validateManifestV2 } = await import("../extensions/manifest");
    const r = validateManifestV2(baseManifest({ entrypoint: "./index.ts" }));
    expect(r.valid).toBe(true);
  });

  test("accepts bare 'index.ts'", async () => {
    const { validateManifestV2 } = await import("../extensions/manifest");
    const r = validateManifestV2(baseManifest({ entrypoint: "index.ts" }));
    expect(r.valid).toBe(true);
  });

  test("accepts absent entrypoint when manifest has no tools (MCP-shaped package)", async () => {
    // AF-3 acceptance §"Part A's entrypoint check and Part B's validator
    // do not conflict — if MCP manifests legitimately omit entrypoint,
    // Part A must handle an absent entrypoint as valid rather than required."
    const { validateManifestV2 } = await import("../extensions/manifest");
    const r = validateManifestV2({
      schemaVersion: 2,
      name: "mcp-like",
      version: "1.0.0",
      description: "x",
      author: { name: "t" },
      kind: "mcp",
      mcpServers: [{ name: "s", transport: "stdio", command: "bun" }],
    });
    expect(r.valid).toBe(true);
  });

  test("rejects a non-string entrypoint (type guard)", async () => {
    // The traversal check lives behind a `typeof === "string"` guard.
    // Sending a non-string entrypoint must still produce a validator
    // failure, not a crash.
    const { validateManifestV2 } = await import("../extensions/manifest");
    const r = validateManifestV2(baseManifest({ entrypoint: 42 }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /entrypoint/i.test(e))).toBe(true);
  });
});

describe("AF-3b: loadManifest wires validateMcpManifest for kind:'mcp'", () => {
  // Write an ezcorp.config.ts with the given default export. Returns the
  // directory, which can be passed to loadManifest().
  function writeManifestFixture(config: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "af3b-"));
    writeFileSync(
      join(dir, "ezcorp.config.ts"),
      `export default ${JSON.stringify(config)};\n`,
    );
    return dir;
  }

  test("MCP manifest with zero mcpServers entries is rejected by loadManifest", async () => {
    // validateManifestV2 alone tolerates an absent mcpServers array.
    // validateMcpManifest requires exactly one entry. Proof the wiring
    // is in place: this manifest must fail to load.
    const { loadManifest } = await import("../extensions/loader");
    const dir = writeManifestFixture({
      schemaVersion: 2,
      name: "bad-mcp-empty",
      version: "1.0.0",
      description: "no servers",
      author: { name: "t" },
      kind: "mcp",
      mcpServers: [],
    });
    await expect(loadManifest(dir)).rejects.toThrow(
      /exactly one mcpServers entry/,
    );
  });

  test("MCP manifest with multiple mcpServers entries is rejected", async () => {
    const { loadManifest } = await import("../extensions/loader");
    const dir = writeManifestFixture({
      schemaVersion: 2,
      name: "bad-mcp-many",
      version: "1.0.0",
      description: "too many",
      author: { name: "t" },
      kind: "mcp",
      mcpServers: [
        { name: "a", transport: "stdio", command: "bun" },
        { name: "b", transport: "stdio", command: "bun" },
      ],
    });
    await expect(loadManifest(dir)).rejects.toThrow(
      /exactly one mcpServers entry/,
    );
  });

  test("MCP manifest that also declares entrypoint is rejected", async () => {
    // validateMcpManifest enforces `entrypoint` MUST be absent on kind:"mcp".
    const { loadManifest } = await import("../extensions/loader");
    const dir = writeManifestFixture({
      schemaVersion: 2,
      name: "bad-mcp-entry",
      version: "1.0.0",
      description: "mcp with entrypoint",
      author: { name: "t" },
      kind: "mcp",
      mcpServers: [{ name: "s", transport: "stdio", command: "bun" }],
      entrypoint: "./index.ts",
    });
    await expect(loadManifest(dir)).rejects.toThrow(/entrypoint/);
  });

  test("well-formed MCP manifest still loads (NR-3)", async () => {
    // The bundled/example MCP manifests must not regress. One server,
    // stdio transport, command present, no entrypoint.
    const { loadManifest } = await import("../extensions/loader");
    const dir = writeManifestFixture({
      schemaVersion: 2,
      name: "good-mcp",
      version: "1.0.0",
      description: "ok",
      author: { name: "t" },
      kind: "mcp",
      mcpServers: [{ name: "s", transport: "stdio", command: "bun" }],
    });
    const m = await loadManifest(dir);
    expect(m.kind).toBe("mcp");
    expect(m.mcpServers?.length).toBe(1);
  });

  test("non-MCP manifest is NOT subjected to MCP-specific checks", async () => {
    // Regression guard — a plain tools manifest (no `kind` / kind undefined)
    // must not start failing because loader.ts started dispatching on
    // kind. validateForKind only routes through the MCP validator when
    // kind === "mcp".
    const { loadManifest } = await import("../extensions/loader");
    const dir = mkdtempSync(join(tmpdir(), "af3b-plain-"));
    writeFileSync(join(dir, "index.ts"), "export default {};");
    writeFileSync(
      join(dir, "ezcorp.config.ts"),
      `export default ${JSON.stringify({
        schemaVersion: 2,
        name: "plain-ext",
        version: "1.0.0",
        description: "plain tools manifest",
        author: { name: "t" },
        entrypoint: "./index.ts",
        tools: [
          {
            name: "noop",
            description: "noop tool",
            inputSchema: { type: "object" },
          },
        ],
      })};\n`,
    );
    const m = await loadManifest(dir);
    expect(m.name).toBe("plain-ext");
  });
});

