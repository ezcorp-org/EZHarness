/**
 * e2e lane-manifest meta-test (wave 3, CI audit item 3.4).
 *
 * web/e2e/lanes.json assigns EVERY web/e2e/**\/*.spec.ts to exactly one
 * lane. This test keeps the manifest honest against the tree and against
 * ci.yml:
 *   - exhaustive: every on-disk spec appears in exactly ONE lane; no
 *     phantom entries for deleted specs.
 *   - marker consistency per lane (fresh-setup and real-auth each match their
 *     dedicated real-PGlite config; evidence members carry @evidence; the production-image lane is the live Docker replay target).
 *   - the blocking mock-gate list has ONE home: ci.yml derives its
 *     playwright args via scripts/e2e-lane-args.ts (anchored regexes) —
 *     asserted both at the generator level and as an invocation anchor in
 *     ci.yml itself.
 *   - there is no unwired/backlog lane: every spec is in a lane consumed by
 *     automatic CI.
 *
 * Runs in the P∩C sweep (src/__tests__ → the CI cov-shards gate it).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneArgs } from "../../scripts/e2e-lane-args.ts";
import lanesManifest from "../../web/e2e/lanes.json";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const BASH = Bun.which("bash");
const LANE_NAMES = ["mock-gate", "mock-full", "fresh-setup", "real-auth", "production-image", "evidence", "external-model"] as const;
const OPTIONAL_OPERATOR_LANES = ["external-model"] as const;

// Every browser spec is now wired to a strict CI lane. Keep lane membership
// exhaustive and unique so a new spec cannot become an unexecuted backlog
// entry by accident.
function bashLines(cmd: string): string[] {
  const proc = Bun.spawnSync(["bash", "-c", cmd], { cwd: REPO_ROOT });
  if (proc.exitCode !== 0) throw new Error(`bash failed: ${cmd}\n${proc.stderr.toString()}`);
  return proc.stdout
    .toString()
    .split("\n")
    .filter((l) => l.length > 0);
}

function ciJobBlock(ci: string, job: string): string {
  const start = ci.indexOf(`  ${job}:\n`);
  if (start < 0) return "";
	const next = ci.slice(start + 1).search(/^ {2}[A-Za-z][A-Za-z0-9-]*:\n/m);
  return next < 0 ? ci.slice(start) : ci.slice(start, start + 1 + next);
}

type LocalCiMode = "success" | "browser-failure" | "backend-failure";

type LocalCiRun = {
  code: number;
  stdout: string;
  stderr: string;
  trace: string[];
  browserReceiptDir: string;
  dispose(): void;
};

/**
 * Exercise ci-local's real shell control flow without a build, browser, or
 * test pool. The fake commands replace process boundaries only: the script
 * still creates its receipt directory, exports the receipt paths through
 * `env`, records step failures, and prints its own final summary.
 */
function runLocalCi(mode: LocalCiMode): LocalCiRun {
  if (!BASH) throw new Error("bash is required for CI shell contract tests");
  const fixture = mkdtempSync(join(tmpdir(), "ci-local-boundary-"));
  const bin = join(fixture, "bin");
  const tracePath = join(fixture, "trace.log");
  mkdirSync(bin);

  const writeExecutable = (name: string, source: string) => {
    const path = join(bin, name);
    writeFileSync(path, source, { mode: 0o700 });
  };
  writeExecutable("git", `#!${BASH}\nexit 0\n`);
  writeExecutable("bun", `#!${BASH}
printf 'bun\\t%s\\t%s\\t%s\\n' "$*" "\${BROWSER_COVERAGE_RAW:-}" "\${BROWSER_COVERAGE_LCOV:-}" >> "$CI_LOCAL_TRACE"
if [ "$1" = "run" ] && [ "$2" = "lint" ]; then printf 'Checked 1 file\\n'; fi
if [ "$1" = "run" ] && [ "$2" = "test:coverage" ]; then
  test -s "\${BROWSER_COVERAGE_RAW:-}" || exit 91
  test -s "\${BROWSER_COVERAGE_LCOV:-}" || exit 92
  [ "\${CI_LOCAL_MODE}" != "backend-failure" ] || exit 23
fi
`);
  writeExecutable("bash", `#!${BASH}
printf 'bash\\t%s\\n' "$*" >> "$CI_LOCAL_TRACE"
if [ "$1" = "scripts/run-browser-route-coverage.sh" ]; then
  printf 'browser\\t%s\\n' "\${EZCORP_BROWSER_COVERAGE_OUTPUT:-}" >> "$CI_LOCAL_TRACE"
  mkdir -p "\${EZCORP_BROWSER_COVERAGE_OUTPUT}/merged"
  if [ "\${CI_LOCAL_MODE}" = "browser-failure" ]; then
    printf 'partial receipt\\n' > "\${EZCORP_BROWSER_COVERAGE_OUTPUT}/partial.json"
    exit 17
  fi
  printf '{"raw":true}\\n' > "\${EZCORP_BROWSER_COVERAGE_OUTPUT}/merged/merged.json"
  printf 'TN:fixture\\nSF:fixture.ts\\nDA:1,1\\nend_of_record\\n' > "\${EZCORP_BROWSER_COVERAGE_OUTPUT}/merged/lcov.info"
fi
exit 0
`);

  const proc = Bun.spawnSync([BASH, "scripts/ci-local.sh"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CI_LOCAL_MODE: mode,
      CI_LOCAL_TRACE: tracePath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const trace = existsSync(tracePath) ? readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean) : [];
  const browserReceiptDir = trace.find((line) => line.startsWith("browser\t"))?.slice("browser\t".length) ?? "";
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    trace,
    browserReceiptDir,
    dispose: () => rmSync(fixture, { recursive: true, force: true }),
  };
}

const lanes = lanesManifest.lanes as Record<string, string[]>;
const onDisk = bashLines("find web/e2e -name '*.spec.ts' | sort");
const evidenceTagged = new Set(
  bashLines("grep -rl --include='*.spec.ts' '@evidence' web/e2e || true"),
);
const dockerGated = new Set(
  bashLines("grep -rl --include='*.spec.ts' 'DOCKER_TEST' web/e2e || true"),
);

describe("e2e lane manifest", () => {
  test("lane set is exactly the known lanes", () => {
    expect(Object.keys(lanes).sort()).toEqual([...LANE_NAMES].sort());
  });

  test("exhaustive + unique: every on-disk spec in exactly one lane, no phantom entries", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const lane of LANE_NAMES) {
      for (const f of lanes[lane]!) {
        if (seen.has(f)) dupes.push(`${f} (${seen.get(f)} + ${lane})`);
        seen.set(f, lane);
      }
    }
    expect(dupes, `spec(s) in two lanes:\n  ${dupes.join("\n  ")}`).toEqual([]);

    const onDiskSet = new Set(onDisk);
    const missing = onDisk.filter((f) => !seen.has(f));
    const phantom = [...seen.keys()].filter((f) => !onDiskSet.has(f));
    expect(
      missing,
      `spec(s) missing from web/e2e/lanes.json — assign each new spec to an automatic CI lane:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
    expect(phantom, `manifest entries for deleted specs — remove:\n  ${phantom.join("\n  ")}`).toEqual([]);
  });

  test("real-auth config collects exactly its manifest lane", () => {
    const proc = Bun.spawnSync(
      ["bunx", "playwright", "test", "--config", "playwright.real.config.ts", "--list", "--reporter=list"],
      { cwd: join(REPO_ROOT, "web"), stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    // Playwright prints paths relative to testDir, so root-level lane members
    // appear as `goal-feature.spec.ts` while directory members retain their
    // `real-auth/` prefix. Restore the manifest's web-relative form here.
    const collected = [...proc.stdout.toString().matchAll(/›\s+([^\s:]+\.spec\.ts)(?=:\d+:)/g)].map(
      (match) => `web/e2e/${match[1]}`,
    );
    expect(collected.length, proc.stdout.toString()).toBeGreaterThan(0);
    expect([...new Set(collected)].sort()).toEqual(lanes["real-auth"]!.slice().sort());
  }, 120_000);

  test("container-backed CLI acceptance runs only in the runner-ready real-auth lane", async () => {
    const cliAcceptance = "web/e2e/deterministic-ext-gate.spec.ts";
    expect(lanes["mock-full"]).not.toContain(cliAcceptance);
    expect(lanes["real-auth"]).toContain(cliAcceptance);

    const ci = await Bun.file(join(REPO_ROOT, ".github/workflows/ci.yml")).text();
    const realAuth = ciJobBlock(ci, "e2e-real-auth");
    expect(realAuth).toContain("scripts/setup-extension-runner-ci.sh --install");
    expect(realAuth).toContain("collect-browser-route-coverage-lane.sh real-auth");
  });

  test("fresh-setup config collects the manifest in the state-safe order", () => {
    const proc = Bun.spawnSync(
      ["bunx", "playwright", "test", "--config", "playwright.fresh-setup.config.ts", "--list", "--reporter=list"],
      { cwd: join(REPO_ROOT, "web"), stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const collected = [...proc.stdout.toString().matchAll(/›\s+([^\s:]+\.spec\.ts)(?=:\d+:)/g)].map(
      (match) => `web/e2e/${match[1]}`,
    );
    const orderedFiles = collected.filter((path, index) => collected.indexOf(path) === index);
    expect(orderedFiles, proc.stdout.toString()).toEqual(lanes["fresh-setup"]);
  }, 120_000);

  test("real preview clears inherited alternate DB and mock-init modes", () => {
    const probe = [
      'import config from "./web/playwright.real.config.ts";',
      "const server = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;",
      "console.log(JSON.stringify(server.env));",
    ].join(" ");
    const proc = Bun.spawnSync([process.execPath, "-e", probe], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PI_E2E_REAL_DB_PATH: "/tmp/ezcorp-e2e-config-contract",
        DATABASE_URL: "postgres://test:test@127.0.0.1:1/unused_audit_probe",
        PI_SKIP_INIT: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const env = JSON.parse(proc.stdout.toString()) as Record<string, string>;
    expect(env.DATABASE_URL).toBe("");
    expect(env.PI_SKIP_INIT).toBe("");
    expect(env.EZCORP_DB_PATH).toBe("/tmp/ezcorp-e2e-config-contract");
  });

  test("evidence members all carry @evidence", () => {
    const untagged = lanes.evidence!.filter((f) => !evidenceTagged.has(f));
    expect(untagged, `evidence entries without @evidence:\n  ${untagged.join("\n  ")}`).toEqual([]);
  });

  test("there is no unwired browser backlog", () => {
    expect(Object.hasOwn(lanes, "unwired")).toBe(false);
    expect(lanes["mock-full"]!.length).toBeGreaterThan(0);
  });

  test("production-image lane owns exactly the Docker-backed File Organizer replay", async () => {
    const production = ["web/e2e/file-organizer-real.spec.ts"];
    expect(lanes["production-image"]).toEqual(production);
    expect(production.every((path) => dockerGated.has(path))).toBe(true);

    const replay = await Bun.file(
      join(REPO_ROOT, "docs/validation/extension-v4-flows/runtime/replay-file-organizer-runtime.sh"),
    ).text();
    expect(replay).toContain("DOCKER_TEST=1");
    expect(replay).toContain("playwright test e2e/file-organizer-real.spec.ts --project=chromium");

    // The default config must keep this production-only journey out of the
    // mock preview, but its Docker mode must still collect the real target.
    // `--list` loads the actual config and source without starting a browser
    // or mutating a container.
    const collector = Bun.spawnSync(
      ["bunx", "playwright", "test", "e2e/file-organizer-real.spec.ts", "--list", "--reporter=list"],
      {
        cwd: join(REPO_ROOT, "web"),
        env: {
          ...process.env,
          DOCKER_TEST: "1",
          DOCKER_TEST_URL: "http://127.0.0.1:3000",
          EZCORP_APP_CONTAINER: "lane-contract-owned-container",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(collector.exitCode, collector.stderr.toString()).toBe(0);
    expect(collector.stdout.toString()).toContain("file-organizer real-backend");
  }, 120_000);

  test("mock-gate args generator emits one anchored web-relative regex per member", () => {
    const args = laneArgs(lanes, "mock-gate");
    expect(args.length).toBe(lanes["mock-gate"]!.length);
    for (const a of args) {
      expect(a.startsWith("e2e/")).toBe(true);
      expect(a.endsWith("\\.spec\\.ts$")).toBe(true);
    }
    // The historical substring trap: `hub.spec.ts` must NOT match
    // github-projects-hub.spec.ts / project-hub.spec.ts.
    const hub = args.find((a) => a.includes("/hub"));
    expect(hub).toBe("e2e/hub\\.spec\\.ts$");
    expect(new RegExp(hub!).test("e2e/github-projects-hub.spec.ts")).toBe(false);
    expect(new RegExp(hub!).test("e2e/project-hub.spec.ts")).toBe(false);
    expect(new RegExp(hub!).test("e2e/hub.spec.ts")).toBe(true);
  });

  test("mock and real configs partition the manifest exactly", () => {
    // The two configs share one e2e tree. The real config's manifest-derived
    // match deliberately includes root-level real journeys; without the mock
    // config's `testIgnore`, its normal collection sweeps those real specs in.
    // The mock preview boots without PI_E2E_REAL=1, so isTestSurfaceEnabled()
    // fail-closes and each real test-surface route returns 404.
    //
    // This drives Playwright's mock collector rather than asserting on config
    // text: `--list` loads spec files but launches no browser, and both CI
    // jobs that run this file install @playwright/test.
    //
    // CI gives each lane an explicit anchored file list from the manifest;
    // this collection check prevents an unscoped local mock invocation from
    // silently changing that partition.
    const proc = Bun.spawnSync(["bunx", "playwright", "test", "--list", "--reporter=list", "--project=chromium"], {
      cwd: join(REPO_ROOT, "web"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString();
    // Not vacuous: a config error or a failed collection would print nothing
    // and make the real-auth check below trivially true.
    expect(out, `playwright --list produced no test listing:\n${proc.stderr.toString()}`).toMatch(
      /Total: \d+ tests? in \d+ files?/,
    );

    const collected = [...out.matchAll(/›\s+([^\s:]+\.spec\.ts)(?=:\d+:)/g)].map(
      (match) => `web/e2e/${match[1]}`,
    );
    const expectedMock = ["mock-gate", "mock-full", "evidence"].flatMap((lane) => lanes[lane]!);
    expect(collected.length, out).toBeGreaterThan(0);
    expect([...new Set(collected)].sort()).toEqual(expectedMock.slice().sort());

    // The remaining files are reachable through the dedicated real configs,
    // not merely absent from mock collection.
    expect(lanes["fresh-setup"]!.length).toBeGreaterThan(0);
    expect(lanes["real-auth"]!.length).toBeGreaterThan(0);
  }, 120_000);

  test("hosted and local CI Bun file commands name existing modules", async () => {
    const commandSources = [".github/workflows/ci.yml", "scripts/ci-local.sh"];
    for (const source of commandSources) {
      const text = await Bun.file(join(REPO_ROOT, source)).text();
      const modules = [...text.matchAll(/\bbun\s+((?:scripts|web)\/[A-Za-z0-9_./-]+\.ts)/g)].map(
        (match) => match[1]!,
      );
      expect(modules.length, `${source} has no explicit Bun file commands`).toBeGreaterThan(0);
      const missing = modules.filter((module) => !existsSync(join(REPO_ROOT, module)));
      expect(missing, `${source} invokes missing Bun module(s): ${missing.join(", ")}`).toEqual([]);
    }
  });

  test("ci.yml consumes the manifest via the generator (one home for the gate list)", async () => {
    const ci = await Bun.file(join(REPO_ROOT, ".github/workflows/ci.yml")).text();
    const collector = await Bun.file(join(REPO_ROOT, "scripts/collect-browser-route-coverage-lane.sh")).text();
    const localCoverage = await Bun.file(join(REPO_ROOT, "scripts/run-browser-route-coverage.sh")).text();
    const merger = await Bun.file(join(REPO_ROOT, "scripts/merge-browser-route-coverage.sh")).text();
    for (const lane of ["mock-gate", "mock-full", "evidence"]) {
      expect(collector).toContain(`bun scripts/e2e-lane-args.ts "$lane"`);
      expect(ci).toContain(`collect-browser-route-coverage-lane.sh ${lane}`);
    }
    expect(ci).toContain("collect-browser-route-coverage-lane.sh fresh-setup");
    expect(ci).toContain("collect-browser-route-coverage-lane.sh real-auth");
    expect(collector).toContain('bun scripts/run-real-e2e.ts "$lane"');
    const evidenceCollector = collector.split("  evidence)")[1]?.split("    ;;")[0] ?? "";
    expect(evidenceCollector).toContain('bun scripts/check-playwright-evidence-blob.ts "$repo_root/web/blob-report"');
    expect(evidenceCollector).not.toContain("--reporter=list");
    expect(collector).toContain("EZCORP_BROWSER_COVERAGE_SOURCE_REVISION");
    expect(collector).toContain('git -C "$repo_root" rev-parse HEAD');
    // Local route coverage must exercise the same mandatory lane set and
    // strict aggregation path as CI. A mock-only receipt cannot establish
    // the 64-route browser floor because authenticated and fresh journeys
    // execute routes the mock preview cannot reach.
    expect(localCoverage).toContain("for lane in mock-gate mock-full evidence fresh-setup real-auth; do");
    expect(localCoverage).toContain('collect-browser-route-coverage-lane.sh "$lane"');
    expect(localCoverage).toContain("EZCORP_E2E_EVIDENCE=1");
    // Each lane must save its own failure diagnostics before the next
    // Playwright invocation replaces web/test-results.
    expect(localCoverage).toContain('archive_playwright_artifacts "$lane_output" "$lane"');
    expect(localCoverage).toContain('cp -a "$repo_root/web/test-results/." "$artifact_dir/test-results/"');
    expect(localCoverage).toContain('if [ "$lane" = evidence ] && [ -d "$repo_root/web/blob-report" ]; then');
    expect(localCoverage).toContain('merge-browser-route-coverage.sh "$output_dir" "$output_dir/merged"');
    expect(ci).toContain("merge-browser-route-coverage.sh");
    expect(merger).toContain("required_lanes=(mock-gate mock-full evidence real-auth/fresh-setup real-auth/real-auth)");
    expect(merger).toContain("verify-browser-coverage-receipt.ts");
    // The old hand-listed spec regexes must not resurface beside it.
    expect(ci).not.toMatch(/e2e\/file-organizer-hub\\.spec\\.ts/);
  });

  test("browser consumers restore the complete one-build SvelteKit preview artifact", async () => {
    const ci = await Bun.file(join(REPO_ROOT, ".github/workflows/ci.yml")).text();
    const transfer = await Bun.file(join(REPO_ROOT, "scripts/verify-browser-build-transfer.sh")).text();
    const build = ciJobBlock(ci, "browser-coverage-build");
    expect(build).toContain("web/build/");
    expect(build).toContain("web/.svelte-kit/output/");
    expect(build).toContain("include-hidden-files: true");
    expect(build).toContain("verify-browser-build-transfer.sh --round-trip-preview");

    for (const job of ["e2e-mock-run", "e2e-mock-full", "e2e-evidence", "e2e-real-auth", "browser-route-coverage"]) {
      const block = ciJobBlock(ci, job);
      expect(block, `missing CI job: ${job}`).toContain("verify-browser-build-transfer.sh --check");
    }
    expect(transfer).toContain("build .svelte-kit/output");
    expect(transfer).toContain(".svelte-kit/output/server");
    expect(transfer).toContain("bun run preview");
  });

  test("local full coverage consumes one verified browser receipt without repeating its lanes or V8 build", async () => {
    const local = await Bun.file(join(REPO_ROOT, "scripts/ci-local.sh")).text();
    const syntax = Bun.spawnSync(["bash", "-n", "scripts/ci-local.sh"], { cwd: REPO_ROOT, stderr: "pipe" });
    expect(syntax.exitCode, syntax.stderr.toString()).toBe(0);

    const fullStart = local.indexOf('if [ "$FAST" = "0" ]; then');
    const browserReceipt = local.indexOf("bash scripts/run-browser-route-coverage.sh", fullStart);
    const coverage = local.indexOf("bun run test:coverage", fullStart);
    const browserStep = local.indexOf('run_step "Browser route coverage', fullStart);
    expect(fullStart).toBeGreaterThan(-1);
    expect(browserReceipt).toBeGreaterThan(fullStart);
    expect(coverage).toBeGreaterThan(browserReceipt);
    expect((local.match(/bash scripts\/run-browser-route-coverage\.sh/g) ?? [])).toHaveLength(1);
    const browserCommand = local.slice(fullStart, coverage);
    expect(browserCommand).toContain('EZCORP_BROWSER_COVERAGE_OUTPUT="$BROWSER_COVERAGE_OUTPUT"');
    expect(browserStep).toBeLessThan(browserReceipt);
    const coverageCommand = local.slice(local.lastIndexOf('run_step "Coverage + per-file thresholds"', coverage), local.indexOf("# Both diff gates", coverage));
    expect(coverageCommand).toContain('BROWSER_COVERAGE_RAW="$BROWSER_COVERAGE_OUTPUT/merged/merged.json"');
    expect(coverageCommand).toContain('BROWSER_COVERAGE_LCOV="$BROWSER_COVERAGE_OUTPUT/merged/lcov.info"');

    const full = local.slice(fullStart);
    // The receipt collector owns mock-gate, mock-full, evidence, fresh setup,
    // and real auth. Re-running any individual lane creates a second build or
    // a receipt from a different build identity.
    expect(full).not.toContain("scripts/e2e-lane-args.ts");
    expect(full).not.toContain("scripts/run-real-e2e.ts");
    // Full coverage runs the Node/V8 suite; the plain Vitest suite and build
    // remain fast-mode checks only.
    const fastStart = local.indexOf('if [ "$FAST" = "1" ]; then');
    expect(fastStart).toBeGreaterThan(-1);
    expect(fastStart).toBeLessThan(fullStart);
    const fast = local.slice(fastStart, fullStart);
    expect(fast).toContain("npx vitest run");
    expect(fast).toContain("bun run build");
    expect(full).not.toContain("npx vitest run");
    expect(full).not.toContain("bun run build");
  });

  test("local CI command passes one browser receipt to coverage and removes it after success", () => {
    const run = runLocalCi("success");
    try {
      expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain("PASS  Browser route coverage (mandatory Chromium lanes)");
      expect(run.stdout).toContain("PASS  Coverage + per-file thresholds");
      expect(run.stdout).toContain("ci-local: all executed gates PASSED.");
      expect(run.trace.filter((line) => line.startsWith("browser\t"))).toHaveLength(1);
      const bashCalls = run.trace.filter((line) => line.startsWith("bash\t"));
      expect(bashCalls).toContain("bash\t-c cd web && bun test ./src/__tests__/route-contract.test.ts");
      expect(bashCalls).toContain("bash\tscripts/test-web.sh");
      expect(bashCalls).toContain("bash\t-c cd web && bun run check");
      expect(bashCalls).toContain("bash\tscripts/run-browser-route-coverage.sh");
      const coverage = run.trace.filter((line) => line.startsWith("bun\trun test:coverage\t"));
      expect(coverage).toEqual([
        `bun\trun test:coverage\t${run.browserReceiptDir}/merged/merged.json\t${run.browserReceiptDir}/merged/lcov.info`,
      ]);
      expect(bashCalls.some((line) => line.includes("npx vitest run"))).toBe(false);
      expect(bashCalls.some((line) => line.includes("bun run build"))).toBe(false);
      expect(existsSync(run.browserReceiptDir)).toBe(false);
    } finally {
      run.dispose();
    }
  });

  test("local CI command fails and retains browser receipts when collection fails", () => {
    const run = runLocalCi("browser-failure");
    try {
      expect(run.code).toBe(1);
      expect(run.stdout).toContain("FAIL  Browser route coverage (mandatory Chromium lanes)");
      expect(run.stdout).toContain("FAIL  Coverage + per-file thresholds");
      expect(run.stdout).toContain("ci-local: FAILED");
      expect(run.stderr).toContain(`retained browser coverage receipts after failed run: ${run.browserReceiptDir}`);
      expect(readFileSync(join(run.browserReceiptDir, "partial.json"), "utf8")).toContain("partial receipt");
    } finally {
      run.dispose();
      rmSync(run.browserReceiptDir, { recursive: true, force: true });
    }
  });

  test("local CI command retains a valid browser receipt when backend coverage fails", () => {
    const run = runLocalCi("backend-failure");
    try {
      expect(run.code).toBe(1);
      expect(run.stdout).toContain("PASS  Browser route coverage (mandatory Chromium lanes)");
      expect(run.stdout).toContain("FAIL  Coverage + per-file thresholds");
      expect(run.stdout).toContain("ci-local: FAILED");
      expect(run.stderr).toContain(`retained browser coverage receipts after failed run: ${run.browserReceiptDir}`);
      expect(readFileSync(join(run.browserReceiptDir, "merged/merged.json"), "utf8")).toContain('"raw":true');
    } finally {
      run.dispose();
      rmSync(run.browserReceiptDir, { recursive: true, force: true });
    }
  });

  test("every standard browser lane is a hard CI dependency", async () => {
    const ci = await Bun.file(join(REPO_ROOT, ".github/workflows/ci.yml")).text();
    const jobs = [
      ["e2e-mock-run", "mock-gate"],
      ["e2e-mock-full", "mock-full"],
      ["e2e-evidence", "evidence"],
    ] as const;

    for (const [job, lane] of jobs) {
      const block = ciJobBlock(ci, job);
      expect(block, `missing CI job: ${job}`).not.toBe("");
      expect(block).toContain(`collect-browser-route-coverage-lane.sh ${lane}`);
      expect(block).not.toContain("continue-on-error: true");
    }

    const production = ciJobBlock(ci, "production-image-file-organizer");
    expect(production, "missing CI job: production-image-file-organizer").not.toBe("");
    expect(production).toContain("bash scripts/verify-shipping-production-suite.sh");
    expect(production).not.toContain("continue-on-error: true");

    const shipping = await Bun.file(join(REPO_ROOT, "scripts/verify-shipping-production-suite.sh")).text();
    expect(shipping).toContain("replay-file-organizer-runtime.sh");

	const engines = ciJobBlock(ci, "extension-browser-engines");
	expect(engines, "missing CI job: extension-browser-engines").not.toBe("");
	expect(engines).toContain("e2e/bottom-sheet-pickers.spec.ts");
	expect(engines).toContain("--config playwright.reuse-mock.config.ts");
	expect(engines).toContain("--project=");
	expect(engines).toContain("matrix.browser");
	const reuseConfig = join(REPO_ROOT, "web/playwright.reuse-mock.config.ts");
	expect(existsSync(reuseConfig), "engine CI config must be present in a clean checkout").toBe(true);
	const reuseConfigSource = await Bun.file(reuseConfig).text();
	expect(reuseConfigSource).toContain("bun build/index.js");
	expect(reuseConfigSource).toContain("HOST=127.0.0.1");
	expect(reuseConfigSource).toContain("PI_SKIP_INIT=1");
	expect(reuseConfigSource).toContain("EZCORP_PREVIEW_APP_HOST=localhost");
	expect(reuseConfigSource).not.toContain("bun run preview");
	const trackedConfig = Bun.spawnSync(["git", "ls-files", "--error-unmatch", "web/playwright.reuse-mock.config.ts"], {
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(trackedConfig.exitCode, trackedConfig.stderr.toString()).toBe(0);
	const mockConfig = await Bun.file(join(REPO_ROOT, "web/playwright.config.ts")).text();
	expect(mockConfig).not.toContain('{ name: "firefox", use: { browserName: "firefox" } }');
	expect(mockConfig).not.toContain('{ name: "webkit", use: { browserName: "webkit" } }');
	const collected = Bun.spawnSync(
		[
			"bunx",
			"playwright",
			"test",
			"--config",
			"playwright.reuse-mock.config.ts",
			"--project=firefox",
			"--list",
			"e2e/bottom-sheet-pickers.spec.ts",
		],
		{ cwd: join(REPO_ROOT, "web"), stdout: "pipe", stderr: "pipe" },
	);
	expect(collected.exitCode, collected.stderr.toString()).toBe(0);
	expect(collected.stdout.toString()).toContain("bottom-sheet");

    const aggregate = ciJobBlock(ci, "e2e-mock");
    for (const [job] of jobs) expect(aggregate).toContain(job);
    expect(aggregate).toContain("production-image-file-organizer");
    expect(aggregate).toContain("extension-browser-engines");
    expect(aggregate).toContain('result }}" != success');
  });

  test("external Kokoro model lane has an explicit manual CI consumer", async () => {
    expect(OPTIONAL_OPERATOR_LANES).toEqual(["external-model"]);
    expect(lanes["external-model"]).toEqual(["web/e2e/kokoro-tts-realmodel.spec.ts"]);
    const runner = join(REPO_ROOT, "scripts/run-kokoro-realmodel-e2e.sh");
    expect(existsSync(runner)).toBe(true);
    expect(bashLines("bash scripts/run-kokoro-realmodel-e2e.sh >/dev/null 2>&1; echo $? ")[0]).toBe("2");
    const source = await Bun.file(runner).text();
    expect(source).toContain('EZCORP_E2E_KOKORO_REAL=1');
    expect(source).toContain("playwright.kokoro-real.config.ts");

    const collected = Bun.spawnSync(
      ["bunx", "playwright", "test", "--config", "playwright.kokoro-real.config.ts", "--project=chromium", "--list"],
      { cwd: join(REPO_ROOT, "web"), stdout: "pipe", stderr: "pipe" },
    );
    expect(collected.exitCode, collected.stderr.toString()).toBe(0);
    expect(collected.stdout.toString()).toContain("kokoro-tts-realmodel.spec.ts");
    expect(collected.stdout.toString()).toContain("Total: 1 test in 1 file");

    const workflow = await Bun.file(join(REPO_ROOT, ".github/workflows/kokoro-real-model.yml")).text();
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("run_external_kokoro:");
    const job = ciJobBlock(workflow, "external-kokoro-real-model");
    expect(job, "missing external Kokoro workflow job").not.toBe("");
    expect(job).toContain("if: inputs.run_external_kokoro");
    expect(job).toContain('EZCORP_E2E_KOKORO_REAL: "1"');
    expect(job).toContain("bash scripts/run-kokoro-realmodel-e2e.sh");
    expect(job).not.toContain("continue-on-error: true");
  });
});
