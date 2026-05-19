/**
 * Phase 5 — manifest-tamper detection matrix.
 *
 * Exercises `verifyManifestAgainstLock` and the lockfile loader against
 * a temp-directory rendered lockfile. Items (a)–(j) from the spec:
 *
 *   (a) tool-list / entrypoint / version match → ok:true
 *   (b) NEW tool not in lockfile → ok:false (toolsHash mismatch)
 *   (c) REMOVED tool → ok:false (toolsHash mismatch)
 *   (d) RENAMED tool → ok:false (toolsHash mismatch)
 *   (e) inputSchema modified → ok:false (toolsHash mismatch)
 *   (f) version drift → ok:false
 *   (g) entrypoint drift → ok:false
 *   (h) lockfile MISSING → fail-closed
 *   (i) lockfile MALFORMED → fail-closed
 *   (j) regenerate-script round-trip: edit a manifest, regenerate,
 *       re-verify → ok:true
 *
 * Plus an integration test that wires a temp manifest, computes its
 * hash, modifies a tool, asserts mismatch with the right reason, then
 * regenerates the lockfile and asserts the new lockfile validates.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionManifestV2, ToolDefinition } from "../extensions/types";

const {
  canonicalizeAndHash,
  loadManifestLock,
  verifyManifestAgainstLock,
  setLockfilePathOverride,
  clearLockfileCache,
} = await import("../extensions/bundled-lock");

const { migrateManifestV2ToV3 } = await import("../extensions/manifest");

const { buildLockfile, diffLockfiles } = await import(
  "../../scripts/regenerate-manifest-lock"
);

// ── shared temp dir for the lockfile under test ─────────────────────

let tempDir: string;
let lockfilePath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "manifest-tamper-test-"));
  lockfilePath = join(tempDir, "manifest.lock.json");
  setLockfilePathOverride(lockfilePath);
  clearLockfileCache();
});

afterEach(async () => {
  setLockfilePathOverride(undefined);
  clearLockfileCache();
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

// ── fixture helpers ────────────────────────────────────────────────

const TOOL_A: ToolDefinition = {
  name: "alpha",
  description: "alpha tool",
  inputSchema: {
    type: "object",
    properties: { x: { type: "string" } },
    required: ["x"],
  },
};

const TOOL_B: ToolDefinition = {
  name: "beta",
  description: "beta tool",
  inputSchema: {
    type: "object",
    properties: { y: { type: "number" } },
  },
};

function fixtureManifest(overrides: Partial<ExtensionManifestV2> = {}): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "fixture",
    version: "1.0.0",
    description: "fixture",
    author: { name: "EZCorp" },
    entrypoint: "./index.ts",
    tools: [TOOL_A, TOOL_B],
    permissions: {},
    ...overrides,
  };
}

async function writeLockfile(extensions: Record<string, {
  version: string;
  entrypoint: string;
  toolsHash: string;
}>) {
  const lockfile = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    extensions,
  };
  await Bun.write(lockfilePath, JSON.stringify(lockfile, null, 2));
}

// ── (a) match: ok:true ─────────────────────────────────────────────

describe("(a) manifest matches lockfile → ok:true", () => {
  test("version + entrypoint + toolsHash all match", async () => {
    const manifest = fixtureManifest();
    const toolsHash = canonicalizeAndHash(manifest.tools ?? []);
    await writeLockfile({
      fixture: { version: "1.0.0", entrypoint: "./index.ts", toolsHash },
    });
    const result = await verifyManifestAgainstLock("fixture", manifest);
    expect(result).toEqual({ ok: true });
  });
});

// ── (b) added tool ─────────────────────────────────────────────────

describe("(b) added tool → toolsHash mismatch", () => {
  test("manifest gains a new tool not present in lockfile", async () => {
    const baseline = fixtureManifest();
    const baselineHash = canonicalizeAndHash(baseline.tools ?? []);
    await writeLockfile({
      fixture: { version: "1.0.0", entrypoint: "./index.ts", toolsHash: baselineHash },
    });
    const tampered = fixtureManifest({
      tools: [...(baseline.tools ?? []), {
        name: "gamma",
        description: "added later",
        inputSchema: {},
      }],
    });
    const result = await verifyManifestAgainstLock("fixture", tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("tool-list drift");
      expect(result.expected).toBe(baselineHash);
      expect(result.actual).not.toBe(baselineHash);
    }
  });
});

// ── (c) removed tool ───────────────────────────────────────────────

describe("(c) removed tool → toolsHash mismatch", () => {
  test("manifest drops a tool present in lockfile", async () => {
    const baseline = fixtureManifest();
    const baselineHash = canonicalizeAndHash(baseline.tools ?? []);
    await writeLockfile({
      fixture: { version: "1.0.0", entrypoint: "./index.ts", toolsHash: baselineHash },
    });
    const tampered = fixtureManifest({ tools: [TOOL_A] });
    const result = await verifyManifestAgainstLock("fixture", tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("tool-list drift");
  });
});

// ── (d) renamed tool ───────────────────────────────────────────────

describe("(d) renamed tool → toolsHash mismatch", () => {
  test("alpha → alphabet flips the hash", async () => {
    const baseline = fixtureManifest();
    const baselineHash = canonicalizeAndHash(baseline.tools ?? []);
    await writeLockfile({
      fixture: { version: "1.0.0", entrypoint: "./index.ts", toolsHash: baselineHash },
    });
    const tampered = fixtureManifest({
      tools: [{ ...TOOL_A, name: "alphabet" }, TOOL_B],
    });
    const result = await verifyManifestAgainstLock("fixture", tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("tool-list drift");
  });
});

// ── (e) modified inputSchema ──────────────────────────────────────

describe("(e) modified inputSchema → toolsHash mismatch", () => {
  test("inputSchema gets a new required field", async () => {
    const baseline = fixtureManifest();
    const baselineHash = canonicalizeAndHash(baseline.tools ?? []);
    await writeLockfile({
      fixture: { version: "1.0.0", entrypoint: "./index.ts", toolsHash: baselineHash },
    });
    const tampered = fixtureManifest({
      tools: [
        {
          ...TOOL_A,
          inputSchema: {
            type: "object",
            properties: {
              x: { type: "string" },
              admin: { type: "boolean" },
            },
            required: ["x", "admin"],
          },
        },
        TOOL_B,
      ],
    });
    const result = await verifyManifestAgainstLock("fixture", tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("tool-list drift");
  });
});

// ── (e2) description-only changes also flip the hash by design ──
//
// The spec note in `phase-5-bundled-ceiling.md` allows description-only
// changes to NOT trigger re-approval at the discretion of the verifier.
// In our implementation we treat description as part of the canonical
// hash — so it DOES flip. This is conservative and the right default
// for a security gate. The maintainer regenerates the lockfile when they
// update a description.

describe("(e2) description change → toolsHash mismatch (conservative default)", () => {
  test("changing only the description flips the hash", async () => {
    const baseline = fixtureManifest();
    const baselineHash = canonicalizeAndHash(baseline.tools ?? []);
    await writeLockfile({
      fixture: { version: "1.0.0", entrypoint: "./index.ts", toolsHash: baselineHash },
    });
    const tampered = fixtureManifest({
      tools: [{ ...TOOL_A, description: "alpha tool (rev2)" }, TOOL_B],
    });
    const result = await verifyManifestAgainstLock("fixture", tampered);
    expect(result.ok).toBe(false);
  });
});

// ── (f) version drift ───────────────────────────────────────────

describe("(f) version drift → ok:false", () => {
  test("manifest version doesn't match lockfile entry", async () => {
    const manifest = fixtureManifest({ version: "2.0.0" });
    const toolsHash = canonicalizeAndHash(manifest.tools ?? []);
    await writeLockfile({
      fixture: { version: "1.0.0", entrypoint: "./index.ts", toolsHash },
    });
    const result = await verifyManifestAgainstLock("fixture", manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("version drift");
      expect(result.expected).toBe("1.0.0");
      expect(result.actual).toBe("2.0.0");
    }
  });
});

// ── (g) entrypoint drift ───────────────────────────────────────

describe("(g) entrypoint drift → ok:false", () => {
  test("manifest entrypoint doesn't match lockfile entry", async () => {
    const manifest = fixtureManifest({ entrypoint: "./alt.ts" });
    const toolsHash = canonicalizeAndHash(manifest.tools ?? []);
    await writeLockfile({
      fixture: { version: "1.0.0", entrypoint: "./index.ts", toolsHash },
    });
    const result = await verifyManifestAgainstLock("fixture", manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("entrypoint drift");
      expect(result.expected).toBe("./index.ts");
      expect(result.actual).toBe("./alt.ts");
    }
  });

  test("missing entrypoint vs lockfile-recorded entrypoint → drift", async () => {
    const manifest = fixtureManifest();
    delete manifest.entrypoint;
    await writeLockfile({
      fixture: {
        version: "1.0.0",
        entrypoint: "./index.ts",
        toolsHash: canonicalizeAndHash(manifest.tools ?? []),
      },
    });
    const result = await verifyManifestAgainstLock("fixture", manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("entrypoint drift");
  });
});

// ── (h) lockfile MISSING ─────────────────────────────────────────

describe("(h) lockfile missing → fail-closed", () => {
  test("loadManifestLock returns null when the file does not exist", async () => {
    // Don't write the lockfile — the override path points at a
    // non-existent file inside tempDir.
    const lock = await loadManifestLock();
    expect(lock).toBeNull();
  });

  test("verify returns ok:false with a fail-closed reason", async () => {
    const result = await verifyManifestAgainstLock("anything", fixtureManifest());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("missing");
  });
});

// ── (i) lockfile MALFORMED ──────────────────────────────────────

describe("(i) lockfile malformed → fail-closed", () => {
  test("non-JSON content treats lockfile as missing", async () => {
    await Bun.write(lockfilePath, "this is not JSON");
    clearLockfileCache();
    const lock = await loadManifestLock();
    expect(lock).toBeNull();
  });

  test("wrong schemaVersion fails the validity check", async () => {
    await Bun.write(
      lockfilePath,
      JSON.stringify({ schemaVersion: 99, generatedAt: "now", extensions: {} }),
    );
    clearLockfileCache();
    const lock = await loadManifestLock();
    expect(lock).toBeNull();
  });

  test("missing extensions field fails the validity check", async () => {
    await Bun.write(
      lockfilePath,
      JSON.stringify({ schemaVersion: 1, generatedAt: "now" }),
    );
    clearLockfileCache();
    const lock = await loadManifestLock();
    expect(lock).toBeNull();
  });

  test("entry missing toolsHash fails the validity check", async () => {
    await Bun.write(
      lockfilePath,
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: "now",
        extensions: {
          fixture: { version: "1.0.0", entrypoint: "./index.ts" },
        },
      }),
    );
    clearLockfileCache();
    const lock = await loadManifestLock();
    expect(lock).toBeNull();
  });
});

// ── canonical-JSON hash determinism ─────────────────────────────

describe("canonicalizeAndHash determinism", () => {
  test("array-order-shuffled tools hash identically", () => {
    const a = canonicalizeAndHash([TOOL_A, TOOL_B]);
    const b = canonicalizeAndHash([TOOL_B, TOOL_A]);
    expect(a).toBe(b);
  });

  test("key-order-shuffled inputSchema hashes identically", () => {
    const t1: ToolDefinition = {
      name: "x",
      description: "x",
      inputSchema: { type: "object", properties: { a: { type: "string" } } },
    };
    const t2: ToolDefinition = {
      name: "x",
      description: "x",
      inputSchema: { properties: { a: { type: "string" } }, type: "object" },
    };
    expect(canonicalizeAndHash([t1])).toBe(canonicalizeAndHash([t2]));
  });

  test("a single byte change in inputSchema flips the hash", () => {
    const t1: ToolDefinition = {
      name: "x",
      description: "x",
      inputSchema: { properties: { a: { type: "string" } } },
    };
    const t2: ToolDefinition = {
      name: "x",
      description: "x",
      inputSchema: { properties: { a: { type: "number" } } },
    };
    expect(canonicalizeAndHash([t1])).not.toBe(canonicalizeAndHash([t2]));
  });

  test("hash is sha256-prefixed base64", () => {
    const h = canonicalizeAndHash([TOOL_A]);
    expect(h).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
  });
});

// ── (j) regenerate round-trip ─────────────────────────────────────

describe("(j) regenerate-script round-trip", () => {
  test("after editing a manifest, the regenerated lockfile validates", async () => {
    // Build a fake mini-repo with one bundled extension at the
    // expected path layout. We point `buildLockfile` at this temp
    // root and exercise the same code path as the production script.
    const fakeRepo = await mkdtemp(join(tmpdir(), "fake-repo-"));
    try {
      // The script's BUNDLED list expects each entry's path to point
      // at a directory containing an `ezcorp.config.ts`. We can't
      // monkey-patch BUNDLED, but the other 20 entries will simply
      // fail to load. We assert specifically on `scratchpad`'s entry
      // by pointing the script at a fake tree where ONLY scratchpad
      // resolves; the script's `errors` array captures the rest.
      const scratchpadDir = join(fakeRepo, "docs/extensions/examples/scratchpad");
      await mkdir(scratchpadDir, { recursive: true });
      await Bun.write(
        join(scratchpadDir, "ezcorp.config.ts"),
        `export default { schemaVersion: 2, name: "scratchpad", version: "9.9.9", description: "x", author: { name: "x" }, entrypoint: "./index.ts", tools: [{ name: "round_trip", description: "rt", inputSchema: {} }], permissions: { storage: true } };\n`,
      );
      const { lockfile, errors } = await buildLockfile(fakeRepo);
      // Other 20 should have failed; scratchpad should be present.
      expect(errors.length).toBeGreaterThan(0);
      expect(lockfile.extensions.scratchpad).toBeDefined();
      expect(lockfile.extensions.scratchpad?.version).toBe("9.9.9");

      // Write that lockfile to our verifier path.
      await Bun.write(lockfilePath, JSON.stringify(lockfile));
      clearLockfileCache();

      // Verify the SAME manifest against the regenerated lockfile.
      // `buildLockfile` uses `loadManifestFresh` which runs the manifest
      // through `migrateManifestV2ToV3`, so the lockfile records hashes
      // of migrated tools. Production `verifyManifestAgainstLock` is also
      // called against migrated manifests (the loader migrates first),
      // so we mirror that here.
      const manifest = migrateManifestV2ToV3({
        schemaVersion: 2,
        name: "scratchpad",
        version: "9.9.9",
        description: "x",
        author: { name: "x" },
        entrypoint: "./index.ts",
        tools: [{ name: "round_trip", description: "rt", inputSchema: {} }],
        permissions: { storage: true },
      });
      const result = await verifyManifestAgainstLock("scratchpad", manifest);
      expect(result).toEqual({ ok: true });
    } finally {
      await rm(fakeRepo, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("diffLockfiles reports added/removed/changed entries correctly", () => {
    const before = {
      schemaVersion: 1 as const,
      generatedAt: "old",
      extensions: {
        a: { version: "1.0.0", entrypoint: "./i.ts", toolsHash: "sha256-old" },
        b: { version: "1.0.0", entrypoint: "./i.ts", toolsHash: "sha256-bb" },
      },
    };
    const after = {
      schemaVersion: 1 as const,
      generatedAt: "new",
      extensions: {
        a: { version: "1.0.0", entrypoint: "./i.ts", toolsHash: "sha256-new" }, // changed hash
        c: { version: "0.1.0", entrypoint: "./i.ts", toolsHash: "sha256-cc" }, // added
      },
    };
    const diff = diffLockfiles(before, after);
    expect(diff.added).toEqual(["c"]);
    expect(diff.removed).toEqual(["b"]);
    expect(diff.changed).toEqual([
      { name: "a", field: "toolsHash", before: "sha256-old", after: "sha256-new" },
    ]);
  });

  test("diffLockfiles against null treats every entry as added", () => {
    const after = {
      schemaVersion: 1 as const,
      generatedAt: "now",
      extensions: {
        x: { version: "1.0.0", entrypoint: "./i.ts", toolsHash: "sha256-xx" },
      },
    };
    const diff = diffLockfiles(null, after);
    expect(diff.added).toEqual(["x"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });
});

// ── integration: edit a manifest, regenerate, re-verify ───────────

describe("integration: edit manifest → regenerate → verify cycle", () => {
  test("modifying a tool flips toolsHash; regeneration + verify recovers", async () => {
    const v1: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "round-trip",
      version: "1.0.0",
      description: "x",
      author: { name: "x" },
      entrypoint: "./i.ts",
      tools: [TOOL_A, TOOL_B],
      permissions: {},
    };
    const v1Hash = canonicalizeAndHash(v1.tools ?? []);
    await writeLockfile({
      "round-trip": { version: "1.0.0", entrypoint: "./i.ts", toolsHash: v1Hash },
    });
    clearLockfileCache();
    expect((await verifyManifestAgainstLock("round-trip", v1)).ok).toBe(true);

    // Edit the manifest: add a new tool. Must fail.
    const v2: ExtensionManifestV2 = {
      ...v1,
      tools: [...(v1.tools ?? []), {
        name: "delta",
        description: "delta",
        inputSchema: {},
      }],
    };
    const v2Result = await verifyManifestAgainstLock("round-trip", v2);
    expect(v2Result.ok).toBe(false);
    if (!v2Result.ok) expect(v2Result.reason).toBe("tool-list drift");

    // Regenerate the lockfile to match v2.
    const v2Hash = canonicalizeAndHash(v2.tools ?? []);
    await writeLockfile({
      "round-trip": { version: "1.0.0", entrypoint: "./i.ts", toolsHash: v2Hash },
    });
    clearLockfileCache();

    // Now v2 matches.
    const v2RecheckResult = await verifyManifestAgainstLock("round-trip", v2);
    expect(v2RecheckResult).toEqual({ ok: true });
  });
});

// ── lockfile entry not present for a name ───────────────────────

describe("manifest verified against a lockfile that has no entry for it", () => {
  test("missing entry returns ok:false with the right reason", async () => {
    await writeLockfile({
      // Some other extension is in the lockfile, but not 'fixture'.
      other: {
        version: "1.0.0",
        entrypoint: "./i.ts",
        toolsHash: canonicalizeAndHash([TOOL_A]),
      },
    });
    clearLockfileCache();
    const result = await verifyManifestAgainstLock("fixture", fixtureManifest());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no lockfile entry");
  });
});
