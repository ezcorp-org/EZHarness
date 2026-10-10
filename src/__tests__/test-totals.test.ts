/**
 * Coverage producers print their test totals to their own stdout (scripts/lib/test-totals.sh), in a shape
 * the shared zero-test counter reads: node's "ℹ tests N" lines, or "  N pass | M fail | …". Before this,
 * factory-orchestrator-coverage.sh left its count only in the spec reporter's file and security-coverage.sh
 * printed a shard's output only on failure, so a green run of either read as "zero tests ran"
 * (W18c final measurement, 2026-09-27).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const bash = Bun.which("bash")!;

function summary(fn: string, args: string[]) {
  const proc = Bun.spawnSync([bash, "-c", `. scripts/lib/test-totals.sh; ${fn} "$@"`, "_", ...args], { cwd: REPO_ROOT });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

describe("coverage producers print their totals to their own stdout", () => {
  test("node: the spec reporter's totals are copied to stdout, and a missing report is named", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-totals-"));
    try {
      const report = join(dir, "test-progress.log");
      writeFileSync(report, "✔ a (1ms)\nℹ tests 91\nℹ suites 10\nℹ pass 90\nℹ fail 0\nℹ cancelled 1\n");
      const printed = summary("print_node_totals", [report]);
      expect(printed.code).toBe(0);
      // A test that hit --test-timeout, or a run the inner timeout ended, counts as cancelled, not failed (W4H-21).
      expect(printed.out).toBe("ℹ tests 91\nℹ pass 90\nℹ fail 0\nℹ cancelled 1\n");
      const missing = summary("print_node_totals", [join(dir, "absent.log")]);
      expect(missing.out).toBe("");
      expect(missing.err).toContain("is missing or empty");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bun: one summary line summed over every shard's output", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-totals-"));
    try {
      const shard = (name: string, pass: number, fail: number) => {
        const path = join(dir, name);
        writeFileSync(path, `bun test v1.3.14\n\n ${pass} pass\n ${fail} fail\n 40 expect() calls\nRan ${pass + fail} tests across 1 file.\n`);
        return path;
      };
      const printed = summary("print_bun_totals", ["3 security suites", shard("a", 12, 0), shard("b", 7, 2), shard("c", 30, 0)]);
      expect(printed.code).toBe(0);
      expect(printed.out).toBe("  49 pass | 2 fail | 3 security suites\n");
      // The shape the zero-test counter accepts: "  N pass | M fail | …".
      expect(printed.out).toMatch(/^ +\d+ pass \| \d+ fail \| /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("both silent producers call the summary after their runs", () => {
    const node = readFileSync(join(REPO_ROOT, "scripts/factory-orchestrator-coverage.sh"), "utf8");
    expect(node).toContain("source scripts/lib/test-totals.sh");
    expect(node.indexOf('print_node_totals "$COV_OUT/test-progress.log"')).toBeGreaterThan(node.indexOf("node --test"));
    // Printed pass or fail: the node status is kept and returned after the totals.
    expect(node).toContain('[ "$node_status" -eq 0 ] || exit "$node_status"');
    const security = readFileSync(join(REPO_ROOT, "scripts/security-coverage.sh"), "utf8");
    expect(security).toContain('> "$TMPDIR/full_$IDX" 2>&1');
    // A bash expansion, not a template placeholder: the literal text of the script's call.
    const call = ["print_bun_totals", '"$' + '{#FILES[@]} security suites"', '"$TMPDIR"/full_*'].join(" ");
    expect(security.indexOf(call)).toBeGreaterThan(security.indexOf("wait\n"));
  });
});
