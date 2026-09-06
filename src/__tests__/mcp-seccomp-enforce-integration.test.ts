/** Owned-kernel proof for the retained MCP launcher, BPF and audit reader.
 * This component uses a different profile from the current v4 Podman runner.
 * Explicit opt-in must fail if any guest, image or audit prerequisite is absent.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";

const enabled = process.env.EZCORP_AUDIT_PROOF === "1";

test.skipIf(!enabled)("production MCP launcher filter denies an absent syscall and attributes real kernel audit records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shipping-audit-proof-"));
  const root = resolve(import.meta.dir, "../..");
  const log = join(directory, "guest.log");
  async function run(args: string[], env: Record<string, string | undefined> = {}): Promise<string> {
    const child = Bun.spawn(args, { cwd: root, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(code, 0, `${args[0]} failed: ${stdout}\n${stderr}`);
    return stdout;
  }
  try {
    const kernel = await run(["bash", "scripts/shipping-audit-vm.sh", log]);
    assert.match(kernel, /VM_AUDIT_ASSERTION=PASS pid=[1-9][0-9]*/);
    assert.match(kernel, /VM_PROBE_STATUS=0/);
    assert.match(kernel, /VM_CONTROL_STATUS=24/);
    const ingestion = await run([process.execPath, "scripts/shipping-audit-ingest.ts", log], { EZCORP_DB_PATH: join(directory, "db"), DATABASE_URL: "" });
    const line = ingestion.split("\n").find(line => line.startsWith('{"status":"PASS"'));
    assert(line, "The real production reader must finish its database assertions");
    const result = JSON.parse(line) as { sourceRecords: number; persistedRows: number; wrongPidRows: number };
    assert(result.sourceRecords > 0);
    assert.equal(result.persistedRows, result.sourceRecords);
    assert.equal(result.wrongPidRows, 0);
    console.log(JSON.stringify({ check: "S3", ...result }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
