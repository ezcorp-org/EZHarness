import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TransactionalDb } from "../db/migrations/types";
import type { FactoryCheckpointOutcome } from "./checkpoint-barrier";
import type { PoolCheckpointClient } from "./pool/client";
import { composeFactoryRecoveryRoles, FACTORY_CHECKPOINT_INTERVAL_MS, FACTORY_RESTORE_IMPORT_CHUNK, factoryCheckpointStep, factoryClientRestorePoolLedger, factoryPoolCheckpointClientSlots, factoryPoolCheckpointClientSource, factoryRetentionStep, factoryTemporalPositionsFromConfig } from "./recovery-composition";
import { FactoryTemporalHttpPositions } from "./temporal-retention";
import type { FactoryStartupConfig } from "./startup-config";

const signal = new AbortController().signal;

describe("the retention role", () => {
  test("a pass is work only when something was enrolled, archived, or collected", async () => {
    const calls: string[] = [];
    const retention = (enrolled: number, archived: number, actions: readonly string[]) => ({
      enroll: async () => { calls.push("enroll"); return enrolled; },
      archivePending: async () => { calls.push("archive"); return archived; },
      collectDue: async () => { calls.push("collect"); return actions.map(action => ({ subjectKind: "run_audit" as const, subjectId: "s", action: action as "collected" })); },
    });
    expect(await factoryRetentionStep(retention(0, 0, ["refused", "tombstoned"]))(signal)).toBe("idle");
    expect(await factoryRetentionStep(retention(1, 0, []))(signal)).toBe("worked");
    expect(await factoryRetentionStep(retention(0, 1, []))(signal)).toBe("worked");
    expect(await factoryRetentionStep(retention(0, 0, ["collected"]))(signal)).toBe("worked");
    expect(calls.slice(0, 3)).toEqual(["enroll", "archive", "collect"]);
  });
});

describe("the checkpoint role", () => {
  function coordinator(newest: { ageMs: number } | null, outcome: FactoryCheckpointOutcome) {
    const calls: string[] = [];
    return {
      calls,
      enforceFreshness: async () => { calls.push("enforce"); },
      newest: async () => { calls.push("newest"); return newest === null ? null : { checkpointId: "c", ageMs: newest.ageMs, manifest: { key: "k", digest: `sha256:${"a".repeat(64)}`, versionId: "v" } }; },
      run: async () => { calls.push("run"); return outcome; },
    };
  }

  test("it turns on the freshness rule once, skips a fresh checkpoint, and seals a stale one", async () => {
    const fresh = coordinator({ ageMs: 1_000 }, { kind: "skipped", reason: "restore_epoch_open" });
    const step = factoryCheckpointStep(fresh, () => {});
    expect(await step(signal)).toBe("idle");
    expect(await step(signal)).toBe("idle");
    expect(fresh.calls).toEqual(["enforce", "newest", "newest"]);
    const stale = coordinator({ ageMs: FACTORY_CHECKPOINT_INTERVAL_MS }, { kind: "sealed", checkpointId: "c", durationMs: 5, writePauseMs: 2, lsn: "0/1", manifest: { key: "k", digest: "d" }, seal: { key: "s", digest: "d" }, fenced: 0, withinTarget: true });
    expect(await factoryCheckpointStep(stale, () => {})(signal)).toBe("worked");
    const none = coordinator(null, { kind: "skipped", reason: "restore_epoch_open" });
    expect(await factoryCheckpointStep(none, () => {})(signal)).toBe("idle");
  });

  test("an aborted barrier is reported, claims nothing, and the role waits instead of spinning", async () => {
    const reports: string[] = [];
    const aborted = coordinator(null, { kind: "aborted", checkpointId: "c-1", durationMs: 10_001, code: "barrier_timeout" });
    expect(await factoryCheckpointStep(aborted, (role, error) => reports.push(`${role}:${(error as Error).message}`))(signal)).toBe("idle");
    expect(reports).toEqual(["checkpoint-barrier:checkpoint barrier c-1 aborted with barrier_timeout after 10001 ms; no checkpoint was claimed"]);
  });
});

describe("the pool's checkpoint and restore over its client", () => {
  function client(rows: number) {
    const all = Array.from({ length: rows }, (_, index) => ({ reservation_id: `r-${String(index).padStart(3, "0")}`, tenant_id: "t" }));
    const imports: number[] = [];
    const checkpoints: PoolCheckpointClient = {
      async checkpoint(after) {
        const start = after === null ? 0 : all.findIndex(row => row.reservation_id === after) + 1;
        const page = all.slice(start, start + 16);
        return { position: `0/${start}`, rows: page, next: start + 16 < all.length ? page.at(-1)!.reservation_id : null };
      },
      async restoreImport(batch) { imports.push(batch.length); return { present: ["p"], imported: batch.map(row => String(row.reservation_id)), overcommitted: [] }; },
      acquireCheckpointSlot: async () => null,
      releaseCheckpointSlot: async () => true,
    };
    return { checkpoints, imports };
  }

  test("a snapshot reads every page and keeps the first page's position", async () => {
    const { checkpoints } = client(40);
    const snapshot = await factoryPoolCheckpointClientSource(checkpoints).snapshotTenant("t", signal);
    expect(snapshot.position).toBe("0/0");
    expect(snapshot.rows).toHaveLength(40);
  });

  test("an import is sent in bounded chunks and a revoke goes through admission's cancel", async () => {
    const { checkpoints, imports } = client(40);
    const cancels: string[] = [];
    const ledger = factoryClientRestorePoolLedger(checkpoints, { cancel: async (id, generation) => { cancels.push(`${id}:${generation}`); return { reservationId: id, tenantId: "t", state: "revoking", allocationGeneration: generation + 1, holderGeneration: 1, effects: 0, resources: {} }; } });
    const rows = Array.from({ length: 40 }, (_, index) => ({ reservation_id: `x-${index}`, tenant_id: "t" }));
    const result = await ledger.importLost("t", rows);
    expect(imports).toEqual([FACTORY_RESTORE_IMPORT_CHUNK, FACTORY_RESTORE_IMPORT_CHUNK, 8]);
    expect(result.imported).toHaveLength(40);
    expect(result.present).toEqual(["p"]);
    expect(await ledger.importLost("t", [])).toEqual({ present: ["p"], imported: [], overcommitted: [] });
    expect((await ledger.liveRows("t", signal))).toHaveLength(40);
    expect(await ledger.revoke("r-1", 3, signal)).toEqual({ state: "revoking" });
    expect(cancels).toEqual(["r-1:3"]);
  });
});

describe("composition from the startup document", () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(process.env.HOME!, ".w15-recovery-"));
    await chmod(directory, 0o700);
    for (const kind of ["ordinary", "archive"]) {
      await writeFile(join(directory, `${kind}.json`), JSON.stringify({ identities: [{ name: "tenant-c", credentials: [{ accessKey: `${kind}-access`, secretKey: `${kind}-secret` }] }] }), { mode: 0o600 });
      await chmod(join(directory, `${kind}.json`), 0o600);
    }
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  const storage = (kind: string, file = `${kind}.json`) => ({ endpoint: `http://${kind}.invalid`, bucket: "tenant-c", prefix: `${kind}/prefix`, credentialSet: `${kind}-set`, credentialsPath: join(directory, file) });
  const config = (archiveFile = "archive.json", ordinaryFile = "ordinary.json", temporalHttp: unknown = { endpoint: "http://temporal.invalid:7243" }) => ({
    tenantId: "tenant-c", installationId: "installation-c", temporalNamespace: "tenant-c.factory",
    ...(temporalHttp === null ? {} : { temporalHttp }),
    storage: { ordinary: storage("ordinary", ordinaryFile), archive: storage("archive", archiveFile) },
    pool: { baseUrl: "https://pool.invalid", serviceTokenPath: join(directory, "missing-token"), tls: { caPath: join(directory, "ca"), certificatePath: join(directory, "cert"), privateKeyPath: join(directory, "key") } },
  }) as unknown as FactoryStartupConfig;
  const database = {} as TransactionalDb;
  const pool: PoolCheckpointClient = { checkpoint: async () => ({ position: "0/0", rows: [], next: null }), restoreImport: async () => ({ present: [], imported: [], overcommitted: [] }), acquireCheckpointSlot: async () => null, releaseCheckpointSlot: async () => true };

  test("both roles compose from the archive and ordinary credential sets and the pool client", async () => {
    const reports: string[] = [];
    const roles = await composeFactoryRecoveryRoles({ config: config(), database, report: role => reports.push(role), poolClient: async () => pool });
    expect(typeof roles.retention).toBe("function");
    expect(typeof roles.checkpoint).toBe("function");
    expect(reports).toEqual([]);
  });

  test("a role that cannot compose is reported under its own name and left out", async () => {
    const reports: string[] = [];
    expect(await composeFactoryRecoveryRoles({ config: config("absent.json"), database, report: role => reports.push(role) })).toEqual({});
    expect(reports).toEqual(["recovery-archive"]);
    const partial: string[] = [];
    const roles = await composeFactoryRecoveryRoles({ config: config("archive.json", "absent.json"), database, report: role => partial.push(role) });
    expect(roles.retention).toBeUndefined();
    expect(roles.checkpoint).toBeUndefined();
    expect(partial).toEqual(["retention-gc", "checkpoint-barrier"]);
  });

  test("with no Temporal endpoint the barrier role holds: no checkpoint may omit Temporal positions", async () => {
    const reports: { role: string; message: string }[] = [];
    const roles = await composeFactoryRecoveryRoles({ config: config("archive.json", "ordinary.json", null), database, report: (role, error) => reports.push({ role, message: (error as Error).message }), poolClient: async () => pool });
    expect(typeof roles.retention).toBe("function");
    expect(roles.checkpoint).toBeUndefined();
    expect(reports).toEqual([{ role: "checkpoint-barrier", message: "the startup document declares no temporalHttp endpoint, so no checkpoint could record Temporal positions" }]);
  });

  test("the Temporal reader carries the namespace and the client TLS read by reference", async () => {
    for (const name of ["temporal.pem", "temporal.key", "temporal-ca.pem"]) await writeFile(join(directory, name), `${name} contents`, { mode: 0o600 });
    const tls = { caPath: join(directory, "temporal-ca.pem"), certificatePath: join(directory, "temporal.pem"), privateKeyPath: join(directory, "temporal.key") };
    const seen: unknown[] = [];
    const fetcher = (async (url: URL, init: { tls?: unknown }) => { seen.push({ url: url.toString(), tls: init.tls }); return Response.json({ executions: [] }); }) as unknown as typeof fetch;
    const reader = await factoryTemporalPositionsFromConfig({ temporalNamespace: "tenant-c.factory", temporalHttp: { endpoint: "https://temporal.internal:7243", tls } });
    expect(reader.namespace).toBe("tenant-c.factory");
    // The reader built from the document is the visibility-list reader; drive it with a recording fetch.
    const recorded = new FactoryTemporalHttpPositions({ endpoint: "https://temporal.internal:7243", namespace: reader.namespace, fetch: fetcher, tls: { cert: "temporal.pem contents", key: "temporal.key contents", ca: "temporal-ca.pem contents" } });
    expect(await recorded.positions(["tenant-c/run-1"])).toEqual([{ workflowId: "tenant-c/run-1", runId: null, status: "not_found", historyLength: null }]);
    expect(seen).toHaveLength(1);
    await expect(factoryTemporalPositionsFromConfig({ temporalNamespace: "tenant-c.factory", temporalHttp: { endpoint: "https://temporal.internal:7243", tls: { ...tls, caPath: join(directory, "absent-ca.pem") } } })).rejects.toThrow();
  });

  test("the barrier holds a pool slot through the client, and a full pool defers it", async () => {
    const calls: string[] = [];
    const slots = factoryPoolCheckpointClientSlots({
      acquireCheckpointSlot: async () => { calls.push("acquire"); return calls.length === 1 ? { slot: 2, token: "slot-token", expiresAt: "2026-09-22T00:00:15.000Z" } : null; },
      releaseCheckpointSlot: async token => { calls.push(`release:${token}`); return true; },
    });
    expect(await slots.acquire(signal)).toEqual({ token: "slot-token" });
    await slots.release("slot-token", signal);
    expect(await slots.acquire(signal)).toBeNull();
    expect(calls).toEqual(["acquire", "release:slot-token", "acquire"]);
  });
});
