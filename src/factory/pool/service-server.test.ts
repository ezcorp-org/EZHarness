import { expect, test } from "bun:test";
import { poolPeerIdentity } from "./service-server";

const certificate = (cn: unknown) => () => ({ subject: { CN: cn } }) as never;

test("the Node pool server names a peer only from a certificate the handshake verified", () => {
  expect(poolPeerIdentity({ authorized: true, getPeerCertificate: certificate("harness.tenant-01") })).toBe("harness.tenant-01");
  // Not verified, verification unknown, or no certificate API (Bun's node:https): no identity.
  expect(poolPeerIdentity({ authorized: false, getPeerCertificate: certificate("harness.tenant-01") })).toBe("");
  expect(poolPeerIdentity({ getPeerCertificate: certificate("harness.tenant-01") })).toBe("");
  expect(poolPeerIdentity({ authorized: true })).toBe("");
  // A verified certificate without a string CN names nobody.
  expect(poolPeerIdentity({ authorized: true, getPeerCertificate: certificate(undefined) })).toBe("");
  expect(poolPeerIdentity({ authorized: true, getPeerCertificate: () => undefined as never })).toBe("");
});
