// Tests for the postinstall deploy helper — real temp dirs, no mocks.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectRoot, installApp, main } from "./scripts/postinstall";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "gcs-postinstall-"));
}

describe("findProjectRoot", () => {
  test("walks up to the nearest .git directory", () => {
    const root = makeTmp();
    try {
      mkdirSync(join(root, ".git"));
      const nested = join(root, "a", "b", "c");
      mkdirSync(nested, { recursive: true });
      expect(findProjectRoot(nested)).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("falls back to the starting dir when no .git exists above", () => {
    const dir = makeTmp();
    try {
      // tmpdir ancestry has no .git — the walk exhausts and returns `from`.
      expect(findProjectRoot(dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("main", () => {
  test("deploys the real app/ into the given root and reports the path", () => {
    const root = makeTmp();
    const logs: string[] = [];
    try {
      const dest = main(root, (msg) => logs.push(msg));
      expect(dest).toBe(
        join(root, ".ezcorp", "extension-data", "graded-card-scanner", "app"),
      );
      // The genuine SPA shipped, not a stub.
      expect(readFileSync(join(dest, "index.html"), "utf8")).toContain("Graded Card Scanner");
      expect(readFileSync(join(dest, "lib", "cert.js"), "utf8")).toContain("parseCertInput");
      expect(logs[0]).toContain(dest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("installApp", () => {
  test("copies the app tree into extension-data and is idempotent", () => {
    const pkg = makeTmp();
    const projectRoot = makeTmp();
    try {
      const src = join(pkg, "app");
      mkdirSync(join(src, "lib"), { recursive: true });
      writeFileSync(join(src, "index.html"), "<html>v1</html>");
      writeFileSync(join(src, "lib", "cert.js"), "export {};");

      const dest = installApp(src, projectRoot);
      expect(dest).toBe(
        join(projectRoot, ".ezcorp", "extension-data", "graded-card-scanner", "app"),
      );
      expect(readFileSync(join(dest, "index.html"), "utf8")).toBe("<html>v1</html>");
      expect(readFileSync(join(dest, "lib", "cert.js"), "utf8")).toBe("export {};");

      // Re-run refreshes in place.
      writeFileSync(join(src, "index.html"), "<html>v2</html>");
      installApp(src, projectRoot);
      expect(readFileSync(join(dest, "index.html"), "utf8")).toBe("<html>v2</html>");
    } finally {
      rmSync(pkg, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
