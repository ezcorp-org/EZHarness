import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonicalJson } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import { releaseRows as rows } from "../../src/db/queries/extension-releases";
import { durableInputHash } from "../../src/delivery-queue/durable-delivery-queue";
import {
  FACTORY_NOTIFICATION_SEND_BOUNDS, FactoryNotificationSender, factoryNotificationSendStore, type FactoryNotificationDestinationRuntime,
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
  receiver = await startTestWebhookReceiver({ secret: SECRET });
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
async function notification(kind: Kind, payload: Record<string, unknown>, options: { state?: string; createdAt?: number; subject?: string } = {}): Promise<string> {
  const id = randomUUID();
  const subjectId = options.subject ?? `subject-${id.slice(0, 8)}`;
  const subject = kind === "command_approval_requested" ? { approvalId: subjectId } : { operationId: subjectId };
  const inputHash = durableInputHash({ kind, ...subject, payload });
  const createdAt = options.createdAt ?? NOW;
  const record = { id, tenantId: TENANT, projectId: PROJECT, deduplicationId: `${kind}:${subjectId}`, inputHash, kind, ...subject, payload, state: "queued", attempts: 1, maxAttempts: 5, availableAt: createdAt, leaseUntil: 0, createdAt };
  await fixture.db.execute(sql`INSERT INTO factory_notifications (tenant_id,project_id,notification_id,deduplication_id,input_hash,state,available_at,lease_until,payload)
    VALUES (${TENANT},${PROJECT},${id},${record.deduplicationId},${inputHash},${options.state ?? "delivered"},${createdAt},0,${canonicalJson(record)})`);
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

  test("records a notification that expired before it could be sent as cancelled, and never sends it", async () => {
    await notification("approval_requested", { approvalId: "approval-1", expiresAtMs: NOW - 1 });
    const one = sender();
    expect(await one.step(never)).toBe(true);
    expect(await sends()).toMatchObject([{ state: "cancelled", failure_code: "notification_expired" }]);
    expect(receiver.requests).toHaveLength(0);
    expect(await one.step(never)).toBe(false);
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
    expect(await sender().sendOne(never)).toBe(false);
    expect(await sends()).toMatchObject([{ state: "dead_letter", failure_code: "attempts_exhausted" }]);
    expect(receiver.requests).toHaveLength(1);
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

  test("a corrupt send row is refused by name, not sent", async () => {
    await notification("release_uncertain", { code: "provider_response_unknown" });
    await sender().fanOut(never);
    await fixture.db.execute(sql`UPDATE factory_notification_sends SET payload=${"{\"schema\":\"forged\"}"}`);
    await expect(sender().sendOne(never)).rejects.toMatchObject({ code: "notification_send_corrupt" });
    expect(receiver.requests).toHaveLength(0);
    const store = factoryNotificationSendStore(fixture.db as never, TENANT);
    await expect(store.inspect("another-tenant", "x")).rejects.toMatchObject({ code: "notification_send_scope" });
    await fixture.db.execute(sql`UPDATE factory_notification_sends SET payload='not json'`);
    await expect(store.claimCandidate(TENANT, clock)).rejects.toMatchObject({ code: "notification_send_corrupt" });
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
    expect(receiver.requests[0]!.idempotencyKey).not.toBeNull();
    expect(receiver.requests[0]!.idempotencyKey).toBe(receiver.requests[1]!.idempotencyKey);
    expect(receiver.requests[0]!.deliveryId).toBe(receiver.requests[1]!.deliveryId);
    expect(receiver.logical().size).toBe(1);
  });
});
