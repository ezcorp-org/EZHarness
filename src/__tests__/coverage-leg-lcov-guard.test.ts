/**
 * Coverage-leg lcov guard (closes the full-local silent-skip gap).
 *
 * scripts/test-coverage.sh merges by GLOBBING "$TMPDIR"/cov_*​/lcov.info, so a
 * leg that dies before writing one is simply absent from the union — silently.
 * Shard mode has always guarded the analogous case (its N_LCOV check); the two
 * leg-running modes (full local + CI legs-only) did not. That never allowed a
 * false GREEN — the gating legs' exit codes and the coverage gate still red the
 * run — but it destroyed diagnosability: a single dead leg drops its files out
 * of the merged lcov and the gate then prints one
 * "listed in thresholds but no lcov data" violation per orphaned file, burying
 * the real failure under phantom ones naming files the change never touched.
 *
 * Three halves (the third arrived later — see below):
 *   1. BEHAVIOUR — check_leg_lcov (scripts/lib/test-file-sets.sh) fails loud and
 *      NAMES each registered leg that produced no lcov. Exercised against the
 *      real function via bash + real temp dirs, never a re-implementation.
 *   2. ANTI-ROT — the leg producers in scripts/test-coverage.sh may only obtain
 *      a covdir from the LEG_COV_DIR registry, so a leg cannot be added that
 *      writes somewhere the guard never looks. This is what keeps the guard's
 *      leg list from rotting away from the legs the script actually runs.
 *   3. VITEST-LEG ALLOWLIST INTEGRITY — a leg can also emit a perfectly healthy
 *      lcov that is simply MISSING a module, which the two guards above cannot
 *      see. The node/vitest leg is driven by two hand-maintained allowlists
 *      (which test files run, which sources are measured) and a module is only
 *      covered when it is on BOTH. This half asserts every listed test file
 *      exists and every `--coverage.include` pattern matches something.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SETS_LIB = "scripts/lib/test-file-sets.sh";
const RUNNER = join(REPO_ROOT, "scripts/test-coverage.sh");
const WEB_ROOT = join(REPO_ROOT, "web");

const LCOV = "TN:\nSF:/repo/src/x.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n";

type Run = { code: number; stdout: string; stderr: string };

/** Run a bash snippet with the shared lib sourced and $TMPDIR pointed at `tmp`. */
function runGuard(tmp: string, body: string): Run {
  const script = `set -e\nsource ${SETS_LIB}\nTMPDIR=${JSON.stringify(tmp)}\n${body}\n`;
  const proc = Bun.spawnSync(["bash", "-c", script], { cwd: REPO_ROOT });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** Create <tmp>/<dir>/lcov.info with `content` ("" makes an EMPTY file). */
function seedLeg(tmp: string, dir: string, content: string): void {
  mkdirSync(join(tmp, dir), { recursive: true });
  writeFileSync(join(tmp, dir, "lcov.info"), content);
}

function withTmp<T>(fn: (tmp: string) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), "leg-lcov-"));
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// The registrations the runner actually makes, so the behaviour cases below
// exercise realistic names/dirs rather than invented ones.
const REGISTER_ALL = [
  "register_leg sdk cov_sdk",
  "register_leg harness-client cov_hc",
  "register_leg suggest cov_suggest",
  "register_leg ai-kit cov_aikit",
  "register_leg web-vitest cov_vitest",
  "register_leg web-security cov_security",
].join("\n");

const ALL_DIRS: ReadonlyArray<[string, string]> = [
  ["sdk", "cov_sdk"],
  ["harness-client", "cov_hc"],
  ["suggest", "cov_suggest"],
  ["ai-kit", "cov_aikit"],
  ["web-vitest", "cov_vitest"],
  ["web-security", "cov_security"],
];

describe("check_leg_lcov: behaviour", () => {
  test("passes silently when every registered leg wrote a non-empty lcov", () => {
    withTmp((tmp) => {
      for (const [, dir] of ALL_DIRS) seedLeg(tmp, dir, LCOV);
      const r = runGuard(tmp, `${REGISTER_ALL}\ncheck_leg_lcov`);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("");
    });
  });

  test("a leg with NO lcov fails the guard and is named — healthy legs are not", () => {
    withTmp((tmp) => {
      // Every leg but sdk produced its lcov: exactly the incident shape (the
      // sdk leg is pass/fail-TOLERATED, so its death is otherwise invisible).
      for (const [name, dir] of ALL_DIRS) if (name !== "sdk") seedLeg(tmp, dir, LCOV);
      const r = runGuard(tmp, `${REGISTER_ALL}\ncheck_leg_lcov`);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("::error::sdk coverage leg produced no lcov output");
      expect(r.stdout).toContain("(infrastructure failure)");
      // The expected path is named so the failure is actionable, not just loud.
      expect(r.stdout).toContain(join(tmp, "cov_sdk", "lcov.info"));
      for (const name of ["harness-client", "suggest", "ai-kit", "web-vitest", "web-security"]) {
        expect(r.stdout).not.toContain(`::error::${name} coverage leg`);
      }
    });
  });

  test("an EMPTY lcov counts as missing (it merges to nothing either way)", () => {
    withTmp((tmp) => {
      for (const [name, dir] of ALL_DIRS) seedLeg(tmp, dir, name === "web-vitest" ? "" : LCOV);
      const r = runGuard(tmp, `${REGISTER_ALL}\ncheck_leg_lcov`);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("::error::web-vitest coverage leg produced no lcov output");
    });
  });

  test("every dead leg is named, not just the first", () => {
    withTmp((tmp) => {
      seedLeg(tmp, "cov_sdk", LCOV);
      seedLeg(tmp, "cov_hc", LCOV);
      const r = runGuard(tmp, `${REGISTER_ALL}\ncheck_leg_lcov`);
      expect(r.code).toBe(1);
      for (const name of ["suggest", "ai-kit", "web-vitest", "web-security"]) {
        expect(r.stdout).toContain(`::error::${name} coverage leg produced no lcov output`);
      }
    });
  });

  test("only legs registered in THIS mode are expected (web-security is full-local only)", () => {
    withTmp((tmp) => {
      // legs-only mode never runs run_security_leg, so cov_security is absent
      // by design and must not be reported.
      for (const [name, dir] of ALL_DIRS) if (name !== "web-security") seedLeg(tmp, dir, LCOV);
      const legsOnly = REGISTER_ALL.split("\n")
        .filter((l) => !l.includes("web-security"))
        .join("\n");
      const r = runGuard(tmp, `${legsOnly}\ncheck_leg_lcov`);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    });
  });

  test("registering nothing passes — host-shard mode runs no legs at all", () => {
    withTmp((tmp) => {
      const r = runGuard(tmp, "check_leg_lcov");
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    });
  });

  test("registering from a subshell is REFUSED, not silently discarded", () => {
    withTmp((tmp) => {
      // The one-line mistake that would reinstate the silent skip: registering
      // inside the `( … ) &` that launches the leg mutates a COPY, so the
      // parent never expects it. Enforced rather than merely commented.
      const r = runGuard(tmp, "( register_leg sdk cov_sdk )\ncheck_leg_lcov");
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("register_leg 'sdk' was called from a SUBSHELL");
    });
  });

  test("…while the correct parent-shell call still registers normally", () => {
    withTmp((tmp) => {
      // Negative control: the guard must not fire on legitimate usage, or the
      // real producers in test-coverage.sh would all die at registration.
      const r = runGuard(tmp, "register_leg sdk cov_sdk\ncheck_leg_lcov");
      expect(r.code).toBe(1); // no lcov seeded → the leg is reported, not skipped
      expect(r.stderr).not.toContain("SUBSHELL");
      expect(r.stdout).toContain("::error::sdk coverage leg produced no lcov output");
    });
  });
});

// ── anti-rot: the producers may only get a covdir from the registry ─────────
describe("test-coverage.sh: leg covdirs come from the registry", () => {
  const runner = Bun.file(RUNNER).text();

  test("no leg hardcodes a $TMPDIR/cov_<name> path (host pool's cov_$idx aside)", async () => {
    const src = await runner;
    // The ONLY legitimate literal `$TMPDIR/cov_…` uses are the host pool's
    // per-file dirs (indexed: $idx while running, $i while counting) and the
    // merge glob `cov_*`. Anything else is a leg writing outside the registry
    // — exactly the drift that would let a future leg run unguarded.
    const offenders = src
      .split("\n")
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => /\$TMPDIR\/cov_/.test(line))
      .filter(({ line }) => !/\$TMPDIR\/cov_(\$(idx|i)\b|\*)/.test(line));
    expect(
      offenders.map((o) => `${o.no}: ${o.line.trim()}`),
      "a leg covdir must be read out of the LEG_COV_DIR registry " +
        "(scripts/lib/test-file-sets.sh) so check_leg_lcov is guaranteed to look " +
        "where the leg actually writes",
    ).toEqual([]);
  });

  test("every registered leg is used by a producer, and every used leg is registered", async () => {
    const src = await runner;
    const registered = [...src.matchAll(/^\s*register_leg\s+(\S+)\s+(\S+)\s*$/gm)].map((m) => m[1]);
    const referenced = [...src.matchAll(/\$\{LEG_COV_DIR\[([^\]]+)\]\}/g)].map((m) => m[1]);
    expect(registered.length).toBeGreaterThanOrEqual(6);
    expect(new Set(registered).size).toBe(registered.length);
    expect([...new Set(referenced)].sort()).toEqual([...new Set(registered)].sort());
  });

  test("both leg-running modes call the guard", async () => {
    const src = await runner;
    const legsOnlyBranch = src.indexOf('if [ -n "$COVERAGE_LEGS_ONLY" ]');
    const fullModeTail = src.indexOf("# ── full local mode:");
    expect(legsOnlyBranch).toBeGreaterThan(-1);
    expect(fullModeTail).toBeGreaterThan(legsOnlyBranch);
    const calls = [...src.matchAll(/^\s*check_leg_lcov\b/gm)].map((m) => m.index ?? -1);
    // One call inside the legs-only branch, one in the full-local tail.
    expect(calls.filter((i) => i > legsOnlyBranch && i < fullModeTail).length).toBe(1);
    expect(calls.filter((i) => i > fullModeTail).length).toBe(1);
  });
});

// ── one per-test timeout for every producer ─────────────────────────────────
/**
 * The host pool passed `--timeout 30000`; the four bun package/suggest legs
 * and the node/vitest leg passed nothing, so they ran on their runners' 5s
 * DEFAULT (`bun test --help`: "default is 5000"; vitest's `testTimeout`
 * default is also 5000 and web/vitest.config.ts sets no override). Same file,
 * same box, two budgets — and the legs are the worst place for the short one,
 * since each bundles its whole file set into one process and five run
 * concurrently on top of the 1289-file host pool.
 *
 * The cost was a false RED, not a false green: the ai-kit, harness-client and
 * vitest legs gate, so `cli-install.test.ts`'s "idempotent — second install"
 * failing at 5014.97ms — 0.3% over exactly that budget — reds CI for whoever
 * else happened to be loading the machine.
 *
 * Parsed from the real script so a NEW leg cannot quietly be added on the 5s
 * default, which is precisely how the existing ones got there.
 */
describe("test-coverage.sh: every producer shares one per-test timeout", () => {
  const runner = Bun.file(RUNNER).text();
  const lib = Bun.file(join(REPO_ROOT, SETS_LIB)).text();

  /** Executable lines that actually invoke `bun test` (not comments/echoes). */
  function bunTestCommands(src: string): string[] {
    return src
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => !l.startsWith("#"))
      .filter((l) => /(^|[\s(])bun test\s/.test(l))
      .filter((l) => !l.startsWith("echo"));
  }

  test("no `bun test` in the runner falls back to bun's 5s default", async () => {
    const naked = bunTestCommands(await runner).filter(
      (l) => !l.includes("$TEST_TIMEOUT_FLAG") && !/--timeout[= ]\d+/.test(l),
    );
    expect(
      naked,
      `${naked.length} bun test invocation(s) in scripts/test-coverage.sh carry no per-test ` +
        `timeout, so they inherit bun's 5s default while the host pool in the same file gets ` +
        `30s. A leg that bundles its whole file set into one process, running alongside four ` +
        `other legs and the host pool, is the last place that budget belongs. Pass ` +
        `$TEST_TIMEOUT_FLAG:\n  ${naked.join("\n  ")}`,
    ).toEqual([]);
  });

  test("the retry sweep in the shared lib uses the same number", async () => {
    const naked = bunTestCommands(await lib).filter((l) => !/--timeout[= ]30000/.test(l));
    expect(naked, `un-timed bun test invocation(s) in ${SETS_LIB}`).toEqual([]);
  });

  test("the vitest leg gets it too — vitest's own default is also 5s", async () => {
    const src = await runner;
    expect(src).toContain('npx vitest run --testTimeout="$TEST_TIMEOUT_MS"');
    // …and no config override silently reinstates the 5s default underneath it.
    const vitestConfig = await Bun.file(join(WEB_ROOT, "vitest.config.ts")).text();
    expect(vitestConfig).not.toMatch(/testTimeout\s*:/);
  });

  test("both spellings derive from ONE number, so the runners can't drift apart", async () => {
    const src = await runner;
    const ms = src.match(/^TEST_TIMEOUT_MS=(\d+)$/m);
    expect(ms, "TEST_TIMEOUT_MS must be a single literal both flags are built from").not.toBeNull();
    expect(Number(ms?.[1])).toBe(30000); // matches scripts/test.sh + security-coverage.sh
    expect(src).toContain('TEST_TIMEOUT_FLAG="--timeout $TEST_TIMEOUT_MS"');
  });
});

// ── the host-pool pass/fail gate ────────────────────────────────────────────
/**
 * `bun run test:coverage` used to print "22953 pass | 14 fail" and
 * "Coverage gate PASSED" and then exit 0 — the exit code was a COVERAGE
 * verdict only, and the failing-file list said "visibility only". Anyone
 * reading `$?` off the authoritative gate was told a suite with fourteen red
 * tests was fine.
 *
 * gate_host_failures (scripts/lib/test-file-sets.sh) is now the single
 * definition of whether a host-pool failure reds the run, shared by the CI
 * shard mode that always had it and the full local mode that never did.
 * Exercised here against the REAL function: a stub `passfail_files` supplies
 * set membership and a stub `bun` on PATH supplies the re-run's exit code, so
 * every branch of the rule is driven without needing a genuinely broken test
 * file in the repo.
 */
describe("gate_host_failures: the shared host-pool pass/fail rule", () => {
  /**
   * Run gate_host_failures with `pf` as the pass/fail set P, `failed` as the
   * pool's failing files, and a `bun` stub that exits `bunExit` (or, when
   * `bunExit` is a map, per-file).
   */
  function runGate(opts: {
    p: string[];
    failed: string[];
    bunExit: number | Record<string, number>;
  }): Run {
    return withTmp((tmp) => {
      const bin = join(tmp, "bin");
      mkdirSync(bin, { recursive: true });
      // The stub stands in for `bun test ./<file>` — the retry sweep's only
      // external dependency. `timeout -k 30 300 bun …` resolves it via PATH
      // exactly like the real binary, so the watchdog path is exercised too.
      const cases =
        typeof opts.bunExit === "number"
          ? `exit ${opts.bunExit}`
          : Object.entries(opts.bunExit)
              .map(([f, code]) => `case "$*" in *${f}*) echo "stub for ${f}"; exit ${code};; esac`)
              .join("\n") + "\nexit 0";
      writeFileSync(join(bin, "bun"), `#!/usr/bin/env bash\n${cases}\n`, { mode: 0o755 });

      const script = [
        "set -e",
        `source ${SETS_LIB}`,
        // Override the real sweep so the rule is tested, not the repo's
        // current file list.
        `passfail_files() { printf '%s\\n' ${opts.p.map((f) => JSON.stringify(f)).join(" ")}; }`,
        `HOST_FAILED_FILES=(${opts.failed.map((f) => JSON.stringify(f)).join(" ")})`,
        `PATH=${JSON.stringify(bin)}:$PATH`,
        "gate_host_failures",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a JS template string
        'echo "STILL_FAILED=[${STILL_FAILED[*]}]"',
      ].join("\n");
      const proc = Bun.spawnSync(["bash", "-c", script], { cwd: REPO_ROOT });
      return {
        code: proc.exitCode,
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
      };
    });
  }

  test("no failures at all → nothing still failing, nothing printed", () => {
    const r = runGate({ p: ["src/a.test.ts"], failed: [], bunExit: 1 });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("STILL_FAILED=[]");
  });

  test("a failure OUTSIDE P is tolerated and named as non-gating", () => {
    // C\P — the scoped web bun:test files, whose pass/fail home is elsewhere.
    const r = runGate({
      p: ["src/a.test.ts"],
      failed: ["web/src/__tests__/search-mode.test.ts"],
      bunExit: 1,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Failing non-gating files (TOLERATED");
    expect(r.stdout).toContain("web/src/__tests__/search-mode.test.ts");
    // Tolerated means tolerated: no re-run is even attempted for it.
    expect(r.stdout).not.toContain("Retry sweep");
    expect(r.stdout).toContain("STILL_FAILED=[]");
  });

  test("a P member that passes the isolated plain re-run is a tolerated flake", () => {
    const r = runGate({ p: ["src/a.test.ts"], failed: ["src/a.test.ts"], bunExit: 0 });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Retry sweep: 1 failed pass/fail-set (P) file(s)");
    expect(r.stdout).toContain("passed the isolated plain re-run");
    expect(r.stdout).toContain("STILL_FAILED=[]");
  });

  test("a P member that fails BOTH runs still fails — this is the verdict that was missing", () => {
    const r = runGate({ p: ["src/a.test.ts"], failed: ["src/a.test.ts"], bunExit: 1 });
    expect(r.code).toBe(0); // the function reports; the caller sets the exit code
    expect(r.stdout).toContain("STILL FAILING after isolated re-run");
    expect(r.stdout).toContain("STILL_FAILED=[src/a.test.ts]");
  });

  test("every P failure is swept, and only the still-red ones are reported", () => {
    const r = runGate({
      p: ["src/a.test.ts", "src/b.test.ts", "src/c.test.ts"],
      failed: ["src/a.test.ts", "src/b.test.ts", "src/c.test.ts", "web/src/x.test.ts"],
      bunExit: { "src/a.test.ts": 1, "src/b.test.ts": 0, "src/c.test.ts": 1 },
    });
    expect(r.stdout).toContain("Retry sweep: 3 failed pass/fail-set (P) file(s)");
    expect(r.stdout).toContain("STILL_FAILED=[src/a.test.ts src/c.test.ts]");
    expect(r.stdout).toContain("web/src/x.test.ts"); // listed as non-gating
  });
});

// ── full mode's two verdicts ────────────────────────────────────────────────
describe("test-coverage.sh: full mode reports BOTH verdicts", () => {
  const runner = Bun.file(RUNNER).text();

  /** The full-local-mode tail (everything after the shard branch closes). */
  async function fullModeTail(): Promise<string> {
    const src = await runner;
    const i = src.indexOf("# ── full local mode:");
    expect(i).toBeGreaterThan(-1);
    return src.slice(i);
  }

  test("both host-pool modes call the shared gate — neither has a private copy", async () => {
    const src = await runner;
    const calls = [...src.matchAll(/^\s*gate_host_failures\s*$/gm)];
    // One in the shard branch, one in the full-local tail.
    expect(calls.length).toBe(2);
    const shardBranch = src.indexOf('if [ -n "$SHARD_TOTAL" ]; then\n  # SHARDED CI form');
    const fullMode = src.indexOf("# ── full local mode:");
    expect(shardBranch).toBeGreaterThan(-1);
    expect((calls[0]?.index ?? -1) > shardBranch && (calls[0]?.index ?? -1) < fullMode).toBe(true);
    expect((calls[1]?.index ?? -1) > fullMode).toBe(true);
    // …and the rule itself is defined once, in the sourceable lib.
    expect(src).not.toMatch(/^gate_host_failures\(\)/m);
  });

  test("full mode's exit code is non-zero when tests failed, with its own code", async () => {
    const tail = await fullModeTail();
    // The coverage verdict keeps exit 1 so existing consumers are unchanged…
    expect(tail).toContain('if [ "$COVERAGE_FAILED" != "0" ]; then exit 1; fi');
    // …and a tests-failed run exits with the dedicated code, never 0.
    expect(tail).toMatch(
      /if \[ "\$\{#STILL_FAILED\[@\]\}" -gt 0 \]; then[\s\S]*exit "\$EXIT_TESTS_FAILED"/,
    );
  });

  test("EXIT_TESTS_FAILED is a distinct non-zero code", async () => {
    const src = await runner;
    const m = src.match(/^EXIT_TESTS_FAILED=(\d+)$/m);
    expect(
      m,
      "EXIT_TESTS_FAILED must be defined as a literal so it can't drift to 0",
    ).not.toBeNull();
    const code = Number(m?.[1]);
    expect(code).toBeGreaterThan(0);
    expect(code).not.toBe(1); // distinct from the coverage verdict
  });

  test("the failing-file list no longer calls itself 'visibility only'", async () => {
    const src = await runner;
    // The exact sentence that told a reader with red tests on screen that the
    // coverage verdict was the only one that mattered.
    expect(src).not.toContain("Failed files (visibility only");
    expect(src).not.toContain("coverage gate below is authoritative");
  });
});

// ── vitest-leg allowlist integrity ──────────────────────────────────────────
/**
 * The node/vitest leg is TWO hand-maintained allowlists that must agree: the
 * explicit test-file arguments (what RUNS) and the `--coverage.include`
 * patterns (what is MEASURED). A module is covered by this leg only when it is
 * on BOTH, and neither list is derived from the other — so a suite can be
 * thoroughly green and still report as untested.
 *
 * Two ways that goes wrong, both silent at the leg's exit code:
 *   - an include pattern that matches NOTHING (a typo, a moved file, or a
 *     SvelteKit `[param]` segment written in a form the matcher doesn't take).
 *     This is how `api/health/+server.ts` and the refresh-models handler
 *     reached CI tested-but-unmeasured in PR #97; the only downstream symptom
 *     was the patch gate's "changed source file has NO lcov data".
 *   - a listed test file that no longer exists. vitest does red on that today,
 *     but only as "no test files found" buried in a leg log — named here.
 *
 * Both checks run against the REAL command in scripts/test-coverage.sh, parsed
 * out of the file, so they cannot check a stale copy.
 */
describe("test-coverage.sh: vitest leg allowlists point at real things", () => {
  const runnerSrc = Bun.file(RUNNER).text();

  /** The `( cd web && npx vitest run … )` invocation, verbatim. */
  async function vitestBlock(): Promise<string> {
    const src = await runnerSrc;
    const start = src.indexOf("npx vitest run");
    const end = src.indexOf('> "$legs/vitest.out"', start);
    expect(start, "the vitest leg invocation moved — update this parser").toBeGreaterThan(-1);
    expect(end, "the vitest leg's output redirect moved — update this parser").toBeGreaterThan(
      start,
    );
    return src.slice(start, end);
  }

  /** Repo-relative-to-`web/` test files passed as positional args. */
  async function listedTestFiles(): Promise<string[]> {
    const block = await vitestBlock();
    return [...block.matchAll(/^\s*"?(src\/[^\s"\\]+\.test\.ts)"?\s*\\?\s*$/gm)].map(
      (m) => m[1] as string,
    );
  }

  /** The `--coverage.include='…'` patterns, in file order. */
  async function includePatterns(): Promise<string[]> {
    const block = await vitestBlock();
    return [...block.matchAll(/--coverage\.include='([^']+)'/g)].map((m) => m[1] as string);
  }

  // Every file under web/src, expressed the way the include patterns are
  // (relative to `web/`, since the leg runs with cwd=web).
  const webSrcFiles = [...new Glob("**/*").scanSync({ cwd: join(WEB_ROOT, "src") })].map(
    (p) => `src/${p.split("\\").join("/")}`,
  );

  /**
   * Match one include pattern against the tree. Bun's `Glob` reads `[id]` as a
   * character class, so a literal SvelteKit segment has to be escaped — and
   * the script already carries two patterns pre-escaped for VITEST's matcher
   * in the `[[]id]` form, which means the same literal `[id]`. Normalise that
   * back first, then escape for Bun. (See the DYNAMIC ROUTE SEGMENTS note in
   * scripts/test-coverage.sh for why the bare form is what vitest wants.)
   */
  function matchesSomething(pattern: string): boolean {
    const literal = pattern.replace(/\[\[\]/g, "[");
    const escaped = literal.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
    const glob = new Glob(escaped);
    return webSrcFiles.some((f) => glob.match(f));
  }

  test("the parser still finds both allowlists (a rewrite must not silently empty them)", async () => {
    const files = await listedTestFiles();
    const includes = await includePatterns();
    // Ratchet floors in the style of the other set-size guards: 211 test files
    // and 200 include patterns when this landed. A drop below means the parse
    // rotted or the leg was gutted — either way the two checks below would
    // pass vacuously, which is the failure mode worth catching.
    expect(files.length, "vitest leg test-file list looks truncated").toBeGreaterThanOrEqual(200);
    expect(includes.length, "vitest leg include list looks truncated").toBeGreaterThanOrEqual(190);
    expect(webSrcFiles.length).toBeGreaterThan(500);
  });

  test("every test file the vitest leg runs exists on disk", async () => {
    const missing = (await listedTestFiles()).filter((f) => !existsSync(join(WEB_ROOT, f)));
    expect(
      missing,
      `${missing.length} test file(s) are passed to the vitest coverage leg but do not ` +
        `exist under web/ — the leg dies with "no test files found" and every module ` +
        `they were the only measurer of drops out of the merged lcov:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  test("every --coverage.include pattern matches at least one file under web/", async () => {
    const dead = (await includePatterns()).filter((p) => !matchesSomething(p));
    expect(
      dead,
      `${dead.length} --coverage.include pattern(s) in scripts/test-coverage.sh match NOTHING. ` +
        `An include that matches nothing is indistinguishable from success at the leg's exit ` +
        `code — it only resurfaces downstream as the patch-coverage gate's "changed source ` +
        `file has NO lcov data" (PR #97). Fix the pattern; do not delete the ` +
        `measurement:\n  ${dead.join("\n  ")}`,
    ).toEqual([]);
  });

  test("web/src/hooks.server.ts is measured, and its suites are the leg's to run", async () => {
    // Pinned by name, unlike every other module here, because hooks.server.ts
    // is one the gate CANNOT self-diagnose. A file with an exact key in
    // coverage-thresholds.json that stops being measured fails loudly on its
    // own ("listed in thresholds but no lcov data"); hooks.server.ts has no
    // exact key, it falls under the `web/src/**` catch-all, so going
    // unmeasured produced no violation at all — it just quietly reported
    // whatever incidental number the bun host shards happened to instrument.
    // That is how nine green suites sat unmeasured, and how the last author to
    // hit it ended up porting a passing vitest suite into the bun pool to work
    // around the gate rather than fixing the leg.
    const includes = await includePatterns();
    expect(includes).toContain("src/hooks.server.ts");

    const onDisk = [
      ...new Glob("hooks-server-*.server.test.ts").scanSync({
        cwd: join(WEB_ROOT, "src/__tests__"),
      }),
    ].map((f) => `src/__tests__/${f}`);
    expect(onDisk.length).toBeGreaterThanOrEqual(9);

    const listed = new Set(await listedTestFiles());
    const unrun = onDisk.filter((f) => !listed.has(f));
    expect(
      unrun,
      `${unrun.length} hooks.server.ts suite(s) exist but the vitest coverage leg does not ` +
        `run them, so their coverage of hooks.server.ts is not measured:\n  ${unrun.join("\n  ")}`,
    ).toEqual([]);
  });
});
