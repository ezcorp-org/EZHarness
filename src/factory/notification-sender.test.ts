import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { FactoryNotification } from "./releases";
import {
  FACTORY_NOTIFICATION_HEADERS, FACTORY_NOTIFICATION_SCHEMA, FACTORY_NOTIFICATION_SIGNATURE_TOLERANCE_S, FACTORY_NOTIFICATION_SEND_BOUNDS, FACTORY_NOTIFICATION_SEND_CODES,
  FactoryNotificationSendError, FactoryNotificationSender, classifyFactoryWebhookStatus, factoryNotificationIdempotencyKey,
  composeFactoryNotificationSender, factoryNotificationPayload, fetchFactoryWebhook, loadFactoryNotificationDestinations, signFactoryNotification,
} from "./notification-sender";
import { makeFactoryTempPrivateRoot } from "../__tests__/helpers/factory-private-root";
import { startTestWebhookReceiver, type TestWebhookReceiver } from "../__tests__/helpers/factory-webhook-receiver";

const SECRET_MARKER = "sk-live-MARKER-0123456789abcdef";
const RUN_ID = "run-7d3f1c2a-0000-4000-8000-000000000001";
const CREATED = Date.UTC(2026, 9, 15, 12, 0, 0);

function notification(overrides: Partial<FactoryNotification> & { kind: FactoryNotification["kind"] }): FactoryNotification {
  return {
    id: "notification-1", tenantId: "tenant-1", projectId: "project-1", deduplicationId: "d", inputHash: "sha256:0",
    state: "delivered", attempts: 1, maxAttempts: 5, availableAt: 0, leaseUntil: 0, createdAt: CREATED,
    operationId: "operation-1",
    ...overrides,
  } as FactoryNotification;
}

describe("the notification payload (C11 N4, N9)", () => {
  test("an approval request carries only the allowlisted fields, with the approval's own expiry", () => {
    const built = factoryNotificationPayload(notification({
      kind: "approval_requested",
      payload: { approvalId: "approval-1", expiresAtMs: CREATED + 3_600_000, secret: SECRET_MARKER, runId: RUN_ID, contextDigest: "a".repeat(64) },
    }), "operators");
    expect(built).toEqual({
      expiresAt: CREATED + 3_600_000,
      payload: {
        schema: FACTORY_NOTIFICATION_SCHEMA,
        idempotencyKey: factoryNotificationIdempotencyKey("tenant-1", "project-1", "notification-1", "operators"),
        kind: "approval_requested",
        projectId: "project-1",
        notificationId: "notification-1",
        operationId: "operation-1",
        approvalId: "approval-1",
        createdAt: "2026-10-15T12:00:00.000Z",
        expiresAt: "2026-10-15T13:00:00.000Z",
        inboxPath: "/api/factories/projects/project-1/release/notifications",
      },
    });
    const body = canonicalJson(built!.payload);
    for (const forbidden of [SECRET_MARKER, RUN_ID, "a".repeat(64), "tenant-1"]) expect(body).not.toContain(forbidden);
  });

  test("an uncertain release carries its outcome code and expires 24 hours after creation", () => {
    const built = factoryNotificationPayload(notification({ kind: "release_uncertain", payload: { dispatchGeneration: 2, code: "provider_response_unknown" } }), "operators");
    expect(built?.expiresAt).toBe(CREATED + FACTORY_NOTIFICATION_SEND_BOUNDS.expiryMs);
    expect(built?.payload).toMatchObject({ kind: "release_uncertain", operationId: "operation-1", outcomeCode: "provider_response_unknown" });
    expect(built?.payload).not.toHaveProperty("expiresAt");
    expect(built?.payload).not.toHaveProperty("approvalId");
  });

  test("an outcome code that is not a plain code is left out rather than sent", () => {
    const built = factoryNotificationPayload(notification({ kind: "release_uncertain", payload: { code: `Bearer ${SECRET_MARKER}` } }), "operators");
    expect(built?.payload).not.toHaveProperty("outcomeCode");
    expect(canonicalJson(built!.payload)).not.toContain(SECRET_MARKER);
  });

  test("a command approval uses its deadline when known and 24 hours otherwise, and never its run", () => {
    const command = notification({ kind: "command_approval_requested", approvalId: "approval-9", operationId: undefined, payload: { approvalId: "approval-9", runId: RUN_ID } } as never);
    expect(factoryNotificationPayload(command, "operators", CREATED + 60_000)?.expiresAt).toBe(CREATED + 60_000);
    const fallback = factoryNotificationPayload(command, "operators");
    expect(fallback?.expiresAt).toBe(CREATED + FACTORY_NOTIFICATION_SEND_BOUNDS.expiryMs);
    expect(fallback?.payload).toMatchObject({ kind: "command_approval_requested", approvalId: "approval-9" });
    expect(fallback?.payload).not.toHaveProperty("operationId");
    expect(canonicalJson(fallback!.payload)).not.toContain(RUN_ID);
  });

  test("a settled release does not leave this host", () => {
    expect(factoryNotificationPayload(notification({ kind: "release_settled", payload: {} }), "operators")).toBeNull();
  });

  test("accepts every identifier the release store accepts, refuses a missing one, and refuses a payload over 4 KiB", () => {
    // The release store's own identity rule: non-empty, at most 512 characters, no NUL.
    const unusual = notification({ kind: "approval_requested", projectId: "project with spaces/and-slash", payload: { approvalId: "approval:ü 1" } });
    expect(factoryNotificationPayload(unusual, "operators")?.payload).toMatchObject({ projectId: "project with spaces/and-slash", approvalId: "approval:ü 1", inboxPath: "/api/factories/projects/project%20with%20spaces%2Fand-slash/release/notifications" });
    for (const broken of [
      notification({ kind: "approval_requested", payload: {} }),
      notification({ kind: "approval_requested", payload: { approvalId: "" } }),
      notification({ kind: "approval_requested", payload: { approvalId: "a\0b" } }),
      notification({ kind: "approval_requested", payload: { approvalId: "a".repeat(513) } }),
      notification({ kind: "release_uncertain", operationId: "", payload: {} }),
    ]) {
      expect(() => factoryNotificationPayload(broken, "operators")).toThrow(expect.objectContaining({ code: "notification_payload_invalid", deadLetter: true }));
    }
    const quotes = '"'.repeat(512);
    const huge = notification({ kind: "approval_requested", projectId: quotes, operationId: quotes, payload: { approvalId: quotes } });
    expect(() => factoryNotificationPayload(huge, "operators")).toThrow(expect.objectContaining({ code: "notification_payload_invalid", deadLetter: true }));
  });

  test("the idempotency key is stable per notification and destination, and differs across them", () => {
    const key = factoryNotificationIdempotencyKey("t", "p", "n", "a");
    expect(key).toBe(factoryNotificationIdempotencyKey("t", "p", "n", "a"));
    expect(key).toMatch(/^fn1-[a-f0-9]{64}$/);
    expect(new Set([key, factoryNotificationIdempotencyKey("t", "p", "n", "b"), factoryNotificationIdempotencyKey("t", "p", "m", "a"), factoryNotificationIdempotencyKey("u", "p", "n", "a")]).size).toBe(4);
  });
});

describe("the request signature (C11 N3)", () => {
  test("is HMAC-SHA256 over the timestamp and the body", () => {
    const secret = new TextEncoder().encode("s".repeat(32));
    const expected = createHmac("sha256", secret).update("1700000000.{\"a\":1}").digest("hex");
    expect(signFactoryNotification(secret, 1_700_000_000, "{\"a\":1}")).toBe(`v1=${expected}`);
    expect(signFactoryNotification(secret, 1_700_000_001, "{\"a\":1}")).not.toBe(`v1=${expected}`);
  });
});

describe("the settlement of a webhook answer (C11 N6)", () => {
  test("maps every status class to its code", () => {
    expect(classifyFactoryWebhookStatus(200)).toBeNull();
    expect(classifyFactoryWebhookStatus(204)).toBeNull();
    const code = (status: number) => { const error = classifyFactoryWebhookStatus(status)!; return [error.code, error.deadLetter]; };
    expect(code(408)).toEqual(["webhook_timeout", false]);
    expect(code(429)).toEqual(["webhook_status_429", false]);
    expect(code(500)).toEqual(["webhook_status_5xx", false]);
    expect(code(503)).toEqual(["webhook_status_5xx", false]);
    expect(code(400)).toEqual(["webhook_rejected_4xx", true]);
    expect(code(404)).toEqual(["webhook_rejected_4xx", true]);
    expect(code(302)).toEqual(["webhook_rejected_4xx", true]);
    expect(code(101)).toEqual(["webhook_rejected_4xx", true]);
    expect(code(600)).toEqual(["webhook_rejected_4xx", true]);
  });

  test("every code the sender can settle with is a declared one", () => {
    const declared = new Set<string>([...FACTORY_NOTIFICATION_SEND_CODES.retry, ...FACTORY_NOTIFICATION_SEND_CODES.deadLetter, ...FACTORY_NOTIFICATION_SEND_CODES.cancelled]);
    for (const status of [101, 204, 302, 400, 408, 429, 500]) {
      const error = classifyFactoryWebhookStatus(status);
      if (error) expect(declared.has(error.code)).toBe(true);
    }
    for (const code of ["attempts_exhausted", "notification_payload_invalid", "notification_send_corrupt"]) expect(declared.has(code)).toBe(true);
    expect(new FactoryNotificationSendError("webhook_unreachable").message).not.toContain("https://");
  });
});

describe("the HTTPS transport", () => {
  let receiver: TestWebhookReceiver;
  beforeAll(async () => { receiver = await startTestWebhookReceiver(); });
  afterAll(async () => { await receiver.stop(); });

  test("posts the body and headers over TLS with the declared CA, and answers the status", async () => {
    receiver.answer(202);
    const answer = await fetchFactoryWebhook({ url: receiver.url, ca: receiver.ca, headers: { "content-type": "application/json", [FACTORY_NOTIFICATION_HEADERS.idempotency]: "fn1-x", [FACTORY_NOTIFICATION_HEADERS.timestamp]: String(Math.floor(Date.now() / 1000)) }, body: "{\"a\":1}", signal: AbortSignal.timeout(5_000) });
    expect(answer).toEqual({ status: 202 });
    expect(receiver.requests.at(-1)).toMatchObject({ body: "{\"a\":1}", idempotencyKey: "fn1-x" });
  });

  test("refuses a receiver whose certificate the declared CA did not sign", async () => {
    await expect(fetchFactoryWebhook({ url: receiver.url, headers: {}, body: "{}", signal: AbortSignal.timeout(5_000) })).rejects.toThrow();
  });

  test("does not follow a redirect", async () => {
    receiver.answer(302);
    const before = receiver.requests.length;
    expect(await fetchFactoryWebhook({ url: receiver.url, ca: receiver.ca, headers: { [FACTORY_NOTIFICATION_HEADERS.timestamp]: String(Math.floor(Date.now() / 1000)) }, body: "{}", signal: AbortSignal.timeout(5_000) })).toEqual({ status: 302 });
    expect(receiver.requests.length).toBe(before + 1);
  });
});

describe("the sender's construction", () => {
  test("refuses an empty destination list", () => {
    expect(() => new FactoryNotificationSender({ database: {} as never, tenantId: "t", destinations: [] })).toThrow(expect.objectContaining({ code: "notification_destination_missing" }));
  });
});

describe("loading the declared destinations (C11 N8, N9)", () => {
  let root: string;
  beforeAll(async () => {
    root = await makeFactoryTempPrivateRoot("w4h-34-notify-");
    await chmod(root, 0o700);
    await writeFile(join(root, "secret"), "k".repeat(32), { mode: 0o600 });
    await writeFile(join(root, "short"), "k".repeat(31), { mode: 0o600 });
    await writeFile(join(root, "ca.pem"), "-----BEGIN CERTIFICATE-----\n", { mode: 0o600 });
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  const declared = (overrides: Record<string, unknown> = {}) => ({ name: "operators", kind: "webhook" as const, url: "https://receiver.test/hook", secretPath: join(root, "secret"), ...overrides });

  test("reads each secret and CA through the private reader", async () => {
    const [loaded] = await loadFactoryNotificationDestinations([declared({ caPath: join(root, "ca.pem") })]);
    expect(loaded).toEqual({ name: "operators", url: "https://receiver.test/hook", secret: new TextEncoder().encode("k".repeat(32)), ca: "-----BEGIN CERTIFICATE-----\n" });
    const [withoutCa] = await loadFactoryNotificationDestinations([declared()]);
    expect(withoutCa).not.toHaveProperty("ca");
  });

  test("refuses by name a secret it cannot read, a short secret, and a CA it cannot read, never quoting them", async () => {
    for (const [overrides, code] of [
      [{ secretPath: join(root, "missing") }, "factory_notification_secret_unreadable"],
      [{ secretPath: join(root, "short") }, "factory_notification_secret_invalid"],
      [{ caPath: join(root, "missing.pem") }, "factory_notification_ca_unreadable"],
    ] as const) {
      const error = await loadFactoryNotificationDestinations([declared(overrides)]).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code, destination: "operators" });
      expect(String((error as Error).message)).not.toContain(root);
    }
  });

  test("composes nothing when none is declared, holds on the cause when one fails, and runs when all load", async () => {
    const reports: Array<[string, unknown]> = [];
    const report = (role: string, error: unknown) => { reports.push([role, error]); };
    expect(await composeFactoryNotificationSender(undefined, {} as never, "tenant-1", report)).toEqual({});
    const failed = await composeFactoryNotificationSender([declared({ secretPath: join(root, "missing") })], {} as never, "tenant-1", report);
    expect(failed.sender).toBeUndefined();
    expect(failed.held).toContain("'operators'");
    expect(failed.held).toContain("factory_notification_secret_unreadable");
    expect(reports.map(([role]) => role)).toEqual(["notification-sender"]);
    const composed = await composeFactoryNotificationSender([declared()], {} as never, "tenant-1", report);
    expect(composed.held).toBeUndefined();
    expect(composed.sender?.confirmation.confirmed()).toBe(false);
    expect(composed.sender?.confirmation.pendingReason).toContain("no receiver has confirmed");
  });
});

describe("the receiver's replay bound (C11 N3)", () => {
  const secret = new TextEncoder().encode("r".repeat(32));
  let clockS = 1_700_000_000;
  let receiver: TestWebhookReceiver;
  beforeAll(async () => { receiver = await startTestWebhookReceiver({ secret, now: () => clockS * 1000 }); });
  afterAll(async () => { await receiver.stop(); });

  const post = (timestamp: number, key: string) => {
    const body = JSON.stringify({ key });
    return fetchFactoryWebhook({ url: receiver.url, ca: receiver.ca, body, signal: AbortSignal.timeout(5_000), headers: {
      [FACTORY_NOTIFICATION_HEADERS.signature]: signFactoryNotification(secret, timestamp, body),
      [FACTORY_NOTIFICATION_HEADERS.timestamp]: String(timestamp),
      [FACTORY_NOTIFICATION_HEADERS.idempotency]: key,
    } });
  };

  test("accepts a fresh signed request once, deduplicates its replay, and rejects one older than the tolerance", async () => {
    expect(FACTORY_NOTIFICATION_SIGNATURE_TOLERANCE_S).toBe(300);
    expect(await post(clockS, "fn1-a")).toEqual({ status: 200 });
    expect(await post(clockS, "fn1-a")).toEqual({ status: 200 });
    expect([...receiver.logical()]).toEqual(["fn1-a"]);
    // The same signed message replayed past the tolerance, or one dated in the future past it, is refused.
    expect(await post(clockS - 301, "fn1-b")).toEqual({ status: 401 });
    expect(await post(clockS + 301, "fn1-c")).toEqual({ status: 401 });
    expect(await post(clockS - 300, "fn1-d")).toEqual({ status: 200 });
    expect([...receiver.logical()].sort()).toEqual(["fn1-a", "fn1-d"]);
    expect(receiver.requests.map((request) => request.timestampValid)).toEqual([true, true, false, false, true]);
  });
});
