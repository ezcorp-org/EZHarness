import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { startTestWebhookReceiver } from "./helpers/factory-webhook-receiver";

test("reset isolates a late delivery from the next fixture's logical notifications", async () => {
 const secret = new TextEncoder().encode("receiver-reset-public-test-secret");
 const now = Date.UTC(2026, 9, 15, 12);
 const receiver = await startTestWebhookReceiver({ secret, now: () => now });
 const entered = Promise.withResolvers<void>();
 const release = Promise.withResolvers<void>();
 let oldRequest: Promise<Response> | undefined;
 const send = (key: string) => {
  const body = JSON.stringify({ notification: key });
  const timestamp = String(now / 1000);
  return fetch(receiver.url, { method: "POST", headers: { "idempotency-key": key, "x-ezcorp-timestamp": timestamp, "x-ezcorp-signature": `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}` }, body, tls: { ca: receiver.ca } });
 };
 try {
  receiver.onRequest(async () => { entered.resolve(); await release.promise; });
  oldRequest = send("previous-notification");
  await entered.promise;
  receiver.reset();
  expect((await send("current-notification")).status).toBe(200);
  expect((await send("current-notification")).status).toBe(200);
  release.resolve();
  expect((await oldRequest).status).toBe(200);
  expect(receiver.requests.map((request) => request.idempotencyKey)).toEqual(["current-notification", "current-notification"]);
  expect(receiver.logical().size).toBe(1);
  expect([...receiver.logical()]).toEqual(["current-notification"]);
 } finally {
  release.resolve();
  if (oldRequest) await oldRequest;
  await receiver.stop();
 }
}, 10000);
