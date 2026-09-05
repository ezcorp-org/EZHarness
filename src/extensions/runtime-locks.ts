import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { ContractError, MAX_RUNTIME_LOCK_KEYS, validateRuntimeLockKey, validateRuntimeLockRequest, type InvocationContext } from "@ezcorp/extension-contract";
import { getDb, type DbTransaction } from "../db/connection";
import type { MigrationDb } from "../db/migrations/types";
import { releaseRows } from "../db/queries/extension-releases";
import { insertTransactionalAuditEntry } from "../db/queries/audit-log";
import type { LifecycleActor } from "./v4/types";

interface Fence { installationId: string; key: string; fence: string; invocationId: string }
interface LockRow extends Fence { workerId: string; releaseId: string; generation: number; principalId: string; scopeId: string; deadline: Date; state: "held" | "quarantined"; effects: number }
const columns = sql`installation_id AS "installationId", lock_key AS key, fence, invocation_id AS "invocationId", worker_id AS "workerId", release_id AS "releaseId", generation, principal_id AS "principalId", scope_id AS "scopeId", deadline, state, effects`;
const activeEffects = new AsyncLocalStorage<readonly Fence[]>();
const sessions = new Map<string, InvocationLocks>();
export { MAX_RUNTIME_LOCK_KEYS, validateRuntimeLockRequest } from "@ezcorp/extension-contract";
const maxEffects = 32;
const safeFailedEffects = new Set(["ezcorp/storage", "ezcorp/fs.read", "ezcorp/fs.list", "ezcorp/fs.stat", "ezcorp/fs.exists"]);

async function rowsFor(database: MigrationDb, fence: Pick<Fence, "installationId" | "key">): Promise<LockRow | undefined> {
  return releaseRows<LockRow>(await database.execute(sql`SELECT ${columns} FROM extension_runtime_locks WHERE installation_id = ${fence.installationId} AND lock_key = ${fence.key} FOR UPDATE`))[0];
}

async function verify(database: MigrationDb, fences: readonly Fence[], deadline = true): Promise<void> {
  for (const fence of [...fences].sort((left, right) => left.key.localeCompare(right.key))) {
    const row = await rowsFor(database, fence);
    if (!row || row.fence !== fence.fence || row.invocationId !== fence.invocationId || row.state !== "held" || deadline && new Date(row.deadline).getTime() <= Date.now()) throw new ContractError("LOCK_FENCED", "Lock ownership has expired, changed or requires recovery");
  }
}

export async function verifyInvocationLocks(database: MigrationDb): Promise<void> {
  await verify(database, activeEffects.getStore() ?? []);
}

export class InvocationLocks {
  private held = new Map<string, Fence>();
  private pending = new Set<Promise<unknown>>();
  private closed = false;
  private uncertain = false;

  constructor(private readonly installationId: string, private readonly context: InvocationContext, private readonly generation: number) {}

  private check(): void {
    if (this.closed || this.context.deadline <= Date.now()) throw new ContractError("LOCK_CLOSED", "Lock invocation is closed or expired");
  }

  async request(method: string, input: Record<string, unknown>): Promise<unknown> {
    this.check();
    const key = validateRuntimeLockRequest(method, input);
    if (method === "ezcorp/lock.acquire") {
      if (this.held.has(key)) throw new ContractError("INVALID_LOCK", "Lock already held");
      if (this.held.size >= MAX_RUNTIME_LOCK_KEYS || sessions.size >= 4096 && !sessions.has(this.context.invocationId)) throw new ContractError("LOCK_CAPACITY", "Lock capacity reached");
      const fence: Fence = { installationId: this.installationId, key, fence: crypto.randomUUID(), invocationId: this.context.invocationId };
      const acquired = await getDb().transaction(async (transaction: DbTransaction) => {
        await transaction.execute(sql`LOCK TABLE extension_runtime_locks IN SHARE ROW EXCLUSIVE MODE`);
        const existing = await rowsFor(transaction, fence);
        if (existing) {
          if (existing.state === "quarantined" || new Date(existing.deadline).getTime() <= Date.now()) {
            await transaction.execute(sql`UPDATE extension_runtime_locks SET state = 'quarantined' WHERE installation_id = ${this.installationId} AND lock_key = ${key}`);
            return "quarantined" as const;
          }
          return false;
        }
        const [capacity] = releaseRows<{ total: number; owned: number; invocation: number }>(await transaction.execute(sql`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE installation_id = ${this.installationId})::int AS owned, COUNT(*) FILTER (WHERE invocation_id = ${this.context.invocationId})::int AS invocation FROM extension_runtime_locks`));
        if ((capacity?.total ?? 0) >= 4096 || (capacity?.owned ?? 0) >= 128 || (capacity?.invocation ?? 0) >= MAX_RUNTIME_LOCK_KEYS) throw new ContractError("LOCK_CAPACITY", "Lock capacity reached");
        await transaction.execute(sql`INSERT INTO extension_runtime_locks (installation_id, lock_key, fence, invocation_id, worker_id, release_id, generation, principal_id, scope_id, deadline, state) VALUES (${this.installationId}, ${key}, ${fence.fence}, ${this.context.invocationId}, ${this.context.workerId}, ${this.context.releaseId}, ${this.generation}, ${this.context.principalId}, ${this.context.scopeId}, ${new Date(this.context.deadline)}, 'held')`);
        return true;
      });
      if (acquired === "quarantined") throw new ContractError("LOCK_QUARANTINED", "Lock requires human recovery through extension control");
      if (!acquired) return { acquired: false, retryAfterMs: 50 };
      this.held.set(key, fence);
      if (this.closed || this.context.deadline <= Date.now()) { await this.quarantine(); throw new ContractError("LOCK_CLOSED", "Invocation ended during lock admission"); }
      sessions.set(this.context.invocationId, this);
      return { acquired: true, fence: fence.fence };
    }
    const fence = this.held.get(key);
    if (!fence || input.fence !== fence.fence) throw new ContractError("LOCK_FENCED", "Lock release does not match its owner");
    if (!(await this.drain())) { await this.quarantine(); throw new ContractError("LOCK_QUARANTINED", "Admitted effects did not settle; lock requires recovery"); }
    try { await this.release(fence); }
    catch (error) { await this.quarantine(); throw error; }
    return { released: true };
  }

  async effect<Result>(method: string, action: () => Promise<Result>, admission?: { prepare?: () => Promise<void>; assertActive: () => void }): Promise<Result> {
    this.check();
    if (this.pending.size >= maxEffects) throw new ContractError("LOCK_CAPACITY", "Too many concurrent host effects");
    const fences = [...this.held.values()];
    const operation = (async () => {
      if (fences.length) await getDb().transaction(async (transaction: DbTransaction) => {
        await verify(transaction, fences);
        for (const fence of fences) await transaction.execute(sql`UPDATE extension_runtime_locks SET effects = effects + 1 WHERE installation_id = ${fence.installationId} AND lock_key = ${fence.key} AND fence = ${fence.fence}`);
      });
      let admitted = false;
      try {
        if (admission?.prepare) await admission.prepare();
        admission?.assertActive();
        admitted = true;
        const result = await activeEffects.run(fences, action);
        if (result && typeof result === "object" && "error" in result && JSON.stringify(result.error).includes("outcome_unknown")) this.uncertain = true;
        return result;
      } catch (error) {
        if (admitted && !safeFailedEffects.has(method)) this.uncertain = true;
        throw error;
      } finally {
        for (const fence of fences) await getDb().execute(sql`UPDATE extension_runtime_locks SET effects = effects - 1 WHERE installation_id = ${fence.installationId} AND lock_key = ${fence.key} AND fence = ${fence.fence} AND effects > 0`);
      }
    })();
    this.pending.add(operation);
    try { return await operation; }
    finally { this.pending.delete(operation); if (this.closed && this.pending.size === 0) sessions.delete(this.context.invocationId); }
  }

  private async drain(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.allSettled([...this.pending]).then(() => this.pending.size === 0), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 5000); })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async quarantine(): Promise<void> {
    for (const fence of this.held.values()) await getDb().execute(sql`UPDATE extension_runtime_locks SET state = 'quarantined' WHERE installation_id = ${fence.installationId} AND lock_key = ${fence.key} AND fence = ${fence.fence}`);
  }

  private async release(fence: Fence): Promise<void> {
    await getDb().transaction(async (transaction: DbTransaction) => {
      const row = await rowsFor(transaction, fence);
      if (!row || row.fence !== fence.fence || row.invocationId !== this.context.invocationId || row.effects !== 0 || row.state !== "held" || this.uncertain) throw new ContractError("LOCK_QUARANTINED", "Lock is not safe to release");
      await transaction.execute(sql`DELETE FROM extension_runtime_locks WHERE installation_id = ${fence.installationId} AND lock_key = ${fence.key} AND fence = ${fence.fence}`);
    });
    this.held.delete(fence.key);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.held.size) {
      if (await this.drain() && !this.uncertain) {
        try { for (const fence of this.held.values()) await this.release(fence); }
        catch { await this.quarantine(); }
      } else await this.quarantine();
    }
    if (this.pending.size === 0) sessions.delete(this.context.invocationId);
  }
}

export async function inspectRuntimeLocks(installationId: string): Promise<LockRow[]> {
  return releaseRows<LockRow>(await getDb().execute(sql`SELECT ${columns} FROM extension_runtime_locks WHERE installation_id = ${installationId} ORDER BY lock_key LIMIT 128`));
}

export async function recoverRuntimeLock(actor: LifecycleActor, installationId: string, key: unknown, expectedFence: unknown, acknowledgeUncertainEffects: unknown): Promise<void> {
  const lockKey = validateRuntimeLockKey(key);
  if (actor.kind !== "human" || acknowledgeUncertainEffects !== true || typeof expectedFence !== "string") throw new ContractError("HUMAN_ADMIN_REQUIRED", "Human administrator acknowledgement of reconciled effects is required");
  await getDb().transaction(async (transaction: DbTransaction) => {
    const [user] = releaseRows<{ role: string; status: string }>(await transaction.execute(sql`SELECT role, status FROM users WHERE id = ${actor.principalId} FOR SHARE`));
    if (user?.role !== "admin" || user.status !== "active") throw new ContractError("HUMAN_ADMIN_REQUIRED", "An active human administrator is required");
    const [installation] = releaseRows<{ enabled: boolean }>(await transaction.execute(sql`SELECT (payload::jsonb->>'enabled')::boolean AS enabled FROM extension_release_installations WHERE id = ${installationId} FOR SHARE`));
    if (!installation || installation.enabled) throw new ContractError("LOCK_RECOVERY_DENIED", "Disable the installation before recovering locks");
    const row = await rowsFor(transaction, { installationId, key: lockKey });
    if (!row || row.fence !== expectedFence || row.state !== "quarantined" || row.effects !== 0 || sessions.has(row.invocationId)) throw new ContractError("LOCK_RECOVERY_DENIED", "Lock changed, is not quarantined, or still has live host effects");
    await insertTransactionalAuditEntry(transaction, crypto.randomUUID(), actor.principalId, "ext:lock-recovered", installationId, { key: lockKey, fence: row.fence, invocationId: row.invocationId, workerId: row.workerId, pendingEffects: row.effects, acknowledgedUncertainEffects: true });
    await transaction.execute(sql`DELETE FROM extension_runtime_locks WHERE installation_id = ${installationId} AND lock_key = ${lockKey} AND fence = ${expectedFence}`);
  });
}
