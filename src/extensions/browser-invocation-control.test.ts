import { afterAll, beforeEach, expect, test, spyOn } from "bun:test";
import { sql } from "drizzle-orm";
import { closeTestDb, mockDbConnection, setupTestDb, getTestDb } from "../__tests__/helpers/test-pglite";
import { BrowserInvocationStore, BROWSER_REQUEST_RETENTION_MS, type BrowserInvocationInput } from "../db/queries/extension-browser-requests";
import { prepareBrowserInvocation, claimBrowserInvocation, cancelBrowserInvocation } from "./browser-invocation-control";
import { up } from "../db/migrations/add-extension-browser-requests";

mockDbConnection();
beforeEach(setupTestDb);
afterAll(closeTestDb);
const input = (): BrowserInvocationInput => ({ principalId: "owner", installationId: "installation", releaseBinding: "a".repeat(64), conversationId: "conversation", payloadDigest: "b".repeat(64), deadline: Date.now() + 60_000 });

test("cancel before dispatch persists across stores and does not require a live extension", async () => {
  const data = input();
  const ticket = await prepareBrowserInvocation(data);
  const other = new BrowserInvocationStore(getTestDb());
  expect(await cancelBrowserInvocation(data, ticket.requestId, other)).toEqual({ state: "cancelled" });
  await expect(claimBrowserInvocation(data, ticket.requestId, data.payloadDigest)).rejects.toThrow("unavailable");
  expect(await cancelBrowserInvocation(data, ticket.requestId)).toEqual({ state: "cancelled" });
});

test("cross-store cancellation aborts the controller and fences SQL effect admission", async () => {
  const data = input();
  const ticket = await prepareBrowserInvocation(data);
  const claim = await claimBrowserInvocation(data, ticket.requestId, data.payloadDigest);
  try {
    await getTestDb().transaction(transaction => claim.assertActive(transaction));
    expect(await cancelBrowserInvocation(data, ticket.requestId, new BrowserInvocationStore(getTestDb()))).toEqual({ state: "cancel_requested" });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(claim.signal.aborted).toBe(true);
    await expect(claim.assertActive()).rejects.toThrow();
    await claim.finish("failed");
    expect(await cancelBrowserInvocation(data, ticket.requestId)).toEqual({ state: "cancelled" });
  } finally { await claim.dispose(); }
});

test("one claim only; identity, payload and execution tokens cannot cross authority", async () => {
  const store = new BrowserInvocationStore(getTestDb());
  const data = input();
  const ticket = await store.prepare(data);
  for (const identity of [{ ...data, principalId: "foreign" }, { ...data, installationId: "foreign" }, { ...data, conversationId: null }, { ...data, releaseBinding: "c".repeat(64) }]) await expect(store.cancel(identity, ticket.requestId)).rejects.toThrow("unavailable");
  await expect(store.claim(data, ticket.requestId, "wrong")).rejects.toThrow("unavailable");
  const results = await Promise.allSettled([store.claim(data, ticket.requestId, data.payloadDigest), new BrowserInvocationStore(getTestDb()).claim(data, ticket.requestId, data.payloadDigest)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  await expect(store.assertActive(data, ticket.requestId, "foreign")).rejects.toThrow("unavailable");
  await expect(store.finish(data, ticket.requestId, "foreign", "succeeded")).rejects.toThrow("unavailable");
});

test("completed and abandoned invocations never dispatch again", async () => {
  for (const outcome of ["succeeded", "failed", "outcome_unknown"] as const) {
    const data = input();
    const ticket = await prepareBrowserInvocation(data);
    const claim = await claimBrowserInvocation(data, ticket.requestId, data.payloadDigest);
    await claim.finish(outcome);
    await claim.dispose();
    expect((await cancelBrowserInvocation(data, ticket.requestId)).state).toBe(outcome === "outcome_unknown" ? "outcome_unknown" : "finished");
    await expect(claimBrowserInvocation(data, ticket.requestId, data.payloadDigest)).rejects.toThrow("unavailable");
  }
});

test("database read failure aborts a live controller without replay", async () => {
  const data = input();
  const store = new BrowserInvocationStore(getTestDb());
  const ticket = await store.prepare(data);
  const claim = await claimBrowserInvocation(data, ticket.requestId, data.payloadDigest, store);
  const failure = spyOn(store, "assertActive").mockRejectedValue(new Error("database offline"));
  try {
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(claim.signal.aborted).toBe(true);
    expect(String(claim.signal.reason)).toContain("database offline");
  } finally { failure.mockRestore(); await claim.dispose(); }
  expect((await store.cancel(data, ticket.requestId)).state).toBe("outcome_unknown");
});

test("deadline and restart quarantine running work while expired unstarted tickets are cancelled", async () => {
  let now = 1000;
  const store = new BrowserInvocationStore(getTestDb(), () => now);
  const data = { ...input(), deadline: 1001 };
  const unused = await store.prepare(data);
  const running = await store.prepare(data);
  const claim = await claimBrowserInvocation(data, running.requestId, data.payloadDigest, store);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(claim.signal.aborted).toBe(true);
  now = 1002;
  await expect(store.claim(data, unused.requestId, data.payloadDigest)).rejects.toThrow("unavailable");
  await store.purge();
  expect((await store.cancel(data, unused.requestId)).state).toBe("cancelled");
  expect((await store.cancel(data, running.requestId)).state).toBe("outcome_unknown");
  now += BROWSER_REQUEST_RETENTION_MS;
  await store.purge();
  await expect(store.cancel(data, unused.requestId)).rejects.toThrow("unavailable");
  expect((await store.cancel(data, running.requestId)).state).toBe("outcome_unknown");
  await claim.dispose();
});

test("bounded owner quota is atomic and migration is idempotent", async () => {
  const store = new BrowserInvocationStore(getTestDb());
  await up(getTestDb());
  const data = input();
  for (let index = 0; index < 63; index++) await store.prepare(data);
  const attempts = await Promise.allSettled([store.prepare(data), new BrowserInvocationStore(getTestDb()).prepare(data)]);
  expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
  await getTestDb().execute(sql`DELETE FROM extension_browser_admission_lock`);
  await expect(store.prepare(data)).rejects.toThrow("unavailable");
});

test("invalid ticket inputs fail closed", async () => {
  const store = new BrowserInvocationStore(getTestDb());
  for (const invalid of [{ ...input(), principalId: "" }, { ...input(), releaseBinding: "bad" }, { ...input(), conversationId: "" }, { ...input(), payloadDigest: "bad" }, { ...input(), deadline: 0 }, { ...input(), deadline: Date.now() + 70_000 }]) await expect(store.prepare(invalid)).rejects.toThrow("valid owner-bound");
  await expect(store.cancel(input(), "bad")).rejects.toThrow("valid owner-bound");
});

test.each([
  { count: 512, owner: "owner", state: "finished" },
  { count: 10000, owner: "different-owner", state: "finished" },
  { count: 1024, owner: "different-owner", state: "running" },
])("retained and active quotas reject excess admissions: %j", async ({ count, owner, state }) => {
  const store = new BrowserInvocationStore(getTestDb());
  const data = input();
  await getTestDb().execute(sql`INSERT INTO extension_browser_requests(id,principal_id,installation_id,release_binding,conversation_id,payload_digest,deadline,retain_until,state) SELECT 'quota-' || generate_series,${owner},'installation',${data.releaseBinding},NULL,${data.payloadDigest},${data.deadline},${data.deadline + BROWSER_REQUEST_RETENTION_MS},${state} FROM generate_series(1,${count})`);
  await expect(store.prepare(data)).rejects.toThrow("capacity");
});

test("failed guarded SQL transaction commits no effect", async () => {
  const store = new BrowserInvocationStore(getTestDb());
  const data = input();
  const ticket = await store.prepare(data);
  const claim = await store.claim(data, ticket.requestId, data.payloadDigest);
  await store.cancel(data, ticket.requestId);
  await expect(getTestDb().transaction(async transaction => {
    await store.assertActive(data, ticket.requestId, claim.executionId, transaction);
    await transaction.execute(sql`DELETE FROM extension_browser_admission_lock`);
  })).rejects.toThrow("unavailable");
  expect((await store.prepare(data)).requestId).toBeDefined();
});
