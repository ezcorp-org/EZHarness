/**
 * The receiver the delivery proof runs inside a Podman container (C11 N3, W4H-34).
 *
 * It serves the same `startTestWebhookReceiver` the unit tests exercise, on the
 * HTTPS port and certificate it is given, and answers an inspection port on
 * loopback with every request it received, so the proof reads what crossed the
 * container boundary rather than what the sender believes it sent.
 * Environment: RECEIVER_PORT, RECEIVER_INSPECT_PORT, RECEIVER_SECRET (hex),
 * RECEIVER_TLS_DIR (holding cert.pem, key.pem, ca.pem).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestWebhookReceiver } from "./factory-webhook-receiver";

const tlsDirectory = process.env.RECEIVER_TLS_DIR ?? "/tls";
const receiver = await startTestWebhookReceiver({
  hostname: "127.0.0.1",
  port: Number(process.env.RECEIVER_PORT),
  secret: Buffer.from(process.env.RECEIVER_SECRET ?? "", "hex"),
  tls: { cert: readFileSync(join(tlsDirectory, "cert.pem"), "utf8"), key: readFileSync(join(tlsDirectory, "key.pem"), "utf8"), ca: readFileSync(join(tlsDirectory, "ca.pem"), "utf8") },
});
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.RECEIVER_INSPECT_PORT),
  fetch: () => Response.json({ requests: receiver.requests, logical: [...receiver.logical()] }),
});
console.log(`receiver listening ${receiver.url}`);
