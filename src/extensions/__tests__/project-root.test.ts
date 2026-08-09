/**
 * Unit tests for `src/extensions/project-root.ts` — the seams the
 * resolution-order suite next door can't reach.
 *
 * Split of labour with `bundled-getProjectRoot.test.ts`:
 *
 *   - that file drives the four resolution rules (env / import-meta /
 *     git-walk / cwd-fallback) THROUGH `./bundled`, which now re-exports
 *     them — so it doubles as the proof that the re-export shim keeps
 *     every pre-existing `from ".../extensions/bundled"` importer working;
 *   - this file imports the module directly and covers what a pure
 *     resolution test structurally cannot:
 *       1. `warnIfCwdFallback` — `getProjectRoot()` takes no overrides,
 *          and under Bun this module's own `import.meta.dir` always
 *          satisfies step 2, so the cwd-fallback log is unreachable from
 *          that entry point in a bun:test process. Note this is the
 *          branch PRODUCTION takes on every container boot (see the
 *          module header), so it is the opposite of an edge case — it is
 *          just untestable from the cached entry point;
 *       2. the `import.meta.url` secondary signal (match / no-match /
 *          not-a-file-URL) — same reason: step 2's primary substring
 *          match always wins first under Bun. Where that branch IS live
 *          (the vitest/Node leg, which has no `import.meta.dir`) is
 *          pinned separately by
 *          `web/src/__tests__/project-root-node-leg.server.test.ts`;
 *       3. the 64-iteration cap in the `.git` walk-up, which a normal
 *          filesystem path never exhausts;
 *       4. the re-export identity — `./bundled` and `./project-root` must
 *          be the SAME binding, or the process-lifetime cache would fork
 *          in two and `__resetProjectRootCacheForTests` would only clear
 *          one of them;
 *       5. the static import closure — the invariant the whole extraction
 *          exists to create, and the one nothing else enforces.
 *
 * The log line is observed on `process.stderr` (where `logger.warn`
 * writes) rather than by mocking `../../logger` — no module-graph
 * perturbation, and it asserts the real emit path.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, resolveRelativeSpecifier } from "../../__tests__/helpers/pglite-snapshot-cache";
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
  test("cwd-fallback logs the resolved root and how to override it", () => {
    const lines = captureStderr(() => {
      warnIfCwdFallback({ root: "/app", source: "cwd-fallback" });
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
    // The root it settled on has to be IN the record — that is the whole
    // diagnostic value of the line when a lookup does go wrong.
    expect(record.cwd).toBe("/app");
    expect(record.msg).toContain("EZCORP_PROJECT_ROOT");
    // Not phrased as a failure: this fires on every production boot (no
    // env var, vite-rewritten import.meta, no .git in the image) and the
    // answer is correct there. An operator grepping the boot log must not
    // read it as an incident.
    expect(record.msg).toContain("expected in the container");
  });

  test.each(["env", "import-meta", "git-walk"] as const)("source=%s is silent", (source) => {
    const lines = captureStderr(() => {
      warnIfCwdFallback({ root: "/repo", source });
    });
    expect(lines).toEqual([]);
  });
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

/**
 * STATIC relative-import specifiers in `text`, comments stripped.
 *
 * Deliberately NOT `collectSchemaInputs` from the snapshot-cache helper:
 * that one is intentionally over-inclusive (it follows `import()` and
 * `require()` and matches inside comments) because for a cache key
 * over-invalidation is the safe direction. Here the opposite is true —
 * only the STATIC graph can produce a module-evaluation cycle, and
 * `src/logger.ts` reaches the DB exclusively through a lazy
 * `await import("./db/queries/error-logs")`, which is precisely what
 * makes it a safe dependency. Counting that lazy edge would make this
 * assertion unwritable.
 *
 * Matches `from "./x"` (covering `import … from` and `export … from`,
 * multi-line clauses included, since `from` sits next to the string) and
 * bare `import "./x"`. `import("./x")` is excluded because `import` is
 * followed by `(`, not whitespace-then-quote.
 */
function staticRelativeSpecifiers(text: string): string[] {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
  return Array.from(
    code.matchAll(/(?:\bfrom\s*["']|\bimport\s+["'])(\.[^"']*)["']/g),
    (m) => m[1] as string,
  );
}

/** Transitive static-import closure of `entry`, as repo-relative paths. */
function staticClosure(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of staticRelativeSpecifiers(readFileSync(file, "utf8"))) {
      const target = resolveRelativeSpecifier(file, spec);
      // An unresolvable static specifier would be a broken import that
      // typecheck already catches; nothing to assert about it here.
      if (target) stack.push(target);
    }
  }
  return [...seen].map((f) => relative(REPO_ROOT, f)).sort();
}

describe("static import closure", () => {
  test("project-root.ts reaches only itself and the logger", () => {
    // THE POINT OF THIS PR, made executable. project-root.ts lived in
    // bundled.ts, which reaches db/queries/extensions.ts ->
    // db/connection.ts -> migrate.ts; that cycle is why migrate.ts and
    // background-timers.ts had to fetch getProjectRoot() through a
    // dynamic import(). Both are static imports now, and they are only
    // safe while this closure stays this small.
    //
    // If this fails: you added a static import to project-root.ts. Make
    // it lazy, or move what you needed, or you have just re-created the
    // cycle and re-broken migrate.ts in a way nothing else will catch —
    // the dynamic-import workaround is gone, so the failure mode is a
    // module-evaluation order bug at boot, not a test.
    expect(staticClosure(resolve(REPO_ROOT, "src/extensions/project-root.ts"))).toEqual([
      "src/extensions/project-root.ts",
      "src/logger.ts",
    ]);
  });

  test("the walker sees a static import but not a lazy one", () => {
    // Guards the assertion above against silently degrading into "matches
    // nothing". `src/logger.ts` is the perfect fixture: its ONLY relative
    // specifier is a lazy `await import("./db/queries/error-logs")`.
    expect(staticRelativeSpecifiers(`import { a } from "./x";`)).toEqual(["./x"]);
    expect(staticRelativeSpecifiers(`import "./side-effect";`)).toEqual(["./side-effect"]);
    expect(staticRelativeSpecifiers(`export { b } from "./y";`)).toEqual(["./y"]);
    expect(staticRelativeSpecifiers(`const m = await import("./lazy");`)).toEqual([]);
    expect(staticRelativeSpecifiers(`// import { c } from "./commented";`)).toEqual([]);
    expect(
      staticRelativeSpecifiers(readFileSync(resolve(REPO_ROOT, "src/logger.ts"), "utf8")),
    ).toEqual([]);
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
