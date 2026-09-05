import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeTestDb, mockDbConnection, setupTestDb } from "../__tests__/helpers/test-pglite";
import { domainEventSourceFixture } from "../__tests__/helpers/domain-event-source";
import { InvocationLocks, inspectRuntimeLocks, recoverRuntimeLock, validateRuntimeLockRequest, verifyInvocationLocks } from "./runtime-locks";
import { extensionRuntimeLocks, users, auditLog } from "../db/schema";
import type { InvocationContext } from "@ezcorp/extension-contract";

mockDbConnection();
beforeEach(setupTestDb);
afterAll(closeTestDb);
const opened: InvocationLocks[] = [];
afterEach(async () => { for (const session of opened.splice(0)) await session.close(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const data = await domainEventSourceFixture([]);
  const context: InvocationContext = { invocationId: crypto.randomUUID(), workerId: crypto.randomUUID(), releaseId: crypto.randomUUID(), principalId: data.owner.id, scopeId: data.conversation.id, token: crypto.randomUUID(), deadline: Date.now() + 60_000 };
  const create = (overrides: Partial<InvocationContext> = {}) => {
    const session = new InvocationLocks(data.installationId, { ...context, invocationId: crypto.randomUUID(), ...overrides }, 1);
    opened.push(session);
    return session;
  };
  return { ...data, context, create };
}

async function acquire(session: InvocationLocks, key = "counter"): Promise<string> {
  const response = await session.request("ezcorp/lock.acquire", { key }) as { acquired: boolean; fence: string };
  expect(response.acquired).toBe(true);
  return response.fence;
}

test("lock ownership is exclusive across invocation, principal and scope until release", async () => {
  const data = await fixture();
  const first = data.create();
  const second = data.create({ principalId: "another-principal", scopeId: "another-scope" });
  const fence = await acquire(first);
  expect(await second.request("ezcorp/lock.acquire", { key: "counter" })).toEqual({ acquired: false, retryAfterMs: 50 });
  await expect(second.request("ezcorp/lock.release", { key: "counter", fence })).rejects.toThrow("owner");
  await first.request("ezcorp/lock.release", { key: "counter", fence });
  expect(await acquire(second)).not.toBe(fence);
});

test("expired ownership is quarantined, not stolen", async () => {
  const data = await fixture();
  const first = data.create();
  await acquire(first);
  await data.database.update(extensionRuntimeLocks).set({ deadline: new Date(0) });
  await expect(data.create().request("ezcorp/lock.acquire", { key: "counter" })).rejects.toThrow("human recovery");
  expect((await inspectRuntimeLocks(data.installationId))[0]?.state).toBe("quarantined");
  await expect(first.effect("ezcorp/storage", async () => 1)).rejects.toThrow("ownership");
});

test("release waits for admitted non-SQL effects and prevents transfer during the write", async () => {
  const data = await fixture();
  const first = data.create();
  const second = data.create();
  const fence = await acquire(first);
  const started = deferred();
  const finish = deferred();
  const effect = first.effect("ezcorp/fs.write", async () => { started.resolve(); await finish.promise; return "written"; });
  await started.promise;
  let released = false;
  const release = first.request("ezcorp/lock.release", { key: "counter", fence }).then(() => { released = true; });
  await Bun.sleep(20);
  expect(released).toBe(false);
  expect((await inspectRuntimeLocks(data.installationId))[0]?.effects).toBe(1);
  expect(await second.request("ezcorp/lock.acquire", { key: "counter" })).toMatchObject({ acquired: false });
  finish.resolve();
  expect(await effect).toBe("written");
  await release;
  await acquire(second);
});

test("storage mutation checks the captured fence inside its transaction", async () => {
  const data = await fixture();
  const session = data.create();
  await acquire(session);
  const started = deferred();
  const finish = deferred();
  let wrote = false;
  const effect = session.effect("ezcorp/storage", async () => {
    started.resolve();
    await finish.promise;
    return data.database.transaction(async (transaction) => { await verifyInvocationLocks(transaction); wrote = true; });
  });
  await started.promise;
  await data.database.update(extensionRuntimeLocks).set({ fence: crypto.randomUUID() });
  finish.resolve();
  await expect(effect).rejects.toThrow("ownership");
  expect(wrote).toBe(false);
});

test("known SQL failure drains safely but uncertain non-SQL failure quarantines", async () => {
  const data = await fixture();
  const session = data.create();
  const fence = await acquire(session);
  await expect(session.effect("ezcorp/storage", async () => { throw new Error("rollback"); })).rejects.toThrow("rollback");
  await session.request("ezcorp/lock.release", { key: "counter", fence });
  await acquire(session);
  await expect(session.effect("ezcorp/fs.write", async () => { throw new Error("unknown write"); })).rejects.toThrow("unknown write");
  await session.close();
  expect((await inspectRuntimeLocks(data.installationId))[0]?.state).toBe("quarantined");
});

test("close times out waiting for effects and recovery cannot bypass a live pending write", async () => {
  const data = await fixture();
  const session = data.create();
  const fence = await acquire(session);
  const started = deferred();
  const finish = deferred();
  const effect = session.effect("ezcorp/fs.write", async () => { started.resolve(); await finish.promise; });
  await started.promise;
  await session.close();
  expect((await inspectRuntimeLocks(data.installationId))[0]).toMatchObject({ state: "quarantined", effects: 1 });
  await data.database.update(users).set({ role: "admin" }).where(eq(users.id, data.owner.id));
  await data.database.execute(sql`UPDATE extension_release_installations SET payload = (payload::jsonb || '{"enabled":false}'::jsonb)::text WHERE id = ${data.installationId}`);
  const actor = { principalId: data.owner.id, scope: "global", kind: "human" as const };
  await expect(recoverRuntimeLock(actor, data.installationId, "counter", fence, true)).rejects.toThrow("live host effects");
  finish.resolve();
  await effect;
  await recoverRuntimeLock(actor, data.installationId, "counter", fence, true);
  expect(await inspectRuntimeLocks(data.installationId)).toHaveLength(0);
  expect((await data.database.select().from(auditLog))[0]?.action).toBe("ext:lock-recovered");
}, 15_000);

test("human recovery checks role, disabled state, exact fence and explicit acknowledgement", async () => {
  const data = await fixture();
  const session = data.create();
  const fence = await acquire(session);
  await session.effect("ezcorp/network.fetch", async () => ({ error: { message: "outcome_unknown" } }));
  await session.close();
  const actor = { principalId: data.owner.id, scope: "global", kind: "human" as const };
  await expect(recoverRuntimeLock({ ...actor, kind: "agent" }, data.installationId, "counter", fence, true)).rejects.toThrow("Human administrator");
  await expect(recoverRuntimeLock(actor, data.installationId, "counter", fence, false)).rejects.toThrow("acknowledgement");
  await expect(recoverRuntimeLock(actor, data.installationId, "counter", fence, true)).rejects.toThrow("active human administrator");
  await data.database.update(users).set({ role: "admin" }).where(eq(users.id, data.owner.id));
  await expect(recoverRuntimeLock(actor, data.installationId, "counter", fence, true)).rejects.toThrow("Disable");
  await data.database.execute(sql`UPDATE extension_release_installations SET payload = (payload::jsonb || '{"enabled":false}'::jsonb)::text WHERE id = ${data.installationId}`);
  await expect(recoverRuntimeLock(actor, data.installationId, "counter", "stale", true)).rejects.toThrow("Lock changed");
  await recoverRuntimeLock(actor, data.installationId, "counter", fence, true);
  expect(await inspectRuntimeLocks(data.installationId)).toHaveLength(0);
});

test("invalid keys, duplicate ownership, closed contexts and held-key capacity fail closed", async () => {
  const data = await fixture();
  for (const [method, input] of [["other", { key: "ok" }], ["ezcorp/lock.acquire", { key: "../bad" }], ["ezcorp/lock.acquire", { key: "ok", extra: true }], ["ezcorp/lock.acquire", { key: "ok", fence: "bad" }], ["ezcorp/lock.release", { key: "ok" }]] as const) expect(() => validateRuntimeLockRequest(method, input)).toThrow();
  const session = data.create();
  for (let index = 0; index < 8; index++) await acquire(session, `key-${index}`);
  await expect(session.request("ezcorp/lock.acquire", { key: "key-0" })).rejects.toThrow("already held");
  await expect(session.request("ezcorp/lock.acquire", { key: "key-8" })).rejects.toThrow("capacity");
  await session.effect("ezcorp/storage", async () => data.database.transaction(verifyInvocationLocks));
  await session.close();
  await expect(session.request("ezcorp/lock.acquire", { key: "key" })).rejects.toThrow("closed");
  await expect(data.create({ deadline: 0 }).effect("ezcorp/storage", async () => 1)).rejects.toThrow("expired");
});

test("persisted admitted effects block recovery even after the host session closes", async () => {
  const data = await fixture();
  const session = data.create();
  const fence = await acquire(session);
  await session.effect("ezcorp/network.fetch", async () => ({ error: { message: "outcome_unknown" } }));
  await expect(session.request("ezcorp/lock.release", { key: "counter", fence })).rejects.toThrow("safe to release");
  expect((await inspectRuntimeLocks(data.installationId))[0]?.state).toBe("quarantined");
  await session.close();
  await data.database.update(extensionRuntimeLocks).set({ effects: 1 });
  await data.database.update(users).set({ role: "admin" }).where(eq(users.id, data.owner.id));
  await data.database.execute(sql`UPDATE extension_release_installations SET payload = (payload::jsonb || '{"enabled":false}'::jsonb)::text WHERE id = ${data.installationId}`);
  await expect(recoverRuntimeLock({ principalId: data.owner.id, scope: "global", kind: "human" }, data.installationId, "counter", fence, true)).rejects.toThrow("live host effects");
  expect(await inspectRuntimeLocks(data.installationId)).toHaveLength(1);
});
