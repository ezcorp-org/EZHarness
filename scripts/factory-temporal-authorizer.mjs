import { readFileSync } from "node:fs";
import { join } from "node:path";

const expectedIssuer = "ezcorp-factory-local";
const expectedAudience = "ezcorp-temporal";

/** The Envoy HTTP listener prefixes every check it sends for the read-only Temporal HTTP route with this. */
export const HTTP_READ_PREFIX = "/http-read";

/**
 * The only requests the Temporal HTTP route allows: the two reads W15's
 * checkpoint barrier makes (`temporal-retention.ts`). Describe the namespace;
 * list its workflows (a `query` string only). Anything else is refused at the
 * gateway, whatever certificate presents it.
 */
const READS = [/^\/api\/v1\/namespaces\/([^/?#]+)$/, /^\/api\/v1\/namespaces\/([^/?#]+)\/workflows$/];

function payload(token) {
  const encoded = token.split(".")[1];
  if (!encoded) return undefined;
  try { return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { return undefined; }
}

function certificateSubject(xfcc) { return /Subject="CN=([^,"]+)"/.exec(xfcc)?.[1]; }
function certificateHash(xfcc) { return /(?:^|;)Hash=([a-f0-9]{64})(?:;|$)/.exec(xfcc)?.[1]; }

/**
 * @typedef {{ readonly schemaVersion?: "factory.temporal-revocations.v1", readonly subjects: readonly string[], readonly certificateHashes: readonly string[], readonly tokenIds: readonly string[] }} Revocations
 * A list read from a file carries its schemaVersion; the empty list for "no path configured" does not.
 */

/**
 * The fleet's revocation list, read on EVERY request so a revocation is
 * immediate. A list that exists but cannot be read or parsed denies
 * everything: a revocation that silently stopped applying is worse than an
 * outage. An absent path means no list was configured.
 * @param {string | undefined} path
 * @returns {Revocations | null}
 */
export function readRevocations(path) {
  if (!path) return { subjects: [], certificateHashes: [], tokenIds: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.schemaVersion !== "factory.temporal-revocations.v1" || !Array.isArray(parsed.subjects) || !Array.isArray(parsed.certificateHashes) || (parsed.tokenIds !== undefined && !Array.isArray(parsed.tokenIds))) return null;
    return { ...parsed, tokenIds: parsed.tokenIds ?? [] };
  } catch { return null; }
}

function revokedCertificate(revocations, certificate, hash) {
  return revocations.subjects.includes(certificate) || Boolean(hash && revocations.certificateHashes.includes(hash));
}

/**
 * The gRPC route: the certificate and the presented token must name the same subject, with its namespace's admin permission.
 * A `null` list is one that exists but cannot be read, and denies everything.
 * @param {Headers} headers
 * @param {Revocations | null} [revocations]
 * @returns {boolean}
 */
export function authorize(headers, revocations = { subjects: [], certificateHashes: [], tokenIds: [] }) {
  if (revocations === null) return false;
  const token = headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const claims = token && payload(token);
  const xfcc = headers.get("x-forwarded-client-cert") ?? "";
  const certificate = certificateSubject(xfcc);
  const hash = certificateHash(xfcc);
  if (!certificate || revokedCertificate(revocations, certificate, hash)) return false;
  if (typeof claims?.jti === "string" && revocations.tokenIds.includes(claims.jti)) return false;
  const permissions = Array.isArray(claims?.permissions) ? claims.permissions : [];
  const identityPermission = certificate === "factory-control" ? "admin:temporal-system" : `admin:${certificate}`;
  return Boolean(claims?.sub === certificate && claims.iss === expectedIssuer && (claims.aud === expectedAudience || claims.aud?.includes(expectedAudience)) && Number.isInteger(claims.exp) && claims.exp > Math.floor(Date.now() / 1000) && permissions.includes(identityPermission));
}

/**
 * The read-only HTTP route. The caller presents a namespace certificate and
 * no token; the gateway injects that namespace's `read:<namespace>` token.
 * Every refusal is decided here, before anything is injected, and names its
 * reason: `revocations` (the list is unreadable), `token` (the caller sent its
 * own, which would otherwise be a way around this check), `method`, `path`,
 * `certificate` (absent or revoked), `namespace` (the path names another
 * namespace than the certificate), `grant` (no usable read token on file).
 */
export function authorizeRead(request, revocations, readToken) {
  if (revocations === null) return { allowed: false, reason: "revocations" };
  if (request.headers.has("authorization")) return { allowed: false, reason: "token" };
  if (request.method !== "GET") return { allowed: false, reason: "method" };
  const url = new URL(request.url);
  const path = url.pathname.slice(HTTP_READ_PREFIX.length);
  const match = READS.map((pattern) => pattern.exec(path)).find(Boolean);
  const workflows = path.endsWith("/workflows");
  if (!match || (!workflows && url.search !== "") || (workflows && [...url.searchParams.keys()].some((key) => key !== "query"))) return { allowed: false, reason: "path" };
  const xfcc = request.headers.get("x-forwarded-client-cert") ?? "";
  const certificate = certificateSubject(xfcc);
  if (!certificate || revokedCertificate(revocations, certificate, certificateHash(xfcc))) return { allowed: false, reason: "certificate" };
  let namespace;
  try { namespace = decodeURIComponent(match[1]); } catch { return { allowed: false, reason: "path" }; }
  if (namespace !== certificate) return { allowed: false, reason: "namespace" };
  const token = readToken(certificate);
  const claims = token && payload(token);
  if (!claims || claims.sub !== certificate || !Array.isArray(claims.permissions) || !claims.permissions.includes(`read:${certificate}`) || (typeof claims.jti === "string" && revocations.tokenIds.includes(claims.jti))) return { allowed: false, reason: "grant" };
  return { allowed: true, token };
}

/** The namespace's read token from the provisioner's token directory, or undefined. Namespace names cannot traverse. */
export function readTokenFrom(directory) {
  return (namespace) => {
    if (!directory || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(namespace)) return undefined;
    try { return readFileSync(join(directory, `${namespace}.token`), "utf8").trim(); } catch { return undefined; }
  };
}

export function handle(request, environment = process.env) {
  const revocations = readRevocations(environment.FACTORY_TEMPORAL_REVOCATIONS);
  if (new URL(request.url).pathname.startsWith(HTTP_READ_PREFIX)) {
    const decision = authorizeRead(request, revocations, readTokenFrom(environment.FACTORY_TEMPORAL_HTTP_TOKENS));
    console.log(`temporal http read ${decision.allowed ? "allowed" : `denied: ${decision.reason}`}`);
    return decision.allowed
      ? new Response(null, { status: 200, headers: { authorization: `Bearer ${decision.token}` } })
      : Response.json({ error: "temporal_http_forbidden", reason: decision.reason }, { status: 403 });
  }
  const allowed = authorize(request.headers, revocations);
  console.log(`temporal identity binding ${allowed ? "allowed" : "denied"}`);
  return allowed ? new Response(null, { status: 200 }) : new Response("certificate and JWT claims must match", { status: 403 });
}

if (import.meta.main) Bun.serve({ port: 17445, fetch: (request) => handle(request) });
