// The "don't add replaced deps" list in CLAUDE.md, enforced instead of stated.
//
// `biome.json`'s `style/noRestrictedImports` denies the modules at the IMPORT
// site, with the reason in the diagnostic text (the direct analog of a Rust
// `clippy.toml` `disallowed-methods` entry). That catches usage — but biome
// only ever sees code, so a dependency that is INSTALLED and not yet imported
// is invisible to it. `bun install express` followed by a PR that only wires
// it up next sprint would sail through lint. So the manifests get scanned too,
// and both halves are pinned here:
//
//   1. no package.json in the repo may DECLARE a denied dependency;
//   2. biome.json must actually deny each one at `"level": "error"`;
//   3. the `web/**` override must stay a strict subset of the base list.
//
// (3) is the sharp edge. Biome overrides REPLACE a rule's `options` wholesale
// rather than merging them, so the override that exempts `vitest` for `web/`
// has to restate every OTHER denied path verbatim. Nothing in biome warns when
// those two maps drift; forget one entry and `web/` silently stops denying it.
// The assertion below derives the expected override from the base map, so
// adding a dep to the base list and not the override is a test failure rather
// than a hole.
//
// `"level": "error"` is load-bearing and also asserted: `ci.yml` deliberately
// keeps biome warnings visible but non-blocking (`bun run lint` exits 0 with
// warnings present), so a denial registered at `warn` enforces nothing at all.

import { test, expect, describe } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Every module `biome.json` must deny, with the CLAUDE.md replacement each one
 * loses to. Kept as the substring the diagnostic message has to mention so a
 * future edit can't degrade a reason into a bare "don't use this".
 */
const DENIED: ReadonlyArray<{ module: string; mustMention: string }> = [
  { module: "express", mustMention: "Bun.serve()" },
  { module: "ws", mustMention: "Bun.serve()" },
  { module: "pg", mustMention: "Bun.sql" },
  { module: "postgres", mustMention: "Bun.sql" },
  { module: "better-sqlite3", mustMention: "Bun.sql" },
  { module: "bun:sqlite", mustMention: "Bun.sql" },
  { module: "ioredis", mustMention: "Bun.redis" },
  { module: "execa", mustMention: "Bun.$" },
  { module: "dotenv", mustMention: ".env" },
  { module: "vitest", mustMention: "bun:test" },
];

/**
 * `vitest` is the one denial with a sanctioned home: `web/` runs the Svelte
 * component/server suites on it (CLAUDE.md "Testing"), so `web/package.json`
 * declares it and the `web/**` biome override permits importing it there.
 * Every other tree — backend, worker, packages, extensions, examples — is
 * bun:test only.
 */
const WEB_ONLY_ALLOWANCE = "vitest";

/** Manifest globs covering every package.json a human edits in this repo. */
const MANIFEST_GLOBS = [
  "package.json",
  "web/package.json",
  "worker/package.json",
  "packages/@ezcorp/*/package.json",
  "extensions/*/package.json",
  "docs/extensions/examples/*/package.json",
];

type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type BiomeConfig = {
  linter?: {
    rules?: {
      style?: { noRestrictedImports?: unknown; noNonNullAssertion?: unknown };
      suspicious?: { noExplicitAny?: unknown };
    };
  };
  overrides?: Array<{
    includes?: string[];
    linter?: { rules?: { style?: { noRestrictedImports?: unknown } } };
  }>;
};

type RestrictedImports = { level?: string; options?: { paths?: Record<string, string> } };

async function readBiomeConfig(): Promise<BiomeConfig> {
  return (await Bun.file(join(REPO_ROOT, "biome.json")).json()) as BiomeConfig;
}

async function manifestPaths(): Promise<string[]> {
  const found: string[] = [];
  for (const pattern of MANIFEST_GLOBS) {
    for await (const rel of new Glob(pattern).scan({ cwd: REPO_ROOT })) found.push(rel);
  }
  return found.sort();
}

describe("dependency denylist", () => {
  test("no package.json declares a replaced dependency", async () => {
    const paths = await manifestPaths();
    // A glob set that silently matched nothing would make this test vacuous.
    expect(paths.length).toBeGreaterThan(10);
    expect(paths).toContain("package.json");
    expect(paths).toContain("web/package.json");

    const violations: string[] = [];
    for (const rel of paths) {
      const pkg = (await Bun.file(join(REPO_ROOT, rel)).json()) as Manifest;
      const declared = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
        ...pkg.optionalDependencies,
      };
      for (const { module, mustMention } of DENIED) {
        // `bun:sqlite` is a builtin — it can be imported but never declared.
        if (module.startsWith("bun:")) continue;
        if (!(module in declared)) continue;
        if (module === WEB_ONLY_ALLOWANCE && rel === "web/package.json") continue;
        violations.push(`${rel} declares "${module}" — use ${mustMention} instead`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("web/package.json is the only manifest allowed to declare vitest", async () => {
    // Guards the exemption above from decaying into "vitest is fine anywhere":
    // it must stay a statement about ONE manifest, and that manifest must
    // still be the one that actually needs it.
    const paths = await manifestPaths();
    const withVitest: string[] = [];
    for (const rel of paths) {
      const pkg = (await Bun.file(join(REPO_ROOT, rel)).json()) as Manifest;
      const declared = { ...pkg.dependencies, ...pkg.devDependencies };
      if (WEB_ONLY_ALLOWANCE in declared) withVitest.push(rel);
    }
    expect(withVitest).toEqual(["web/package.json"]);
  });

  test("biome denies every replaced dependency at error level, with a reason", async () => {
    const cfg = await readBiomeConfig();
    const rule = cfg.linter?.rules?.style?.noRestrictedImports as RestrictedImports | undefined;
    expect(rule).toBeDefined();

    // A `warn` here would be decorative: ci.yml keeps biome warnings
    // non-blocking on purpose, so only `error` actually stops a PR.
    expect(rule?.level).toBe("error");

    const paths = rule?.options?.paths ?? {};
    expect(Object.keys(paths).sort()).toEqual(DENIED.map((d) => d.module).sort());

    for (const { module, mustMention } of DENIED) {
      const message = paths[module];
      expect(typeof message).toBe("string");
      // The reason is the whole point — deny the import, and put the
      // replacement in the error text where the author is already looking.
      expect(message).toContain(mustMention);
    }
  });

  test("the web/** override drops only vitest and restates everything else", async () => {
    const cfg = await readBiomeConfig();
    const base = cfg.linter?.rules?.style?.noRestrictedImports as RestrictedImports | undefined;
    const override = cfg.overrides?.find((o) => o.includes?.includes("web/**"));
    expect(override).toBeDefined();

    const overrideRule = override?.linter?.rules?.style?.noRestrictedImports as
      | RestrictedImports
      | undefined;
    expect(overrideRule?.level).toBe("error");

    // Biome REPLACES options rather than merging them, so the expected
    // override is exactly the base map minus the one allowance — derived,
    // never hand-listed, so the two can't drift apart unnoticed.
    const expected = { ...(base?.options?.paths ?? {}) };
    delete expected[WEB_ONLY_ALLOWANCE];
    expect(overrideRule?.options?.paths).toEqual(expected);
  });

  test("biome enforces the denial where the override does and doesn't apply", async () => {
    // The config assertions above can all pass while biome resolves the
    // override differently than expected, so drive the real binary: a probe
    // under `src/` must be denied both modules, the identical probe under
    // `web/` only the non-exempt one.
    const probe = 'import "express";\nimport "vitest";\n';
    const backend = join(REPO_ROOT, "src", "__denylist-probe.ts");
    const web = join(REPO_ROOT, "web", "src", "lib", "__denylist-probe.ts");
    await Bun.write(backend, probe);
    await Bun.write(web, probe);
    try {
      const proc = Bun.spawnSync(
        [
          join(REPO_ROOT, "node_modules", ".bin", "biome"),
          "lint",
          "--only=style/noRestrictedImports",
          "--reporter=json",
          backend,
          web,
        ],
        { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
      );
      const report = JSON.parse(proc.stdout.toString()) as {
        diagnostics: Array<{ location?: { path?: string }; message?: unknown }>;
      };
      const flagged = new Set(
        report.diagnostics.map((d) => `${d.location?.path}`.replace(/\\/g, "/")),
      );
      expect([...flagged].some((p) => p.endsWith("src/__denylist-probe.ts"))).toBe(true);

      const backendHits = report.diagnostics.filter((d) =>
        `${d.location?.path}`.includes("src/__denylist-probe.ts"),
      );
      const webHits = report.diagnostics.filter((d) =>
        `${d.location?.path}`.includes("web/src/lib/__denylist-probe.ts"),
      );
      // Backend: both imports denied. Web: express denied, vitest allowed.
      expect(backendHits.length).toBe(2);
      expect(webHits.length).toBe(1);
    } finally {
      await Bun.file(backend).delete();
      await Bun.file(web).delete();
    }
  }, 60_000);
});

describe("biome lint policy", () => {
  test("noNonNullAssertion stays off, on purpose", async () => {
    const cfg = await readBiomeConfig();
    // DECISION (recorded here because biome.json is strict JSON and cannot
    // carry a comment): this rule stays off permanently. It reports ~520 sites,
    // and 288 of them exist BECAUSE `noUncheckedIndexedAccess: true` is set in
    // tsconfig.json — every `arr[i]` widens to `T | undefined`, and `!` is the
    // idiomatic narrowing after a bounds check the compiler can't follow.
    // Turning it on would penalise the codebase for being STRICTER than the
    // default, and the mechanical fix (non-null assertion -> `?? throw`) adds
    // unreachable branches that then cost coverage. Not a ratchet target.
    expect(cfg.linter?.rules?.style?.noNonNullAssertion).toBe("off");
  });
});
