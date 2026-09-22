import { readFileSync } from "node:fs";

const expectedIssuer = "ezcorp-factory-local";
const expectedAudience = "ezcorp-temporal";

function payload(token) {
  const encoded = token.split(".")[1];
  if (!encoded) return undefined;
  try { return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { return undefined; }
}

function certificateSubject(xfcc) { return /Subject="CN=([^,"]+)"/.exec(xfcc)?.[1]; }
function certificateHash(xfcc) { return /(?:^|;)Hash=([a-f0-9]{64})(?:;|$)/.exec(xfcc)?.[1]; }

/**
 * The fleet's revocation list, read on EVERY request so a revocation is
 * immediate. A list that exists but cannot be read or parsed denies
 * everything: a revocation that silently stopped applying is worse than an
 * outage. An absent path means no list was configured.
 */
export function readRevocations(path) {
  if (!path) return { subjects: [], certificateHashes: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.schemaVersion !== "factory.temporal-revocations.v1" || !Array.isArray(parsed.subjects) || !Array.isArray(parsed.certificateHashes)) return null;
    return parsed;
  } catch { return null; }
}

export function authorize(headers, revocations = { subjects: [], certificateHashes: [] }) {
  if (revocations === null) return false;
  const token = headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const claims = token && payload(token);
  const xfcc = headers.get("x-forwarded-client-cert") ?? "";
  const certificate = certificateSubject(xfcc);
  const hash = certificateHash(xfcc);
  if (!certificate || revocations.subjects.includes(certificate) || (hash && revocations.certificateHashes.includes(hash))) return false;
  const permissions = Array.isArray(claims?.permissions) ? claims.permissions : [];
  const identityPermission = certificate === "factory-control" ? "admin:temporal-system" : `admin:${certificate}`;
  return Boolean(claims?.sub === certificate && claims.iss === expectedIssuer && (claims.aud === expectedAudience || claims.aud?.includes(expectedAudience)) && Number.isInteger(claims.exp) && claims.exp > Math.floor(Date.now() / 1000) && permissions.includes(identityPermission));
}

if (import.meta.main) Bun.serve({
  port: 17445,
  fetch(request) {
    const allowed = authorize(request.headers, readRevocations(process.env.FACTORY_TEMPORAL_REVOCATIONS));
    console.log(`temporal identity binding ${allowed ? "allowed" : "denied"}`);
    return allowed ? new Response(null, { status: 200 }) : new Response("certificate and JWT claims must match", { status: 403 });
  },
});
