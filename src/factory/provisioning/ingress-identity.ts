/**
 * The harness's check on its trusted ingress (C01).
 *
 * The ingress maps a provisioned hostname to exactly one installation and sets
 * two headers on every request it forwards, overwriting whatever a client sent:
 * `X-EZCorp-Installation`, the installation ID, and `X-EZCorp-Ingress-Proof`, a
 * per-installation secret only the ingress and this harness hold. The server
 * does not take the mapping on faith: a provisioned installation answers a
 * request only when its Host is the installation's own hostname, the
 * installation header is its own ID, and the proof matches. The ID alone is not
 * secret, so the proof is what stops a local process that reached the
 * harness's loopback port from forging the ingress. Anything else is refused
 * with 421 Misdirected Request before any route runs.
 *
 * Two paths are exempt, because an orchestrator probes them directly and they
 * say nothing about any tenant: liveness and readiness.
 *
 * An installation that was not provisioned (no `EZCORP_INSTALLATION_HOSTNAME`)
 * keeps today's behaviour exactly.
 */
import { timingSafeEqual } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { privateDirectory, readPrivateBounded } from "../private-files";

export const FACTORY_INSTALLATION_HEADER = "x-ezcorp-installation";
export const FACTORY_INGRESS_PROOF_HEADER = "x-ezcorp-ingress-proof";
const EXEMPT = new Set(["/api/health", "/api/ready"]);

export interface FactoryIngressIdentity {
  readonly hostname: string;
  readonly installationId: string;
  /** The private file holding the ingress proof. Absent means the check is not configured. */
  readonly proofPath?: string;
}

export type FactoryIngressRefusal = "host" | "installation" | "proof";

export function factoryIngressIdentityFromEnv(env: Readonly<Record<string, string | undefined>>): FactoryIngressIdentity | null {
  const hostname = env.EZCORP_INSTALLATION_HOSTNAME?.trim().toLowerCase();
  const installationId = env.EZCORP_INSTALLATION_ID?.trim();
  const proofPath = env.EZCORP_INGRESS_PROOF_FILE?.trim();
  if (!hostname) return null;
  if (!installationId) throw new Error("EZCORP_INSTALLATION_HOSTNAME is set without EZCORP_INSTALLATION_ID.");
  return Object.freeze({ hostname, installationId, ...(proofPath ? { proofPath } : {}) });
}

function hostOnly(value: string): string {
  const host = value.trim().toLowerCase();
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

function sameSecret(presented: string | null, expected: string | undefined): boolean {
  if (presented === null || expected === undefined) return false;
  const left = Buffer.from(presented), right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

/**
 * `null` when the request may proceed; the refusal reason otherwise. `proof`
 * is the ingress proof the harness holds, or undefined when it cannot be read:
 * a configured check whose proof is unreadable refuses everything, rather than
 * silently accepting a forged request.
 */
export function factoryIngressRefusal(identity: FactoryIngressIdentity | null, request: { readonly pathname: string; readonly headers: Pick<Headers, "get"> }, proof?: string): FactoryIngressRefusal | null {
  if (!identity || EXEMPT.has(request.pathname)) return null;
  const host = request.headers.get("host");
  const forwarded = request.headers.get("x-forwarded-host");
  if (!host || hostOnly(host) !== identity.hostname || (forwarded !== null && hostOnly(forwarded) !== identity.hostname)) return "host";
  if (request.headers.get(FACTORY_INSTALLATION_HEADER) !== identity.installationId) return "installation";
  if (identity.proofPath !== undefined && !sameSecret(request.headers.get(FACTORY_INGRESS_PROOF_HEADER), proof)) return "proof";
  return null;
}

let cachedIdentity: { readonly key: string; readonly identity: FactoryIngressIdentity | null } | undefined;
let cachedProof: { readonly path: string; readonly value: string } | undefined;

/** The proof, read through the private reader once it exists; retried while it does not. */
async function readProof(path: string): Promise<string | undefined> {
  if (cachedProof?.path === path) return cachedProof.value;
  try {
    const absolute = resolve(path);
    const directory = await privateDirectory(dirname(absolute));
    try {
      const value = new TextDecoder("utf-8", { fatal: true }).decode(await readPrivateBounded(directory, basename(absolute), 1_024)).trim();
      cachedProof = { path, value };
      return value;
    } finally { await directory.close(); }
  } catch { return undefined; }
}

/** The hook's entry: a 421 response to return, or null. Reads the environment once per value. */
export async function factoryIngressResponse(request: Request, env: Readonly<Record<string, string | undefined>> = process.env): Promise<Response | null> {
  const key = `${env.EZCORP_INSTALLATION_HOSTNAME ?? ""}\u0000${env.EZCORP_INSTALLATION_ID ?? ""}\u0000${env.EZCORP_INGRESS_PROOF_FILE ?? ""}`;
  if (cachedIdentity?.key !== key) cachedIdentity = { key, identity: factoryIngressIdentityFromEnv(env) };
  const { identity } = cachedIdentity;
  const pathname = new URL(request.url).pathname;
  const proof = identity?.proofPath !== undefined && !EXEMPT.has(pathname) ? await readProof(identity.proofPath) : undefined;
  const refusal = factoryIngressRefusal(identity, { pathname, headers: request.headers }, proof);
  if (refusal === null) return null;
  return new Response(JSON.stringify({ error: "misdirected_request", reason: refusal }), { status: 421, headers: { "content-type": "application/json" } });
}
