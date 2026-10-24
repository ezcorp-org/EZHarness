/**
 * A local HTTPS receiver for outbound factory notifications (C11 N3, N7).
 *
 * It does what the contract asks of a destination and nothing more: it checks
 * the signature when it knows the secret, and it deduplicates on the
 * `Idempotency-Key`, so `requests` counts physical deliveries and `logical()`
 * counts notifications. The unit tests run it in process; the delivery proof
 * runs this same module inside a Podman container, so the
 * receiver the proof trusts is the one the tests exercise.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTORY_NOTIFICATION_SIGNATURE_TOLERANCE_S } from "../../factory/notification-sender";
import { createFactoryCertificateAuthority, issueFactoryCertificate } from "../../factory/provisioning/certificates";

export interface ReceivedNotification {
  readonly body: string;
  readonly idempotencyKey: string | null;
  readonly deliveryId: string | null;
  readonly timestamp: string | null;
  readonly signature: string | null;
  /** True when the receiver knows the secret and the signature matched; null when it has no secret. */
  readonly signatureValid: boolean | null;
  /** True when the timestamp is within the tolerance of the receiver's clock (N3). */
  readonly timestampValid: boolean;
}

export interface TestWebhookReceiver {
  readonly url: string;
  /** The CA certificate that signed the receiver's certificate, in PEM. */
  readonly ca: string;
  readonly requests: ReceivedNotification[];
  /** Logical deliveries answered 2xx: one per distinct idempotency key, and one per request that carries none. */
  logical(): ReadonlySet<string>;
  /** The status every later request is answered with. */
  answer(status: number): void;
  /** Called with each request before it is answered; the answer waits for it. */
  onRequest(hook: ((request: ReceivedNotification) => Promise<void>) | null): void;
  /** Forget every request and answer 200 again, between tests. */
  reset(): void;
  stop(): Promise<void>;
}

export interface TestWebhookReceiverOptions {
  readonly secret?: Uint8Array;
  readonly hostname?: string;
  readonly port?: number;
  /** Extra certificate names, for a receiver reached by a container name. */
  readonly dnsNames?: readonly string[];
  /** Seconds a timestamp may differ from `now`; the contract's 300 by default (N3). A proof may shorten it. */
  readonly toleranceS?: number;
  /** The receiver's clock, in milliseconds. */
  readonly now?: () => number;
  /** Serve this certificate instead of issuing one: a container without the openssl tool is given its pair. */
  readonly tls?: { readonly cert: string; readonly key: string; readonly ca: string };
}

function verify(secret: Uint8Array | undefined, timestamp: string | null, body: string, signature: string | null): boolean | null {
  if (secret === undefined) return null;
  if (timestamp === null || signature === null) return false;
  const expected = Buffer.from(`v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`);
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** A test CA and a server certificate for 127.0.0.1 and localhost, from the provisioner's own issuer. */
export async function issueTestWebhookReceiverTls(dnsNames: readonly string[] = []): Promise<{ readonly cert: string; readonly key: string; readonly ca: string }> {
  const directory = await mkdtemp(join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "factory-webhook-receiver-"));
  try {
    const authority = await createFactoryCertificateAuthority("factory-webhook-test-ca");
    const caPath = join(directory, "ca.crt"), caKeyPath = join(directory, "ca.key");
    await writeFile(caPath, authority.certificatePem, { mode: 0o600 });
    await writeFile(caKeyPath, authority.privateKeyPem, { mode: 0o600 });
    const leaf = await issueFactoryCertificate({ certificatePath: caPath, keyPath: caKeyPath }, {
      subject: "factory-webhook-receiver", usage: "server", dnsNames: ["localhost", ...dnsNames], ipAddresses: ["127.0.0.1"],
    });
    return { cert: leaf.certificatePem, key: leaf.privateKeyPem, ca: authority.certificatePem };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function startTestWebhookReceiver(options: TestWebhookReceiverOptions = {}): Promise<TestWebhookReceiver> {
  const tls = options.tls ?? await issueTestWebhookReceiverTls(options.dnsNames);
  const requests: ReceivedNotification[] = [];
  const delivered = new Set<string>();
  let status = 200;
  let hook: ((request: ReceivedNotification) => Promise<void>) | null = null;
  // A request counts only in the reset generation it arrived in: a hook that outlives its test must not add
  // to the next test's counts (W4H-35, ci 39956956620 root 2: a late key made N7 see two logical deliveries).
  let generation = 0;
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    tls: { cert: tls.cert, key: tls.key },
    async fetch(request) {
      const arrivedIn = generation;
      const body = await request.text();
      const header = (name: string) => request.headers.get(name);
      const received: ReceivedNotification = {
        body,
        idempotencyKey: header("idempotency-key"),
        deliveryId: header("x-ezcorp-delivery-id"),
        timestamp: header("x-ezcorp-timestamp"),
        signature: header("x-ezcorp-signature"),
        signatureValid: verify(options.secret, header("x-ezcorp-timestamp"), body, header("x-ezcorp-signature")),
        timestampValid: Math.abs((options.now ?? Date.now)() / 1000 - Number(header("x-ezcorp-timestamp"))) <= (options.toleranceS ?? FACTORY_NOTIFICATION_SIGNATURE_TOLERANCE_S),
      };
      if (arrivedIn === generation) requests.push(received);
      if (hook) await hook(received);
      // A bad signature or a stale timestamp is refused before deduplication: a replay never counts.
      if (received.signatureValid === false || !received.timestampValid) return new Response(null, { status: 401 });
      // Without a key a receiver cannot deduplicate, so every such request is its own logical delivery.
      if (status >= 200 && status < 300 && arrivedIn === generation) delivered.add(received.idempotencyKey ?? `no-key-${requests.length}`);
      return new Response(null, { status, ...(status >= 300 && status < 400 ? { headers: { location: "https://127.0.0.1:1/" } } : {}) });
    },
  });
  return {
    url: `https://${options.hostname === "0.0.0.0" ? "127.0.0.1" : options.hostname ?? "127.0.0.1"}:${server.port}/factory/notifications`,
    ca: tls.ca,
    requests,
    logical: () => delivered,
    answer(next) { status = next; },
    onRequest(next) { hook = next; },
    reset() { generation += 1; requests.length = 0; delivered.clear(); status = 200; hook = null; },
    async stop() { server.stop(true); },
  };
}
