/**
 * Integration tests for scripts/visual-evidence/capture.sh.
 *
 * A stub bunx records each Playwright command and writes the blob reporter's
 * requested output name. This proves real-auth evidence cannot be swallowed by
 * the mock config, selected one-tier runs stay narrow, failures reach CI, and
 * both report files survive a mixed or __ALL__ capture.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CAPTURE_SOURCE = join(REPO_ROOT, "scripts/visual-evidence/capture.sh");
const CI_WORKFLOW = join(REPO_ROOT, ".github/workflows/ci.yml");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeSandbox(withLanes: boolean | "no-real-auth-lane" = true) {
  const root = mkdtempSync(join(tmpdir(), "visual-evidence-capture-"));
  roots.push(root);
  const scriptDir = join(root, "scripts", "visual-evidence");
  const binDir = join(root, "bin");
  mkdirSync(join(root, "web", "e2e"), { recursive: true });
  if (withLanes) {
    // Same shape as web/e2e/lanes.json. `root-real` stands in for the eight
    // real-auth journeys that live at the e2e/ ROOT (chip-reorder, ...):
    // the tier must come from lane membership, not from the path prefix.
    const lanes: Record<string, string[]> = { "mock-full": ["web/e2e/mock.spec.ts"] };
    if (withLanes === true) lanes["real-auth"] = ["web/e2e/real-auth/real.spec.ts", "web/e2e/root-real.spec.ts"];
    writeFileSync(join(root, "web", "e2e", "lanes.json"), JSON.stringify({ lanes }, null, 2));
  }
  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const script = join(scriptDir, "capture.sh");
  writeFileSync(script, readFileSync(CAPTURE_SOURCE));
  chmodSync(script, 0o755);

  const bunx = join(binDir, "bunx");
  writeFileSync(
    bunx,
    `#!/usr/bin/env bash
set -eu
printf '%s|%s|%s|%s\\n' "$PWD" "$PLAYWRIGHT_BLOB_OUTPUT_NAME" "\${PI_E2E_REAL:-}" "$*" >> "$VISUAL_CAPTURE_LOG"
mkdir -p "$PLAYWRIGHT_BLOB_OUTPUT_DIR"
printf report > "$PLAYWRIGHT_BLOB_OUTPUT_DIR/$PLAYWRIGHT_BLOB_OUTPUT_NAME"
if [ "\${FAIL_REPORT:-}" = "$PLAYWRIGHT_BLOB_OUTPUT_NAME" ]; then exit "\${FAIL_CODE:-23}"; fi
`,
  );
  chmodSync(bunx, 0o755);

  const bun = join(binDir, "bun");
  writeFileSync(
    bun,
    `#!/usr/bin/env bash
set -eu
printf '%s|%s|%s|%s\\n' "$PWD" "$PLAYWRIGHT_BLOB_OUTPUT_NAME" "\${PI_E2E_REAL:-}" "$*" >> "$VISUAL_CAPTURE_LOG"
mkdir -p "$PLAYWRIGHT_BLOB_OUTPUT_DIR"
printf report > "$PLAYWRIGHT_BLOB_OUTPUT_DIR/$PLAYWRIGHT_BLOB_OUTPUT_NAME"
if [ "\${FAIL_REPORT:-}" = "$PLAYWRIGHT_BLOB_OUTPUT_NAME" ]; then exit "\${FAIL_CODE:-23}"; fi
`,
  );
  chmodSync(bun, 0o755);
  return { root, script, binDir };
}

function runCapture(
  specs: string,
  env: Record<string, string> = {},
  seedStaleReport = false,
  args: string[] = [],
  withLanes: boolean | "no-real-auth-lane" = true,
) {
  const { root, script, binDir } = makeSandbox(withLanes);
  const specsFile = join(root, "selected.txt");
  const log = join(root, "playwright.log");
  writeFileSync(specsFile, specs);
  if (seedStaleReport) {
    const staleReport = join(root, "web/blob-report/report-from-ordinary-playwright.zip");
    mkdirSync(join(root, "web/blob-report"), { recursive: true });
    writeFileSync(staleReport, "stale");
  }
  const proc = Bun.spawnSync(["bash", script, ...args, specsFile], {
    cwd: root,
    env: {
      ...process.env,
      // The mock invocation must clear this inherited real-auth flag.
      PI_E2E_REAL: "1",
      PATH: `${binDir}:${process.env.PATH}`,
      VISUAL_CAPTURE_LOG: log,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    root,
    code: proc.exitCode,
    stderr: proc.stderr.toString(),
    lines: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [],
  };
}

describe("visual-evidence capture", () => {
  test("CI delegates selected evidence to the tier-aware helper", () => {
    expect(readFileSync(CI_WORKFLOW, "utf8")).toContain(
      'bash scripts/visual-evidence/capture.sh "$SPECS_FILE"',
    );
  });

  test("routes mixed selected specs to both configs and retains both flat reports", () => {
    const result = runCapture("e2e/mock\\.spec\\.ts\ne2e/real-auth/real\\.spec\\.ts\n", {}, true);

    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toContain("mock-evidence.zip|0|playwright test --config playwright.config.ts --project=chromium --grep @evidence e2e/mock\\.spec\\.ts");
    expect(result.lines[1]).toContain("real-auth-evidence.zip|1|scripts/run-real-e2e.ts real-auth --project=chromium --grep @evidence e2e/real-auth/real\\.spec\\.ts");
    expect(existsSync(join(result.root, "web/blob-report/mock-evidence.zip"))).toBe(true);
    expect(existsSync(join(result.root, "web/blob-report/real-auth-evidence.zip"))).toBe(true);
    expect(existsSync(join(result.root, "web/blob-report/report-from-ordinary-playwright.zip"))).toBe(false);
  });

  test.each([
    ["mock", "e2e/mock\\.spec\\.ts\n", "--config playwright.config.ts", "mock-evidence.zip"],
    ["real-auth", "e2e/real-auth/real\\.spec\\.ts\n", "scripts/run-real-e2e.ts real-auth", "real-auth-evidence.zip"],
  ])("runs only the selected %s tier", (_tier, specs, command, report) => {
    const result = runCapture(specs);

    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain(`|${report}|`);
    expect(result.lines[0]).toContain(command);
    const otherReport = report === "mock-evidence.zip" ? "real-auth-evidence.zip" : "mock-evidence.zip";
    expect(existsSync(join(result.root, "web/blob-report", otherReport))).toBe(false);
  });

  test.each([
    ["mock-evidence.zip", 17],
    ["real-auth-evidence.zip", 19],
  ])("returns the actual failing tier status while retaining the other tier report", (failedReport, code) => {
    const result = runCapture("__ALL__\n", { FAIL_REPORT: failedReport, FAIL_CODE: String(code) });

    expect(result.code).toBe(code);
    expect(result.lines).toHaveLength(2);
    expect(existsSync(join(result.root, "web/blob-report/mock-evidence.zip"))).toBe(true);
    expect(existsSync(join(result.root, "web/blob-report/real-auth-evidence.zip"))).toBe(true);
  });

  test("runs both tiers for the __ALL__ fallback", () => {
    const result = runCapture("__ALL__\n");

    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toEndWith("--grep @evidence");
    expect(result.lines[1]).toEndWith("--grep @evidence");
  });

  test("tiers a root-level real-auth lane member by lanes.json, not by path prefix", () => {
    const result = runCapture("e2e/root-real\\.spec\\.ts\n");

    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain("real-auth-evidence.zip|1|scripts/run-real-e2e.ts real-auth --project=chromium --grep @evidence e2e/root-real\\.spec\\.ts");
    expect(existsSync(join(result.root, "web/blob-report/real-auth-evidence.zip"))).toBe(true);
    expect(existsSync(join(result.root, "web/blob-report/mock-evidence.zip"))).toBe(false);
  });

  test.each([
    ["a root-level real-auth member", "e2e/root-real\\.spec\\.ts\n", 0],
    ["a directory real-auth member", "e2e/real-auth/real\\.spec\\.ts\n", 0],
    ["a mixed selection", "e2e/mock\\.spec\\.ts\ne2e/root-real\\.spec\\.ts\n", 0],
    ["the __ALL__ fallback", "__ALL__\n", 0],
    ["a mock-only selection", "e2e/mock\\.spec\\.ts\n", 1],
    ["the __NONE__ sentinel", "__NONE__\n", 1],
  ])("--has-real-auth answers for %s without running anything", (_label, specs, code) => {
    const result = runCapture(specs, {}, false, ["--has-real-auth"]);

    expect(result.code).toBe(code);
    expect(result.lines).toHaveLength(0);
    expect(existsSync(join(result.root, "web/blob-report"))).toBe(false);
  });

  test.each([
    ["a missing manifest", false as const, "lane manifest missing"],
    ["a manifest without a real-auth lane", "no-real-auth-lane" as const, 'no "real-auth" lane found'],
  ])("--has-real-auth exits 2, not 1, for %s", (_label, withLanes, message) => {
    const result = runCapture("e2e/mock\\.spec\\.ts\n", {}, false, ["--has-real-auth"], withLanes);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.lines).toHaveLength(0);
  });

  test("the awk lane parser agrees with the real lanes.json", () => {
    // The sandbox above proves the routing; this proves the parser still reads
    // the committed manifest. `--has-real-auth` returns before the blob dir is
    // touched, so running the real script in the real repo writes nothing.
    const dir = mkdtempSync(join(tmpdir(), "lanes-query-"));
    roots.push(dir);
    const ask = (spec: string) => {
      const file = join(dir, "selection.txt");
      writeFileSync(file, `${spec}\n`);
      return Bun.spawnSync(["bash", CAPTURE_SOURCE, "--has-real-auth", file], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" }).exitCode;
    };
    expect(ask("e2e/chip-reorder\\.spec\\.ts")).toBe(0);
    expect(ask("e2e/real-auth/auth-fixture\\.spec\\.ts")).toBe(0);
    expect(ask("e2e/theme-sidebar\\.spec\\.ts")).toBe(1);
  });

  test("CI installs the extension runner from the same lane answer", () => {
    expect(readFileSync(CI_WORKFLOW, "utf8")).toContain(
      'bash scripts/visual-evidence/capture.sh --has-real-auth "$SPECS_FILE"',
    );
  });

  test.each([
    ["the lane manifest is missing", false as const, "lane manifest missing"],
    ["the manifest has no real-auth lane", "no-real-auth-lane" as const, 'no "real-auth" lane found'],
  ])("fails closed when %s", (_label, withLanes, message) => {
    const result = runCapture("e2e/mock\\.spec\\.ts\n", {}, false, [], withLanes);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.lines).toHaveLength(0);
  });
});
