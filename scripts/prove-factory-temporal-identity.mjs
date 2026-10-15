import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const authDir = process.env.EZCORP_FACTORY_TEMPORAL_AUTH_DIR;
if (!authDir) throw new Error("EZCORP_FACTORY_TEMPORAL_AUTH_DIR is required.");
const clientModule = await import("../packages/@ezcorp/factory-orchestrator/node_modules/@temporalio/client/lib/index.js");
const bytes = async name => new Uint8Array(await readFile(join(authDir, name)));
const token = async (subject, permissions, overrides = {}) => {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = { sub: subject, iss: "ezcorp-factory-local", aud: "ezcorp-temporal", permissions, exp: Math.floor(Date.now() / 1000) + 120, ...overrides };
  const input = `${encode({ alg: "RS256", kid: "factory-local", typ: "JWT" })}.${encode(claims)}`;
  const signer = createSign("RSA-SHA256"); signer.update(input); signer.end();
  return `${input}.${signer.sign(await readFile(join(authDir, "jwt.key"))).toString("base64url")}`;
};
const connect = async (certificate, subject, permissions, overrides, metadata = {}) => clientModule.Connection.connect({
  address: "127.0.0.1:17233",
  tls: { serverNameOverride: "temporal.local", serverRootCACertificate: await bytes("ca.crt"), clientCertPair: { crt: await bytes(`${certificate}.crt`), key: await bytes(`${certificate}.key`) } },
  metadata: { authorization: `Bearer ${await token(subject, permissions, overrides)}`, ...metadata },
});
const denied = async (work, label) => {
  try { const value = await work(); await value?.close?.(); throw new Error(`${label} was accepted`); }
  catch (error) { if (error.message === `${label} was accepted`) throw error; const code = error.code ?? error.cause?.code; if (code !== 7 && code !== 16) throw error; }
};
const own = await connect("tenant-01", "tenant-01", ["admin:tenant-01"]);
await own.workflowService.describeNamespace({ namespace: "tenant-01" });
await denied(() => own.workflowService.describeNamespace({ namespace: "tenant-02" }), "foreign namespace");
await own.close();
await denied(() => connect("tenant-02", "tenant-01", ["admin:tenant-01"]), "certificate/token mismatch");
await denied(() => connect("tenant-01", "tenant-01", ["admin:tenant-01"], { iss: "wrong-issuer" }), "wrong issuer");
await denied(() => connect("tenant-01", "tenant-01", ["admin:tenant-01"], { aud: "wrong-audience" }), "wrong audience");
await denied(() => connect("tenant-01", "tenant-01", ["admin:tenant-01"], { exp: 0 }), "expired token");
await denied(() => connect("tenant-02", "tenant-01", ["admin:tenant-01"], {}, { "x-forwarded-client-cert": "Subject=\"CN=tenant-01\"" }), "forged XFCC");
await denied(() => connect("tenant-01", "tenant-01", ["admin:tenant-02"]), "foreign namespace claim");
console.log("mTLS/JWT identity proof passed: own allowed; foreign, mismatch, issuer, audience, expiry, XFCC, and foreign claim denied");
