/**
 * The private HTTPS listener's own client-certificate check, exercised directly (validator-6 W-L1).
 *
 * Bun 1.4 refuses an unverified client certificate in the handshake itself, so the integration suite never reaches
 * the listener's handshake callback with a failed verification, and removing that check failed no test. These cases
 * capture the callbacks the listener hands to Bun.listen and drive them with a stand-in socket: a certificate that
 * failed verification (or a failed handshake) yields no peer identity, and a request on such a connection is refused
 * 401 before the handler runs; a verified one yields its subject.
 */
import { expect, test } from "bun:test";
import { startFactoryPrivateHttps } from "./private-https";

type Handlers = {
  open(socket: unknown): void;
  handshake(socket: unknown, success: boolean, authorizationError: Error | null): void;
  data(socket: unknown, chunk: Uint8Array): Promise<void> | void;
  close(socket: unknown): void;
};

/** The listener's socket callbacks, captured from Bun.listen without opening a port. */
function listenerHandlers(handle: () => Promise<{ status: number; body: Buffer }>): Handlers {
  const original = Bun.listen;
  let captured: { socket: Handlers } | undefined;
  (Bun as unknown as { listen: unknown }).listen = (options: { socket: Handlers }) => {
    captured = options;
    return { port: 1, stop() {} };
  };
  try {
    startFactoryPrivateHttps({ tls: { key: "key", cert: "cert", ca: "ca" }, handle });
  } finally {
    (Bun as unknown as { listen: unknown }).listen = original;
  }
  return captured!.socket;
}

/** A stand-in for a Bun TLS socket: a peer certificate subject, and every byte the listener writes. */
function standIn(commonName: string) {
  const socket = {
    data: undefined as unknown as { peerIdentity?: string },
    written: "",
    ended: false,
    getPeerCertificate: () => ({ subject: { CN: commonName } }),
    write(bytes: Uint8Array) { socket.written += Buffer.from(bytes).toString("latin1"); return bytes.byteLength; },
    end() { socket.ended = true; },
    terminate() { socket.ended = true; },
  };
  return socket;
}

test("a certificate that failed verification gives no peer identity, and its request is refused 401 before the handler", async () => {
  let handled = 0;
  const handlers = listenerHandlers(async () => { handled += 1; return { status: 200, body: Buffer.from("{}") }; });
  for (const [label, success, authorizationError] of [
    ["verification failed", true, new Error("unable to verify the first certificate")],
    ["handshake failed", false, null],
  ] as const) {
    const socket = standIn("tenant-a");
    handlers.open(socket);
    handlers.handshake(socket, success, authorizationError);
    expect(socket.data.peerIdentity, label).toBeUndefined();
    await handlers.data(socket, Buffer.from("GET /identity HTTP/1.1\r\n\r\n"));
    expect(socket.written.split("\r\n")[0], label).toBe("HTTP/1.1 401 Unauthorized");
    expect(socket.written.endsWith('{"error":"unauthorized"}'), label).toBe(true);
    handlers.close(socket);
  }
  expect(handled).toBe(0);
});

test("a verified certificate gives its subject as the peer identity", () => {
  const handlers = listenerHandlers(async () => ({ status: 200, body: Buffer.from("{}") }));
  const socket = standIn("tenant-a");
  handlers.open(socket);
  handlers.handshake(socket, true, null);
  expect(socket.data.peerIdentity).toBe("tenant-a");
  handlers.close(socket);
});
