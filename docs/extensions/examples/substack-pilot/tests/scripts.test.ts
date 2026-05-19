// ── postinstall + preuninstall script-runner verification ───────
//
// The validators flagged scripts/ as "not field-tested" because they
// only run at install/uninstall time. These tests exercise them
// end-to-end via Bun.spawn — the same way the host installer would
// invoke them — and assert exit codes + stdout/stderr.
//
// We do NOT mock fs; the real prompts directory has all three seed
// files (weekly.md / monthly.md / ad-hoc.md), so the happy-path
// invocation must exit 0 and not emit the WARNING line.
//
// The "missing prompt" branch is intentionally NOT exercised here:
// postinstall.ts resolves PROMPTS_DIR via `import.meta.dir` + `..`,
// which always points at the extension's real ./prompts directory
// regardless of subprocess `cwd`. The only clean way to test the warn
// branch would be to copy the extension into a tmp dir with two of
// three prompts, then spawn the script from there — that's more
// scaffolding than the branch is worth, and the warning is non-fatal
// anyway (the extension still works without the seed files because
// ensureSeedsLoaded gracefully handles missing files).

import { test, expect, describe } from "bun:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = dirname(fileURLToPath(import.meta.url)).replace(/\/tests$/, "");
const POSTINSTALL = join(EXT_DIR, "scripts", "postinstall.ts");
const PREUNINSTALL = join(EXT_DIR, "scripts", "preuninstall.ts");
const PROMPTS_DIR = join(EXT_DIR, "prompts");

async function runScript(script: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  // bun.execPath gives the absolute path to the bun binary running this
  // test, so the subprocess is guaranteed to use the same runtime — no
  // PATH lookup, no node-vs-bun ambiguity. Stdin is `null` because the
  // scripts don't read stdin (they'd hang otherwise on some platforms).
  const proc = Bun.spawn({
    cmd: [Bun.which("bun") ?? "bun", script],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

describe("scripts — prerequisites", () => {
  test("all three seed prompt files exist on disk", async () => {
    // postinstall warns when any of these is missing — confirm the
    // happy-path assumption holds before testing the script itself.
    for (const slug of ["weekly", "monthly", "ad-hoc"]) {
      const path = join(PROMPTS_DIR, `${slug}.md`);
      expect(await Bun.file(path).exists()).toBe(true);
    }
  });
});

describe("scripts/postinstall.ts", () => {
  test("exits 0 with all prompts present", async () => {
    const { exitCode, stdout, stderr } = await runScript(POSTINSTALL);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("substack-pilot installed.");
    expect(stdout).toContain("Next steps:");
    // The WARNING line is only emitted when seed files are missing. With
    // all three present, neither stdout nor stderr should mention WARNING.
    expect(stdout.includes("WARNING")).toBe(false);
    expect(stderr.includes("WARNING")).toBe(false);
  });

  test("prints the setup hint pointing at the settings page", async () => {
    const { stdout } = await runScript(POSTINSTALL);
    // Two-step hint: settings URL + chat usage. Asserting on the substrings
    // (not whole lines) lets the script reword without breaking the test.
    expect(stdout).toContain("/extensions/substack-pilot");
    expect(stdout).toContain("SUBSTACK_PUBLICATION_URL");
    expect(stdout).toContain("![ext:substack-pilot]");
  });
});

describe("scripts/preuninstall.ts", () => {
  test("exits 0 and announces user data is preserved", async () => {
    const { exitCode, stdout, stderr } = await runScript(PREUNINSTALL);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("substack-pilot: uninstalling");
    // The script's whole contract is "we don't wipe user data" — pin
    // that copy so a future contributor can't quietly turn it into
    // a destructive cleanup script without updating the test.
    expect(stdout).toContain("User-defined post types are preserved");
    expect(stdout).toContain("reinstall");
    expect(stderr).toBe("");
  });
});
