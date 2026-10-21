import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonicalJson } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import { releaseRows as rows } from "../../src/db/queries/extension-releases";
import { durableInputHash } from "../../src/delivery-queue/durable-delivery-queue";
import {
  FACTORY_NOTIFICATION_SEND_BOUNDS, FactoryNotificationSender, factoryNotificationFanOutQuery, factoryNotificationSendStore, type FactoryNotificationDestinationRuntime,
} from "../../src/factory/notification-sender";
import { startTestWebhookReceiver, type TestWebhookReceiver } from "../../src/__tests__/helpers/factory-webhook-receiver";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

type Fixture = Awaited<ReturnType<typeof setupFactoryPostgres>>;
type Kind = "approval_requested" | "release_uncertain" | "release_settled" | "command_approval_requested";

const TENANT = "notify-tenant";
const PROJECT = "notify-project";
const SECRET = new TextEncoder().encode("w4h-34-test-signing-secret-0123456789");
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

let fixture: Fixture;
let receiver: TestWebhookReceiver;
let clock = NOW;
const never = new AbortController().signal;

beforeAll(async () => {
  fixture = await setupFactoryPostgres();
  await fixture.db.execute(sql`INSERT INTO factory_installation(singleton,tenant_id,execution_epoch) VALUES (1,${TENANT},1)`);
  await fixture.db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${PROJECT},'Notify',${`/tmp/${PROJECT}`})`);
  // The receiver keeps the test's clock, as the sender does, so its replay bound (N3) judges the same time.
  receiver = await startTestWebhookReceiver({ secret: SECRET, now: () => clock });
}, 60_000);
afterAll(async () => { await receiver.stop(); await fixture.close(); });

beforeEach(async () => {
  clock = NOW;
  receiver.reset();
  await fixture.db.execute(sql`DELETE FROM factory_notification_sends`);
  await fixture.db.execute(sql`DELETE FROM factory_notifications`);
  await fixture.db.execute(sql`INSERT INTO factory_projects(tenant_id,project_id) VALUES (${TENANT},${PROJECT}) ON CONFLICT DO NOTHING`);
});
afterEach(() => { receiver.onRequest(null); });

/** Stores a notification exactly as `FactoryReleases` does, so the sender's decoder accepts it. */
async function notification(kind: Kind, payload: Record<string, unknown>, options: { state?: string; createdAt?: number; subject?: string; project?: string; id?: string } = {}): Promise<string> {
  const project = options.project ?? PROJECT;
  const id = options.id ?? randomUUID();
  const subjectId = options.subject ?? `subject-${id.slice(0, 8)}`;
  const subject = kind === "command_approval_requested" ? { approvalId: subjectId } : { operationId: subjectId };
  const inputHash = durableInputHash({ kind, ...subject, payload });
  const createdAt = options.createdAt ?? NOW;
  const record = { id, tenantId: TENANT, projectId: project, deduplicationId: `${kind}:${subjectId}`, inputHash, kind, ...subject, payload, state: "queued", attempts: 1, maxAttempts: 5, availableAt: createdAt, leaseUntil: 0, createdAt };
  await fixture.db.execute(sql`INSERT INTO factory_notifications (tenant_id,project_id,notification_id,deduplication_id,input_hash,state,available_at,lease_until,payload)
    VALUES (${TENANT},${project},${id},${record.deduplicationId},${inputHash},${options.state ?? "delivered"},${createdAt},0,${canonicalJson(record)})`);
  return id;
}

function destination(name = "operators", overrides: Partial<FactoryNotificationDestinationRuntime> = {}): FactoryNotificationDestinationRuntime {
  return { name, url: receiver.url, ca: receiver.ca, secret: SECRET, ...overrides };
}

function sender(destinations = [destination()], options: { leaseMs?: number; requestTimeoutMs?: number } = {}): FactoryNotificationSender {
  return new FactoryNotificationSender({ database: fixture.db as never, tenantId: TENANT, destinations, now: () => clock, heartbeat: () => () => undefined, ...options });
}

async function sends(): Promise<Array<{ notification_id: string; destination: string; state: string; attempts: number; failure_code: string | null; available_at: string; lease_until: string }>> {
  // A plain array: the driver's result array carries extra properties that an object match would compare.
  return [...rows<never>(await fixture.db.execute(sql`SELECT notification_id,destination,state,attempts,failure_code,available_at::text,lease_until::text FROM factory_notification_sends ORDER BY destination,notification_id`))];
}

describe("fan-out (C11 N1)", () => {
  test("adds one send per delivered notification of a sent kind and per destination, once", async () => {
    await notification("approval_requested", { approvalId: "approval-1", expiresAtMs: NOW + 3_600_000 });
    await notification("release_uncertain", { dispatchGeneration: 1, code: "provider_response_unknown" });
    await notification("release_settled", { dispatchGeneration: 1, providerReceiptId: "r" });
    await notification("approval_requested", { approvalId: "approval-2", expiresAtMs: NOW + 3_600_000 }, { state: "queued" });
    const twoDestinations = sender([destination("a"), destination("b")]);
    expect(await twoDestinations.fanOut(never)).toBe(true);
    const found = await sends();
    expect(found).toHaveLength(4);
    expect(found.every((row) => row.state === "queued" && row.attempts === 0)).toBe(true);
    expect(await twoDestinations.fanOut(never)).toBe(false);
    expect(await sends()).toHaveLength(4);
  });

  test("skips a notification already past its expiry: no send row, nothing sent", async () => {
    await notification("approval_requested", { approvalId: "approval-1", expiresAtMs: NOW - 1 });
    await notification("release_uncertain", { code: "provider_response_unknown" }, { createdAt: NOW - FACTORY_NOTIFICATION_SEND_BOUNDS.expiryMs });
    const one = sender();
    expect(await one.step(never)).toBe(false);
    expect(await sends()).toEqual([]);
    expect(receiver.requests).toHaveLength(0);
  });

  test("two notifications whose identifiers share a joined form each get their own send (F1)", async () => {
    for (const project of ["a:b", "a"]) {
      await fixture.db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${project},'Colon',${`/tmp/${project}`}) ON CONFLICT DO NOTHING`);
      await fixture.db.execute(sql`INSERT INTO factory_projects(tenant_id,project_id) VALUES (${TENANT},${project}) ON CONFLICT DO NOTHING`);
    }
    // project "a:b" with notification "c", and project "a" with notification "b:c": both join to "a:b:c".
    await notification("release_uncertain", { code: "provider_response_unknown" }, { project: "a:b", id: "c" });
    await notification("release_uncertain", { code: "provider_response_unknown" }, { project: "a", id: "b:c" });
    expect(await sender().fanOut(never)).toBe(true);
    expect((await sends()).map((row) => row.notification_id).sort()).toEqual(["b:c", "c"]);
    await fixture.db.execute(sql`DELETE FROM factory_notification_sends`);
    await fixture.db.execute(sql`DELETE FROM factory_notifications WHERE project_id IN ('a:b','a')`);
  });

  test("the fan-out finds existing sends through the index on (tenant, project, notification, destination) (F5)", async () => {
    // A table the size a long-lived installation reaches, analyzed, so the plan is the one production gets. The
    // transaction rolls back: the bulk rows exist only for this plan (foreign keys off, as the metric fixtures do).
    const rollback = new Error("rollback");
    let plan = "";
    await fixture.db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL session_replication_role = replica`);
      await transaction.execute(sql`INSERT INTO factory_notification_sends (tenant_id,project_id,send_id,notification_id,destination,deduplication_id,input_hash,state,max_attempts,available_at,expires_at,payload,created_at)
        SELECT ${TENANT}, ${PROJECT}, 'bulk-' || i, 'bulk-' || i, 'operators', 'bulk-' || i, ${`sha256:${"e".repeat(64)}`}, 'delivered', 8, 0, 0, '{}', 0 FROM generate_series(1, 20000) AS i`);
      await transaction.execute(sql`ANALYZE factory_notification_sends`);
      plan = rows<Record<string, string>>(await transaction.execute(sql`EXPLAIN ${factoryNotificationFanOutQuery(TENANT, "operators", NOW)}`)).map((row) => Object.values(row)[0]).join("\n");
      throw rollback;
    }).catch((error: unknown) => { if (error !== rollback) throw error; });
    // All four columns are index conditions: an index used on its tenant and project prefix alone still reads
    // every send of the project on each pass.
    const lines = plan.split("\n");
    const scan = lines.findIndex((line) => line.includes("idx_factory_notification_sends_notification"));
    expect(scan).toBeGreaterThanOrEqual(0);
    const condition = lines.slice(scan + 1).find((line) => line.trim().startsWith("Index Cond:")) ?? "";
    for (const column of ["tenant_id", "project_id", "notification_id", "destination"]) expect(condition).toContain(`(${column} = `);
  });

  test("a notification that cannot be sent is recorded as a dead-letter send once, and the fan-out moves on", async () => {
    const quotes = '"'.repeat(512);
    await fixture.db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${quotes},'Quoted','/tmp/quoted') ON CONFLICT DO NOTHING`);
    await fixture.db.execute(sql`INSERT INTO factory_projects(tenant_id,project_id) VALUES (${TENANT},${quotes}) ON CONFLICT DO NOTHING`);
    // The longest identifiers the release store accepts: its deduplication ID, `<kind>:<operation>`, stays within 512.
    const refused = await notification("approval_requested", { approvalId: quotes, expiresAtMs: NOW + 3_600_000 }, { subject: '"'.repeat(490), project: quotes });
    const sendable = await notification("release_uncertain", { code: "provider_response_unknown" });
    // A stored notification that no longer matches its own input hash is recorded too, never re-read every pass.
    const corrupt = await notification("release_uncertain", { code: "provider_response_unknown" });
    await fixture.db.execute(sql`UPDATE factory_notifications SET input_hash=${`sha256:${"0".repeat(64)}`} WHERE notification_id=${corrupt}`);
    const one = sender();
    expect(await one.fanOut(never)).toBe(true);
    const found = rows<{ notification_id: string; state: string; failure_code: string | null }>(await fixture.db.execute(sql`SELECT notification_id,state,failure_code FROM factory_notification_sends ORDER BY state`));
    const byJson = (left: unknown, right: unknown) => JSON.stringify(left).localeCompare(JSON.stringify(right));
    expect([...found].sort(byJson)).toEqual([
      { notification_id: corrupt, state: "dead_letter", failure_code: "factory_notification_corrupt" },
      { notification_id: refused, state: "dead_letter", failure_code: "notification_payload_too_large" },
      { notification_id: sendable, state: "queued", failure_code: null },
    ].sort(byJson));
    expect(await one.fanOut(never)).toBe(false);
    expect(await one.step(never)).toBe(true);
    expect(receiver.requests).toHaveLength(1);
    expect(receiver.requests[0]!.body).not.toContain(quotes);
    await fixture.db.execute(sql`DELETE FROM factory_notification_sends`);
    await fixture.db.execute(sql`DELETE FROM factory_notifications WHERE project_id=${quotes} OR notification_id=${corrupt}`);
  });

  test("a command approval expires at its own deadline", async () => {
    const approvalId = "approval-cmd-1";
    await notification("command_approval_requested", { approvalId }, { subject: approvalId });
    // The approval row's run and audit parents are not under test here.
    await fixture.db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL session_replication_role = replica`);
      await transaction.execute(sql`INSERT INTO factory_command_approvals (tenant_id,project_id,approval_id,run_id,interpreter_id,command_id,source_sequence,source_digest,node_instance_id,candidate_generation,attempt,definition_digest,execution_epoch,cancellation_epoch,initiator_kind,initiator_id,actor_scope,choices_json,context_json,deadline_at_ms,context_digest,protected_digest,status)
        VALUES (${TENANT},${PROJECT},${approvalId},'run-1','interp-1','cmd-1',1,${"a".repeat(64)},'node-1',0,1,${`sha256:${"b".repeat(64)}`},1,0,'user','u1','owner','["ok"]','{}',${NOW + 120_000},${"c".repeat(64)},${`sha256:${"d".repeat(64)}`},'pending')`);
    });
    await sender().fanOut(never);
    const [row] = rows<{ expires_at: string }>(await fixture.db.execute(sql`SELECT expires_at::text FROM factory_notification_sends`));
    expect(Number(row!.expires_at)).toBe(NOW + 120_000);
  });
});

describe("sending (C11 N3, N5, N6)", () => {
  test("delivers a signed request with stable identifiers and settles it delivered", async () => {
    const id = await notification("release_uncertain", { dispatchGeneration: 1, code: "provider_response_unknown" });
    const one = sender();
    expect(await one.step(never)).toBe(true);
    expect(await sends()).toMatchObject([{ notification_id: id, state: "delivered", attempts: 1, lease_until: "0" }]);
    const [request] = receiver.requests;
    expect(request).toMatchObject({ signatureValid: true });
    expect(request!.idempotencyKey).toMatch(/^fn1-[a-f0-9]{64}$/);
    expect(JSON.parse(request!.body)).toMatchObject({ schema: "factory.notification.v1", kind: "release_uncertain", notificationId: id, idempotencyKey: request!.idempotencyKey });
    expect(request!.body).not.toContain(TENANT);
  });

  test("retries a 5xx, a 429 and an unreachable receiver with backoff, under the same key", async () => {
    await notification("release_uncertain", { code: "provider_response_unknown" });
    const one = sender();
    receiver.answer(503);
    await one.step(never);
    expect(await sends()).toMatchObject([{ state: "queued", attempts: 1, failure_code: "webhook_status_5xx", available_at: String(NOW + 1_000) }]);
    clock += 1_000;
    receiver.answer(429);
    await one.step(never);
    expect(await sends()).toMatchObject([{ state: "queued", attempts: 2, failure_code: "webhook_status_429", available_at: String(NOW + 1_000 + 2_000) }]);
    clock += 2_000;
    const unreachable = sender([destination("operators", { url: "https://127.0.0.1:9/hook" })]);
    await unreachable.step(never);
    expect(await sends()).toMatchObject([{ state: "queued", attempts: 3, failure_code: "webhook_unreachable" }]);
    expect(new Set(receiver.requests.map((request) => request.idempotencyKey)).size).toBe(1);
  });

  test("a request that outlives its timeout is retried as webhook_timeout", async () => {
    await notification("release_uncertain", { code: "provider_response_unknown" });
    let release!: () => void;
    receiver.onRequest(() => new Promise<void>((resolve) => { release = resolve; }));
    await sender([destination()], { requestTimeoutMs: 200 }).step(never);
    release();
    expect(await sends()).toMatchObject([{ state: "queued", attempts: 1, failure_code: "webhook_timeout" }]);
  });

  test("a rejection goes to dead letter, and so does a send whose attempts ran out", async () => {
    await notification("release_uncertain", { code: "provider_response_unknown" });
    receiver.answer(400);
    await sender().step(never);
    expect(await sends()).toMatchObject([{ state: "dead_letter", failure_code: "webhook_rejected_4xx" }]);
    await fixture.db.execute(sql`DELETE FROM factory_notification_sends`);
    await sender().fanOut(never);
    await fixture.db.execute(sql`UPDATE factory_notification_sends SET attempts=${FACTORY_NOTIFICATION_SEND_BOUNDS.maxAttempts}`);
    receiver.answer(200);
    // A claim that dead-letters an exhausted row is progress: the worker does not back off while due rows wait.
    expect(await sender().sendOne(never)).toBe(true);
    expect(await sends()).toMatchObject([{ state: "dead_letter", failure_code: "attempts_exhausted" }]);
    expect(receiver.requests).toHaveLength(1);
  });

  test("a retryable failure on the last allowed attempt settles attempts_exhausted, not its retry code", async () => {
    await notification("release_uncertain", { code: "provider_response_unknown" });
    await sender().fanOut(never);
    await fixture.db.execute(sql`UPDATE factory_notification_sends SET attempts=${FACTORY_NOTIFICATION_SEND_BOUNDS.maxAttempts - 1}`);
    receiver.answer(503);
    expect(await sender().sendOne(never)).toBe(true);
    expect(await sends()).toMatchObject([{ state: "dead_letter", attempts: FACTORY_NOTIFICATION_SEND_BOUNDS.maxAttempts, failure_code: "attempts_exhausted" }]);
  });

  test("a send interrupted by this process's shutdown is released without spending an attempt (F8)", async () => {
    await notification("release_uncertain", { code: "provider_response_unknown" });
    await sender().fanOut(never);
    const stopping = new AbortController();
    receiver.onRequest(async () => { stopping.abort(); await Bun.sleep(50); });
    await sender().sendOne(stopping.signal);
    receiver.onRequest(null);
    expect(await sends()).toMatchObject([{ state: "queued", attempts: 0, available_at: String(NOW), lease_until: "0" }]);
    expect(await sender().sendOne(never)).toBe(true);
    expect(await sends()).toMatchObject([{ state: "delivered", attempts: 1 }]);
  });

  test("the send half still runs when the fan-out fails, and the fault is still reported", async () => {
    await notification("release_uncertain", { code: "provider_response_unknown" });
    await sender().fanOut(never);
    const one = sender();
    one.fanOut = async () => { throw new Error("fan-out fault"); };
    await expect(one.step(never)).rejects.toThrow("fan-out fault");
    expect(await sends()).toMatchObject([{ state: "delivered" }]);
  });

  test("cancels a send whose destination is no longer declared, and one that expired while queued", async () => {
    await notification("release_uncertain", { code: "provider_response_unknown" });
    await sender([destination("gone")]).fanOut(never);
    expect(await sender([destination("kept")]).sendOne(never)).toBe(true);
    expect((await sends()).find((row) => row.destination === "gone")).toMatchObject({ state: "cancelled", failure_code: "destination_removed" });
    await fixture.db.execute(sql`DELETE FROM factory_notification_sends`);
    await sender().fanOut(never);
    clock = NOW + FACTORY_NOTIFICATION_SEND_BOUNDS.expiryMs;
    await sender().sendOne(never);
    expect(await sends()).toMatchObject([{ state: "cancelled", failure_code: "notification_expired" }]);
    expect(receiver.requests).toHaveLength(0);
  });

  test("a corrupt send row is dead-lettered once and the sends behind it still go (F2)", async () => {
    const first = await notification("release_uncertain", { code: "provider_response_unknown" }, { createdAt: NOW - 1 });
    const second = await notification("release_uncertain", { code: "provider_response_unknown" });
    await sender().fanOut(never);
    await fixture.db.execute(sql`UPDATE factory_notification_sends SET input_hash=${`sha256:${"0".repeat(64)}`} WHERE notification_id=${first}`);
    const one = sender();
    expect(await one.sendOne(never)).toBe(true);
    expect(await one.sendOne(never)).toBe(true);
    expect((await sends()).map((row) => [row.notification_id, row.state, row.failure_code]).sort()).toEqual([
      [first, "dead_letter", "notification_send_corrupt"], [second, "delivered", null],
    ].sort());
    expect(receiver.requests).toHaveLength(1);
    await fixture.db.execute(sql`UPDATE factory_notification_sends SET payload=${"{\"schema\":\"forged\"}"}`);
    const store = factoryNotificationSendStore(fixture.db as never, TENANT);
    await expect(store.inspect("another-tenant", "x")).rejects.toMatchObject({ code: "notification_send_scope" });
    // A payload that is not JSON at all is refused by name at the store too, and the quarantine takes it.
    await fixture.db.execute(sql`UPDATE factory_notification_sends SET payload='not json', state='queued', available_at=${clock}`);
    await expect(store.claimCandidate(TENANT, clock)).rejects.toMatchObject({ code: "notification_send_corrupt" });
    expect(await store.quarantineCandidate(TENANT, clock)).toBe(true);
    expect(await store.quarantineCandidate(TENANT, clock)).toBe(true);
    expect(await store.quarantineCandidate(TENANT, clock)).toBe(false);
  });
});

describe("readiness confirmation (C11 N8)", () => {
  test("is false until a receiver accepts a send, then true at once and after a restart", async () => {
    await notification("release_uncertain", { code: "provider_response_unknown" });
    const first = sender();
    expect(await first.refreshConfirmation()).toBe(false);
    let calls = 0;
    const unsubscribe = first.onConfirmed(() => { calls += 1; });
    receiver.answer(503);
    await first.step(never);
    expect(first.confirmed()).toBe(false);
    clock += 1_000;
    receiver.answer(200);
    await first.step(never);
    expect(first.confirmed()).toBe(true);
    expect(calls).toBe(1);
    unsubscribe();
    const restarted = sender();
    expect(restarted.confirmed()).toBe(false);
    expect(await restarted.refreshConfirmation()).toBe(true);
    expect(await restarted.refreshConfirmation()).toBe(true);
  });
});

describe("re-drive after a lost settlement (C11 N7)", () => {
  test("a lapsed lease is reclaimed under the same key, and the stale owner cannot settle", async () => {
    await notification("release_uncertain", { code: "provider_response_unknown" });
    const stuck = new AbortController();
    let held!: () => void;
    receiver.onRequest(() => new Promise<void>((resolve) => { held = resolve; }));
    const first = sender([destination()], { leaseMs: 100 }).step(stuck.signal);
    while (receiver.requests.length === 0) await Bun.sleep(5);
    receiver.onRequest(null);
    clock += 100;
    expect(await sender([destination()], { leaseMs: 100 }).step(never)).toBe(true);
    held();
    await expect(first).rejects.toMatchObject({ code: "delivery_lease_lost" });
    expect(await sends()).toMatchObject([{ state: "delivered", attempts: 2 }]);
    expect(receiver.requests).toHaveLength(2);
    expect(receiver.requests[0]!.idempotencyKey).toBe(receiver.requests[1]!.idempotencyKey);
    expect(receiver.logical().size).toBe(1);
  });

  test("a sender process killed between the send and the settlement is re-driven once, logically", async () => {
    // The child signs on the real clock; so does the receiver for this test.
    clock = Date.now();
    await notification("approval_requested", { approvalId: "approval-1", expiresAtMs: Date.now() + 3_600_000 }, { createdAt: Date.now() });
    const leaseMs = 1_000;
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "notification-send-child.ts")], {
      cwd: join(import.meta.dir, "..", ".."),
      env: { ...process.env, FACTORY_NOTIFY_CHILD: JSON.stringify({ databaseUrl: fixture.databaseUrl, tenantId: TENANT, leaseMs, destination: { name: "operators", url: receiver.url, ca: receiver.ca, secret: Buffer.from(SECRET).toString("base64") } }) },
      stdout: "pipe", stderr: "ignore",
    });
    // The child's fan-out runs on the real clock; its claim follows. Kill it
    // when its request arrives, before the receiver answers.
    let killed!: () => void;
    const killedSignal = new Promise<void>((resolve) => { killed = resolve; });
    receiver.onRequest(async () => { child.kill("SIGKILL"); await child.exited; killed(); });
    await killedSignal;
    receiver.onRequest(null);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(child.signalCode).toBe("SIGKILL");
    const [leased] = rows<{ state: string; attempts: number; lease_until: string }>(await fixture.db.execute(sql`SELECT state,attempts,lease_until::text FROM factory_notification_sends`));
    expect(leased).toMatchObject({ state: "leased", attempts: 1 });
    const realClock = new FactoryNotificationSender({ database: fixture.db as never, tenantId: TENANT, destinations: [destination()], leaseMs, heartbeat: () => () => undefined, now: () => Number(leased!.lease_until) });
    expect(await realClock.sendOne(never)).toBe(true);
    expect(await sends()).toMatchObject([{ state: "delivered", attempts: 2 }]);
    expect(receiver.requests).toHaveLength(2);
    // Two physical requests, one logical delivery: the receiver deduplicated on the key.
    expect(receiver.logical().size).toBe(1);
    expect(receiver.requests[0]!.idempotencyKey).not.toBeNull();
    expect(receiver.requests[0]!.idempotencyKey).toBe(receiver.requests[1]!.idempotencyKey);
    expect(receiver.requests[0]!.deliveryId).toBe(receiver.requests[1]!.deliveryId);
  });
});
