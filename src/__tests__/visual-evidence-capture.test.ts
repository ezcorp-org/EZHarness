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

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), "visual-evidence-capture-"));
  roots.push(root);
  const scriptDir = join(root, "scripts", "visual-evidence");
  const binDir = join(root, "bin");
  mkdirSync(join(root, "web"), { recursive: true });
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

function runCapture(specs: string, env: Record<string, string> = {}, seedStaleReport = false) {
  const { root, script, binDir } = makeSandbox();
  const specsFile = join(root, "selected.txt");
  const log = join(root, "playwright.log");
  writeFileSync(specsFile, specs);
  if (seedStaleReport) {
    const staleReport = join(root, "web/blob-report/report-from-ordinary-playwright.zip");
    mkdirSync(join(root, "web/blob-report"), { recursive: true });
    writeFileSync(staleReport, "stale");
  }
  const proc = Bun.spawnSync(["bash", script, specsFile], {
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
});
