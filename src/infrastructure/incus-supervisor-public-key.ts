import { createPublicKey } from "node:crypto";

/** Accept a sealed single-line environment value while retaining existing PEM settings. */
export function incusSupervisorPublicKeyPem(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pem = env.EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY;
  const encoded = env.EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64;
  if (pem && encoded) throw new Error("Incus supervisor public key has two sources");
  if (!pem && !encoded) return undefined;
  let value = pem;
  if (encoded) {
    if (encoded.length > 8192 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error("Incus supervisor public key encoding is invalid");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length === 0 || bytes.length > 4096 || bytes.toString("base64") !== encoded) {
      throw new Error("Incus supervisor public key encoding is invalid");
    }
    value = bytes.toString("utf8");
  }
  if (!value) throw new Error("Incus supervisor public key is missing");
  if (!value.startsWith("-----BEGIN PUBLIC KEY-----\n") || !value.trimEnd().endsWith("-----END PUBLIC KEY-----")) {
    throw new Error("Incus supervisor key must be a public SPKI PEM");
  }
  const key = createPublicKey(value);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Incus supervisor public key must be Ed25519");
  return value;
}
