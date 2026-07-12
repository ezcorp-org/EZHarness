/**
 * Unit coverage for the extension npm-dependency contract choke point
 * (src/extensions/npm-deps.ts): `verifyNpmDependencies` (undefined/empty,
 * resolvable real dep, missing, version-mismatch, satisfied, scoped-name,
 * indeterminate-version → satisfied) and `formatNpmDepError` (missing +
 * mismatch message shapes).
 *
 * Spec: tasks/extension-npm-deps.md.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatNpmDepError, verifyNpmDependencies } from "../extensions/npm-deps";

// The graded-card-scanner example dir declares `@zxing/library` (in the
// repo root `dependencies`) — the real isolated-linker `.bun/...` resolve
// path exercises the last-`/node_modules/<name>/`-segment version read.
const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SCANNER_DIR = join(REPO_ROOT, "docs", "extensions", "examples", "graded-card-scanner");

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "npm-deps-"));
  // fake-pkg@1.5.0 — a normal package with a readable version.
  await mkdir(join(tmp, "node_modules", "fake-pkg"), { recursive: true });
  await writeFile(
    join(tmp, "node_modules", "fake-pkg", "package.json"),
    JSON.stringify({ name: "fake-pkg", version: "1.5.0", main: "index.js" }),
  );
  await writeFile(join(tmp, "node_modules", "fake-pkg", "index.js"), "module.exports = {};");
  // @scope/pkg@0.2.0 — scoped-name resolution.
  await mkdir(join(tmp, "node_modules", "@scope", "pkg"), { recursive: true });
  await writeFile(
    join(tmp, "node_modules", "@scope", "pkg", "package.json"),
    JSON.stringify({ name: "@scope/pkg", version: "0.2.0", main: "index.js" }),
  );
  await writeFile(join(tmp, "node_modules", "@scope", "pkg", "index.js"), "module.exports = {};");
  // fake-nopkg — resolvable via index.js but NO package.json, so the
  // version read hits the unreadable-package.json branch (→ satisfied).
  await mkdir(join(tmp, "node_modules", "fake-nopkg"), { recursive: true });
  await writeFile(join(tmp, "node_modules", "fake-nopkg", "index.js"), "module.exports = {};");
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("verifyNpmDependencies", () => {
  test("undefined declaration → ok, no issues", () => {
    expect(verifyNpmDependencies(undefined, tmp)).toEqual({ ok: true, issues: [] });
  });

  test("empty declaration → ok, no issues", () => {
    expect(verifyNpmDependencies({}, tmp)).toEqual({ ok: true, issues: [] });
  });

  test("resolvable real dep (@zxing/library) satisfies its range", () => {
    const result = verifyNpmDependencies({ "@zxing/library": "^0.23.0" }, SCANNER_DIR);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test("subpath-only package (@modelcontextprotocol/sdk, no root export) verifies as present", () => {
    // Bun.resolveSync("@modelcontextprotocol/sdk") THROWS (the package only
    // exports subpaths), but `<name>/package.json` resolves — the robust
    // resolver must treat it as present, not "missing".
    const result = verifyNpmDependencies({ "@modelcontextprotocol/sdk": "^1.29.0" }, SCANNER_DIR);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test("missing dep → one `missing` issue", () => {
    const result = verifyNpmDependencies({ "totally-not-installed-xyz": "^1.0.0" }, tmp);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { name: "totally-not-installed-xyz", range: "^1.0.0", reason: "missing" },
    ]);
  });

  test("resolvable fixture within range → satisfied", () => {
    expect(verifyNpmDependencies({ "fake-pkg": "^1.5.0" }, tmp)).toEqual({
      ok: true,
      issues: [],
    });
  });

  test("resolved version outside range → `version-mismatch` with resolved detail", () => {
    const result = verifyNpmDependencies({ "fake-pkg": "^2.0.0" }, tmp);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { name: "fake-pkg", range: "^2.0.0", reason: "version-mismatch", detail: "1.5.0" },
    ]);
  });

  test("scoped fixture name resolves + version-checks", () => {
    expect(verifyNpmDependencies({ "@scope/pkg": "^0.2.0" }, tmp)).toEqual({
      ok: true,
      issues: [],
    });
    const bad = verifyNpmDependencies({ "@scope/pkg": "^0.3.0" }, tmp);
    expect(bad.issues[0]).toEqual({
      name: "@scope/pkg",
      range: "^0.3.0",
      reason: "version-mismatch",
      detail: "0.2.0",
    });
  });

  test("resolves but package.json unreadable → treated as satisfied (never false-positive)", () => {
    expect(verifyNpmDependencies({ "fake-nopkg": "^9.9.9" }, tmp)).toEqual({
      ok: true,
      issues: [],
    });
  });

  test("aggregates issues across multiple deps (missing + mismatch)", () => {
    const result = verifyNpmDependencies(
      { "fake-pkg": "^2.0.0", "totally-not-installed-xyz": "^1.0.0" },
      tmp,
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(2);
  });
});

describe("formatNpmDepError", () => {
  test("missing issue reads `(missing)` with the install remedy", () => {
    const msg = formatNpmDepError("graded-card-scanner", [
      { name: "@zxing/library", range: "^0.23.0", reason: "missing" },
    ]);
    expect(msg).toBe(
      'Extension "graded-card-scanner" requires npm package(s) it cannot resolve: ' +
        "@zxing/library@^0.23.0 (missing). Install them in the deployment " +
        "(root package.json + bun install, or rebuild the image), then retry.",
    );
  });

  test("version-mismatch reads `(found X, needs Y)`", () => {
    const msg = formatNpmDepError("excel", [
      { name: "exceljs", range: "^4.4.0", reason: "version-mismatch", detail: "4.3.0" },
    ]);
    expect(msg).toContain("exceljs@^4.4.0 (found 4.3.0, needs ^4.4.0)");
  });

  test("joins multiple issues with a comma", () => {
    const msg = formatNpmDepError("multi", [
      { name: "a", range: "^1.0.0", reason: "missing" },
      { name: "b", range: "^2.0.0", reason: "version-mismatch", detail: "1.0.0" },
    ]);
    expect(msg).toContain("a@^1.0.0 (missing), b@^2.0.0 (found 1.0.0, needs ^2.0.0)");
  });
});
