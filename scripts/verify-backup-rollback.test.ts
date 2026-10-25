import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const source = readFileSync(join(repo, "scripts/verify-backup-rollback.ts"), "utf8");
const restoreRead = "  const restoredRows = await settingsRows();";

// Run the real boot/snapshot/rollback consumer in a child: its connection
// singletons and process.exit failure path must not share this test's process.
async function verify(restoredMutation = "") {
  const dir = mkdtempSync(join(import.meta.dir, ".backup-rollback-test-"));
  let output = "";
  try {
    expect(source.split(restoreRead)).toHaveLength(2);
    const script = source.replaceAll('"../src/', `"${repo}/src/`)
      .replace(restoreRead, `${restoredMutation}\n${restoreRead}`);
    const path = join(dir, "verify.ts");
    writeFileSync(path, script);
    const child = Bun.spawn([process.execPath, path], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    output = stdout + stderr;
    return { exit, output };
  } finally {
    // The consumer retains its own failed DB for inspection. These tests own
    // that fresh fixture and remove it only after the child has exited.
    const fixture = output.match(/DB dir created at (\/tmp\/ezcorp-verify-[A-Za-z0-9]+)\/db/);
    if (fixture?.[1]) rmSync(fixture[1], { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

test("real backup consumer preserves migration markers and values through recovery", async () => {
  const result = await verify();
  expect(result.exit).toBe(0);
  expect(result.output).toContain("ALL VERIFIED");
  expect(result.output).toContain("Every baseline setting and value remains intact after recovery");
}, 120_000);

for (const [name, mutation] of [
  ["changed value", "UPDATE settings SET value = '\"corrupted\"'::jsonb WHERE key = 'verify-key'"],
  ["unexpected row", "INSERT INTO settings (key, value) VALUES ('unexpected', 'true'::jsonb)"],
  ["lost migration marker", "DELETE FROM settings WHERE key = 'migration:kb-ownerless-claim-v1'"],
]) {
  test(`real restore check rejects ${name}`, async () => {
    const result = await verify(`  await conn.getDb().execute(sql\`${mutation}\`);`);
    expect(result.exit).toBe(1);
    expect(result.output).toContain("✗ Restored DB exactly matches pre-snapshot keys and values");
    expect(result.output).not.toContain("ALL VERIFIED");
  }, 120_000);
}
