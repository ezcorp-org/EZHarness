import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTORY_LIMITS, compileFactory, createKernelState, referenceCodeV1 } from "@ezcorp/factory-sdk";
import { FACTORY_HOST_TOMBSTONE_GRACE_MS, FACTORY_HOST_TOMBSTONE_RETENTION_MS, FACTORY_HOST_TOMBSTONES_FILE, FactoryHostTombstones } from "./host-tombstones";

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

const fileOf = (key: { directory: string }) => join(key.directory, FACTORY_HOST_TOMBSTONES_FILE);

/** One genuine line, recorded by a host with this key and host id. */
async function recordedLine(key: Awaited<ReturnType<typeof hostKey>>, as: { hostId?: string; input?: typeof tombstone } = {}) {
  const store = await FactoryHostTombstones.open({ ...key, hostId: as.hostId ?? key.hostId });
  await store.record(as.input ?? tombstone);
  const lines = (await readFile(fileOf(key), "utf8")).trim().split("\n");
  return lines[lines.length - 1]!;
}

describe("a host tombstone is honoured only when this host wrote it, for this tenant, and it is unexpired (ruling (A) iii)", () => {
  test("a forged tombstone, signed with another key, is refused", async () => {
    const key = await hostKey();
    const forger = await hostKey();
    await writeFile(fileOf(key), `${await recordedLine(forger)}\n`, { mode: 0o600 });
    const store = await FactoryHostTombstones.open(key);
    expect({ stopped: store.stopped(tombstone.tenantId, tombstone.workerId), refused: store.refused }).toEqual({ stopped: false, refused: 1 });
  });

  test("a stale tombstone, written for another host with the same key, is refused", async () => {
    const key = await hostKey();
    await recordedLine(key, { hostId: "host-elsewhere" });
    const store = await FactoryHostTombstones.open(key);
    expect({ stopped: store.stopped(tombstone.tenantId, tombstone.workerId), refused: store.refused }).toEqual({ stopped: false, refused: 1 });
  });

  test("a tombstone refuses only its own tenant: another tenant's worker of the same id still launches", async () => {
    const key = await hostKey();
    await recordedLine(key);
    const store = await FactoryHostTombstones.open(key);
    expect({ own: store.stopped(tombstone.tenantId, tombstone.workerId), other: store.stopped("tenant-b", tombstone.workerId) }).toEqual({ own: true, other: false });
  });

  test("a tombstone past its retention is no longer honoured, in memory or after a restart", async () => {
    const key = await hostKey();
    let now = 1_000_000;
    const store = await FactoryHostTombstones.open(key, { now: () => now });
    await store.record(tombstone);
    expect(store.stopped(tombstone.tenantId, tombstone.workerId)).toBe(true);
    now += FACTORY_HOST_TOMBSTONE_RETENTION_MS;
    expect(store.stopped(tombstone.tenantId, tombstone.workerId)).toBe(false);
    const restarted = await FactoryHostTombstones.open(key, { now: () => now });
    expect({ stopped: restarted.stopped(tombstone.tenantId, tombstone.workerId), refused: restarted.refused }).toEqual({ stopped: false, refused: 1 });
  });

  test("malformed and tampered lines are refused one by one; genuine lines around them are honoured", async () => {
    const key = await hostKey();
    const genuine = await recordedLine(key);
    const entry = JSON.parse(genuine) as Record<string, unknown>;
    const tampered = [
      "not json",
      "null",
      JSON.stringify({ ...entry, schemaVersion: "factory.host-worker-tombstone.v0" }),
      JSON.stringify({ ...entry, tenantId: "" }),
      JSON.stringify({ ...entry, workerId: "worker\u0001" }),
      JSON.stringify({ ...entry, attemptId: 7 }),
      JSON.stringify({ ...entry, reservationId: "r".repeat(513) }),
      JSON.stringify({ ...entry, recordedAtMs: -1 }),
      JSON.stringify({ ...entry, expiresAtMs: 1.5 }),
      JSON.stringify({ ...entry, signature: 7 }),
      JSON.stringify({ ...entry, workerId: "worker-renamed" }),
    ];
    await appendFile(fileOf(key), `\n${tampered.join("\n")}\n${await recordedLine(key, { input: { ...tombstone, workerId: "worker-second" } })}\n`);
    const store = await FactoryHostTombstones.open(key);
    expect({
      first: store.stopped(tombstone.tenantId, tombstone.workerId),
      second: store.stopped(tombstone.tenantId, "worker-second"),
      renamed: store.stopped(tombstone.tenantId, "worker-renamed"),
      refused: store.refused,
    }).toEqual({ first: true, second: true, renamed: false, refused: tampered.length });
  });

  test("a malformed tombstone is never written", async () => {
    const key = await hostKey();
    const store = await FactoryHostTombstones.open(key);
    for (const field of ["tenantId", "workerId", "attemptId", "reservationId"] as const) {
      await expect(store.record({ ...tombstone, [field]: "" })).rejects.toThrow("Factory host tombstone is malformed.");
    }
    expect(await Bun.file(fileOf(key)).exists()).toBe(false);
  });

  test("a write that fails throws and honours nothing, so no stop is signed on it (fail-closed)", async () => {
    const key = await hostKey();
    const store = await FactoryHostTombstones.open(key);
    // The tombstones' path is taken by a directory: neither the append nor a later load can succeed.
    await mkdir(fileOf(key));
    await expect(store.record(tombstone)).rejects.toThrow();
    expect(store.stopped(tombstone.tenantId, tombstone.workerId)).toBe(false);
    await expect(FactoryHostTombstones.open(key)).rejects.toThrow();
  });

  test("an oversized tombstone file stops the host from starting rather than being read in part", async () => {
    const key = await hostKey();
    await writeFile(fileOf(key), "x".repeat(16 * 1024 * 1024 + 1), { mode: 0o600 });
    await expect(FactoryHostTombstones.open(key)).rejects.toThrow("Factory host tombstones are oversized.");
  });

  test("a reservation refuses the worker until it is released; a recorded one keeps refusing", async () => {
    const key = await hostKey();
    const store = await FactoryHostTombstones.open(key);
    const release = store.reserve(tombstone.tenantId, tombstone.workerId);
    expect(store.stopped(tombstone.tenantId, tombstone.workerId)).toBe(true);
    release();
    expect(store.stopped(tombstone.tenantId, tombstone.workerId)).toBe(false);
    const recorded = store.reserve(tombstone.tenantId, tombstone.workerId);
    await store.record(tombstone);
    recorded();
    expect(store.stopped(tombstone.tenantId, tombstone.workerId)).toBe(true);
  });
});

describe("the tombstone's retention (gates: W02d tombstone retention)", () => {
  test("outlives the longest run deadline the kernel allows, plus the grace", () => {
    // The longest deadline a definition may ask for, as the kernel grants it to a run started at 0.
    const result = compileFactory({
      schemaVersion: "factory.v1", id: "tombstone-retention", version: "1", interpreterCompatibility: "1", inputPorts: {}, outputPorts: {},
      graph: { nodes: [], outputs: {} }, acceptance: referenceCodeV1.acceptance, packages: [...referenceCodeV1.packages], capabilities: [], effects: ["none"],
      bounds: { maxExpandedNodes: 100, maxScopeDepth: 16, runDeadlineMs: FACTORY_LIMITS.maximumRunDeadlineMs },
    });
    if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.code).join(", "));
    const longestDeadline = createKernelState(result.factory, "tombstone-retention", {}, 0).runDeadlineAtMs;
    expect(FACTORY_HOST_TOMBSTONE_RETENTION_MS).toBe(longestDeadline + FACTORY_HOST_TOMBSTONE_GRACE_MS);
  });
});

describe("a host tombstone's file is durable from its first entry (validator-6 D3)", () => {
  test("the write that creates the file also syncs its folder, once; later writes append without it", async () => {
    const key = await hostKey();
    const synced: string[] = [];
    const store = await FactoryHostTombstones.open(key, { syncDirectory: async (path) => { synced.push(path); } });
    await store.record(tombstone);
    expect(synced).toEqual([key.directory]);
    await store.record({ ...tombstone, workerId: "worker-second" });
    expect(synced).toEqual([key.directory]);
    // A host that finds the file already there never needs to sync the folder for it.
    const restarted = await FactoryHostTombstones.open(key, { syncDirectory: async (path) => { synced.push(`restart:${path}`); } });
    await restarted.record({ ...tombstone, workerId: "worker-third" });
    expect(synced).toEqual([key.directory]);
  });

  test("a folder that cannot be synced fails the write: nothing is honoured, so no stop is signed on it", async () => {
    const key = await hostKey();
    const store = await FactoryHostTombstones.open(key, { syncDirectory: async () => { throw new Error("the folder could not be synced"); } });
    await expect(store.record(tombstone)).rejects.toThrow("the folder could not be synced");
    expect(store.stopped(tombstone.tenantId, tombstone.workerId)).toBe(false);
  });

  test("the production folder sync runs on a real folder", async () => {
    const key = await hostKey();
    const store = await FactoryHostTombstones.open(key);
    await store.record(tombstone);
    expect((await FactoryHostTombstones.open(key)).stopped(tombstone.tenantId, tombstone.workerId)).toBe(true);
  });
});

describe("a long-lived host can always start: its tombstone file keeps only the live window (validator-6 D2)", () => {
  const lines = async (key: { directory: string }) => (await readFile(fileOf(key), "utf8")).trim().split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { workerId: string }).workerId);

  test("loading drops expired, refused and superseded lines, and rewrites the file with only the live ones", async () => {
    const key = await hostKey();
    let now = 1_000_000;
    const store = await FactoryHostTombstones.open(key, { now: () => now });
    await store.record({ ...tombstone, workerId: "worker-expired" });
    now += FACTORY_HOST_TOMBSTONE_RETENTION_MS / 2;
    await store.record({ ...tombstone, workerId: "worker-live" });
    await store.record({ ...tombstone, workerId: "worker-live" });
    await appendFile(fileOf(key), "not json\n");
    now += FACTORY_HOST_TOMBSTONE_RETENTION_MS / 2;
    const synced: string[] = [];
    const restarted = await FactoryHostTombstones.open(key, { now: () => now, syncDirectory: async (path) => { synced.push(path); } });
    expect({ live: restarted.stopped(tombstone.tenantId, "worker-live"), expired: restarted.stopped(tombstone.tenantId, "worker-expired"), refused: restarted.refused })
      .toEqual({ live: true, expired: false, refused: 2 });
    // The rewrite replaces the file by rename, so the folder entry is synced as well.
    expect({ file: await lines(key), synced }).toEqual({ file: ["worker-live"], synced: [key.directory] });
    // A file with nothing to drop is not rewritten.
    const again = await FactoryHostTombstones.open(key, { now: () => now, syncDirectory: async (path) => { synced.push(`again:${path}`); } });
    expect({ refused: again.refused, synced }).toEqual({ refused: 0, synced: [key.directory] });
  });

  test("a full file drops its expired entries before it appends; a live window that is truly full refuses the write and signs nothing", async () => {
    const key = await hostKey();
    let now = 1_000_000;
    const probe = await FactoryHostTombstones.open(key, { now: () => now });
    await probe.record({ ...tombstone, workerId: "worker-a" });
    const lineBytes = (await readFile(fileOf(key))).byteLength;
    await rm(fileOf(key));
    // Room for two entries and a half.
    const store = await FactoryHostTombstones.open(key, { now: () => now, maxFileBytes: lineBytes * 2 + lineBytes / 2 });
    await store.record({ ...tombstone, workerId: "worker-a" });
    await store.record({ ...tombstone, workerId: "worker-b" });
    now += FACTORY_HOST_TOMBSTONE_RETENTION_MS;
    await store.record({ ...tombstone, workerId: "worker-c" });
    expect(await lines(key)).toEqual(["worker-c"]);
    await store.record({ ...tombstone, workerId: "worker-d" });
    await expect(store.record({ ...tombstone, workerId: "worker-e" })).rejects.toThrow("Factory host tombstones are full.");
    expect({ e: store.stopped(tombstone.tenantId, "worker-e"), file: await lines(key) }).toEqual({ e: false, file: ["worker-c", "worker-d"] });
    // The host still starts: the file never grows past its bound.
    const restarted = await FactoryHostTombstones.open(key, { now: () => now, maxFileBytes: lineBytes * 2 + lineBytes / 2 });
    expect(restarted.stopped(tombstone.tenantId, "worker-d")).toBe(true);
  });
});
