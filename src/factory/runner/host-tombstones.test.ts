import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryHostTombstones } from "./host-tombstones";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true }))); });

const hostId = "host-tombstones";

/** A host's private key directory, as the supervisor keeps it: key, key id, and (later) its tombstones. */
async function hostKey(root?: string) {
  const directory = root ?? await mkdtemp(join(tmpdir(), "factory-host-tombstones-"));
  if (!root) directories.push(directory);
  await chmod(directory, 0o700);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPath = join(directory, "host.key");
  const keyIdPath = join(directory, "host.kid");
  await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await writeFile(keyIdPath, "host-key-1", { mode: 0o600 });
  return { hostId, privateKeyPath, keyIdPath, directory };
}

const tombstone = { tenantId: "tenant-a", workerId: "worker-stopped", attemptId: "attempt-stopped", reservationId: "reservation-stopped" };

describe("a host tombstone survives the host", () => {
  test("written by one host process, it refuses the worker in the next one (W02d R8, process-level restart)", async () => {
    const key = await hostKey();
    // The first host process records the tombstone and exits: nothing of it survives but the file beside the key.
    const script = join(key.directory, "record.ts");
    await writeFile(script, `import { FactoryHostTombstones } from ${JSON.stringify(new URL("./host-tombstones.ts", import.meta.url).pathname)};
const store = await FactoryHostTombstones.open(${JSON.stringify({ hostId: key.hostId, privateKeyPath: key.privateKeyPath, keyIdPath: key.keyIdPath })});
await store.record(${JSON.stringify(tombstone)});
console.log(store.stopped(${JSON.stringify(tombstone.tenantId)}, ${JSON.stringify(tombstone.workerId)}) ? "recorded" : "not-recorded");
`);
    const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout: stdout.trim(), stderr: stderr.trim() }).toEqual({ code: 0, stdout: "recorded", stderr: "" });
    // The restarted host loads it before anything else, and refuses the worker; a fresh worker is not refused.
    const restarted = await FactoryHostTombstones.open(key);
    expect(restarted.stopped(tombstone.tenantId, tombstone.workerId)).toBe(true);
    expect(restarted.stopped(tombstone.tenantId, "worker-never-stopped")).toBe(false);
    expect(restarted.refused).toBe(0);
  });
});
