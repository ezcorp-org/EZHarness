/**
 * Unit tests for `src/extensions/project-root.ts` — the seams the
 * resolution-order suite next door can't reach.
 *
 * Split of labour with `bundled-getProjectRoot.test.ts`:
 *
 *   - that file drives the four resolution rules (env / import-meta /
 *     git-walk / cwd-fallback) THROUGH `./bundled`, which now re-exports
 *     them — so it doubles as the proof that the re-export shim keeps the
 *     ~40 existing `from ".../extensions/bundled"` importers working;
 *   - this file imports the module directly and covers what a pure
 *     resolution test structurally cannot:
 *       1. `warnIfCwdFallback` — `getProjectRoot()` takes no overrides,
 *          and in-process this module's own `import.meta.dir` always
 *          satisfies step 2, so the "fell through to cwd" WARN is
 *          unreachable from that entry point;
 *       2. the `import.meta.url` secondary signal (match / no-match /
 *          not-a-file-URL) — same reason: step 2's primary substring
 *          match always wins first under Bun, so the URL branch only
 *          ever runs under a bundler that rewrote `import.meta.dir`;
 *       3. the 64-iteration cap in the `.git` walk-up, which a normal
 *          filesystem path never exhausts;
 *       4. the re-export identity — `./bundled` and `./project-root` must
 *          be the SAME binding, or the process-lifetime cache would fork
 *          in two and `__resetProjectRootCacheForTests` would only clear
 *          one of them.
 *
 * The WARN is observed on `process.stderr` (where `logger.warn` writes)
 * rather than by mocking `../../logger` — no module-graph perturbation,
 * and it asserts the real emit path.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { pathToFileURL } from "node:url";
import * as bundled from "../bundled";
import {
  __resetProjectRootCacheForTests,
  getProjectRoot,
  resolveProjectRoot,
  warnIfCwdFallback,
} from "../project-root";

/** Capture everything `logger.warn` writes while `fn` runs. */
function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

afterEach(() => {
  __resetProjectRootCacheForTests();
});

describe("warnIfCwdFallback", () => {
  test("cwd-fallback emits the operator WARN with the offending cwd", () => {
    const lines = captureStderr(() => {
      warnIfCwdFallback({ root: "/some/wrong/cwd", source: "cwd-fallback" });
    });
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] as string) as {
      level: string;
      msg: string;
      subsystem: string;
      cwd: string;
    };
    expect(record.level).toBe("warn");
    expect(record.subsystem).toBe("extensions");
    expect(record.cwd).toBe("/some/wrong/cwd");
    expect(record.msg).toContain("EZCORP_PROJECT_ROOT");
  });

  test.each(["env", "import-meta", "git-walk"] as const)(
    "source=%s is silent",
    (source) => {
      const lines = captureStderr(() => {
        warnIfCwdFallback({ root: "/repo", source });
      });
      expect(lines).toEqual([]);
    },
  );
});

describe("resolveProjectRoot — import.meta.url secondary signal", () => {
  test("a file URL under src/extensions/ resolves to its grandparent", () => {
    const got = resolveProjectRoot({
      env: {},
      importMetaDir: "", // step 2's primary match must miss
      importMetaUrl: pathToFileURL("/fake/repo/src/extensions/project-root.ts").href,
      cwd: "/elsewhere",
    });
    expect(got).toEqual({ root: "/fake/repo", source: "import-meta" });
  });

  test("a file URL outside src/extensions/ falls through to the cwd fallback", () => {
    const got = resolveProjectRoot({
      env: {},
      importMetaDir: "",
      importMetaUrl: pathToFileURL("/vite/build/server/chunk.js").href,
      cwd: "/elsewhere",
      existsSync: () => false,
    });
    expect(got).toEqual({ root: "/elsewhere", source: "cwd-fallback" });
  });

  test("a non-file URL is swallowed, not thrown, and falls through", () => {
    // `fileURLToPath` rejects a non-`file:` scheme — the bundler-rewrote-it
    // case the try/catch exists for. Resolution must continue, not crash
    // the host at boot.
    const got = resolveProjectRoot({
      env: {},
      importMetaDir: "",
      importMetaUrl: "https://example.invalid/server/chunk.js",
      cwd: "/elsewhere",
      existsSync: () => false,
    });
    expect(got).toEqual({ root: "/elsewhere", source: "cwd-fallback" });
  });

  test("an empty importMetaUrl override skips the branch entirely", () => {
    const got = resolveProjectRoot({
      env: {},
      importMetaDir: "",
      importMetaUrl: "",
      cwd: "/elsewhere",
      existsSync: () => false,
    });
    expect(got).toEqual({ root: "/elsewhere", source: "cwd-fallback" });
  });
});

describe("resolveProjectRoot — .git walk-up iteration cap", () => {
  test("a path deeper than the 64-step cap gives up instead of spinning", () => {
    // The cap is a belt-and-braces guard against a filesystem where
    // `dirname()` never fixed-points. A 70-segment path exhausts it
    // before reaching `/`, so the walk returns undefined via the cap
    // rather than via the parent === dir check.
    const deep = `/${Array.from({ length: 70 }, (_, i) => `d${i}`).join("/")}`;
    const got = resolveProjectRoot({
      env: {},
      importMetaDir: "",
      importMetaUrl: "",
      cwd: deep,
      existsSync: () => false,
    });
    expect(got).toEqual({ root: deep, source: "cwd-fallback" });
  });
});

describe("re-export shim", () => {
  test("./bundled re-exports the same bindings, so the cache is shared", () => {
    expect(bundled.getProjectRoot).toBe(getProjectRoot);
    expect(bundled.resolveProjectRoot).toBe(resolveProjectRoot);
    expect(bundled.__resetProjectRootCacheForTests).toBe(__resetProjectRootCacheForTests);

    // Same cache instance: reset through the shim, re-read through the
    // module, and the answers still agree.
    const direct = getProjectRoot();
    bundled.__resetProjectRootCacheForTests();
    expect(bundled.getProjectRoot()).toBe(direct);
    expect(getProjectRoot()).toBe(direct);
  });
});
