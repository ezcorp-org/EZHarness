/**
 * scripts/lib/pinned-bun.sh: the tool directory comes from .bun-version, the bunx link is made when Bun's
 * release zip left it out, and BOTH bun and bunx must report the pin. A fake tool directory
 * (FACTORY_TOOLS_DIR) stands in for /tmp/factory-tools, so no real Bun is replaced.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const HELPER = join(REPO_ROOT, "scripts/lib/pinned-bun.sh");
const PIN = readFileSync(join(REPO_ROOT, ".bun-version"), "utf8").trim();
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fake tools root whose `bun-<pin>/bun-linux-x64/<name>` prints `version`. */
function toolsWith(entries: Record<string, string>, pin = PIN): { tools: string; dir: string } {
  const tools = mkdtempSync(join(tmpdir(), "pinned-bun-"));
  roots.push(tools);
  const dir = join(tools, `bun-${pin}`, "bun-linux-x64");
  mkdirSync(dir, { recursive: true });
  for (const [name, version] of Object.entries(entries)) {
    writeFileSync(join(dir, name), `#!/bin/sh\necho ${version}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return { tools, dir };
}

function usePinnedBun(tools: string) {
  const run = Bun.spawnSync(["bash", "-c", `. "${HELPER}" && use_pinned_bun && command -v bun && command -v bunx`], {
    env: { PATH: "/usr/bin:/bin:/run/current-system/sw/bin", FACTORY_TOOLS_DIR: tools },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

describe("scripts/lib/pinned-bun.sh", () => {
  test("the directory is derived from .bun-version", () => {
    const run = Bun.spawnSync(["bash", "-c", `. "${HELPER}" && pinned_bun_dir`], {
      env: { PATH: "/usr/bin:/bin:/run/current-system/sw/bin", FACTORY_TOOLS_DIR: "/opt/tools" },
      stdout: "pipe",
    });
    expect(run.stdout.toString()).toBe(`/opt/tools/bun-${PIN}/bun-linux-x64\n`);
  });

  test("a release-zip layout (bun only) gets the bunx link, and both resolve to the pinned directory", () => {
    const { tools, dir } = toolsWith({ bun: PIN });
    const result = usePinnedBun(tools);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(lstatSync(join(dir, "bunx")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "bunx"))).toBe("bun");
    expect(result.stdout).toBe(`${join(dir, "bun")}\n${join(dir, "bunx")}\n`);
  });

  test("a missing pinned Bun fails by name", () => {
    const { tools, dir } = toolsWith({});
    const result = usePinnedBun(tools);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`pinned Bun missing: ${dir}/bun (download bun-v${PIN} bun-linux-x64.zip`);
    expect(existsSync(join(dir, "bunx"))).toBe(false);
  });

  test("a bun that reports another version fails by name", () => {
    const { tools } = toolsWith({ bun: "9.9.9" });
    const result = usePinnedBun(tools);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`pinned Bun mismatch: bun 9.9.9, bunx 9.9.9, .bun-version ${PIN}`);
  });

  test("an existing bunx that is not the pinned Bun fails by name, and is not replaced", () => {
    const { tools, dir } = toolsWith({ bun: PIN, bunx: "1.0.0" });
    const result = usePinnedBun(tools);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`pinned Bun mismatch: bun ${PIN}, bunx 1.0.0, .bun-version ${PIN}`);
    expect(lstatSync(join(dir, "bunx")).isSymbolicLink()).toBe(false);
  });

  test("loaded without a source path (zsh, eval) it fails by name instead of reading another tree's pin", () => {
    // zsh leaves BASH_SOURCE empty, so the repository root fell back to "$PWD/../..": from a worktree under
    // .worktrees/ that is the main checkout, whose older .bun-version then passed the assertion (w12e-2, 2026-09-28).
    const tree = mkdtempSync(join(tmpdir(), "pinned-bun-tree-"));
    roots.push(tree);
    writeFileSync(join(tree, ".bun-version"), "7.7.7\n");
    const cwd = join(tree, "a", "b");
    mkdirSync(cwd, { recursive: true });
    const { tools } = toolsWith({ bun: "7.7.7", bunx: "7.7.7" }, "7.7.7");
    const run = Bun.spawnSync(["bash", "-c", `eval "$(cat "${HELPER}")" && use_pinned_bun`], {
      cwd,
      env: { PATH: "/usr/bin:/bin:/run/current-system/sw/bin", FACTORY_TOOLS_DIR: tools },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain("pinned-bun.sh: no source path; source this file from bash");
  });

  test("an existing correct bunx link is kept as it is", () => {
    const { tools, dir } = toolsWith({ bun: PIN });
    symlinkSync("bun", join(dir, "bunx"));
    const result = usePinnedBun(tools);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(readlinkSync(join(dir, "bunx"))).toBe("bun");
  });
});
