import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { incusSupervisorPublicKeyPem } from "./incus-supervisor-public-key";

test("the sealed single-line supervisor key is the same Ed25519 key as PEM", () => {
  const pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  expect(incusSupervisorPublicKeyPem({ EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64:
    Buffer.from(pem).toString("base64") })).toBe(pem);
  expect(incusSupervisorPublicKeyPem({ EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY: pem })).toBe(pem);
});

test("ambiguous, invalid, or wrong-type supervisor keys fail closed", () => {
  const pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  const privatePem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  expect(() => incusSupervisorPublicKeyPem({ EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY: pem,
    EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64: Buffer.from(pem).toString("base64") })).toThrow();
  expect(() => incusSupervisorPublicKeyPem({ EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64: "AA=" })).toThrow();
  expect(() => incusSupervisorPublicKeyPem({ EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64:
    Buffer.from(rsa).toString("base64") })).toThrow();
  expect(() => incusSupervisorPublicKeyPem({ EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64:
    Buffer.from(privatePem).toString("base64") })).toThrow();
});
