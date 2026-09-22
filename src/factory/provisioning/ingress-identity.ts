/**
 * The harness's check on its trusted ingress (C01).
 *
 * The ingress maps a provisioned hostname to exactly one installation and sets
 * `X-EZCorp-Installation` on every request it forwards, overwriting whatever a
 * client sent. The server does not take that on faith: a provisioned
 * installation answers a request only when its Host is the installation's own
 * hostname AND the installation header equals its own installation ID. A
 * request that reached the harness any other way — straight to its loopback
 * port, or through an ingress route bound to a different installation — is
 * refused with 421 Misdirected Request before any route runs.
 *
 * Two paths are exempt, because an orchestrator probes them directly and they
 * say nothing about any tenant: liveness and readiness.
 *
 * An installation that was not provisioned (no `EZCORP_INSTALLATION_HOSTNAME`)
 * keeps today's behaviour exactly.
 */
export const FACTORY_INSTALLATION_HEADER = "x-ezcorp-installation";
const EXEMPT = new Set(["/api/health", "/api/ready"]);

export interface FactoryIngressIdentity {
  readonly hostname: string;
  readonly installationId: string;
}

export function factoryIngressIdentityFromEnv(env: Readonly<Record<string, string | undefined>>): FactoryIngressIdentity | null {
  const hostname = env.EZCORP_INSTALLATION_HOSTNAME?.trim().toLowerCase();
  const installationId = env.EZCORP_INSTALLATION_ID?.trim();
  if (!hostname) return null;
  if (!installationId) throw new Error("EZCORP_INSTALLATION_HOSTNAME is set without EZCORP_INSTALLATION_ID.");
  return Object.freeze({ hostname, installationId });
}

function hostOnly(value: string): string {
  const host = value.trim().toLowerCase();
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

/** `null` when the request may proceed; the refusal reason otherwise. */
export function factoryIngressRefusal(identity: FactoryIngressIdentity | null, request: { readonly pathname: string; readonly headers: Pick<Headers, "get"> }): "host" | "installation" | null {
  if (!identity || EXEMPT.has(request.pathname)) return null;
  const host = request.headers.get("host");
  const forwarded = request.headers.get("x-forwarded-host");
  if (!host || hostOnly(host) !== identity.hostname || (forwarded !== null && hostOnly(forwarded) !== identity.hostname)) return "host";
  if (request.headers.get(FACTORY_INSTALLATION_HEADER) !== identity.installationId) return "installation";
  return null;
}

let cached: { readonly env: string | undefined; readonly identity: FactoryIngressIdentity | null } | undefined;

/** The hook's entry: a 421 response to return, or null. Reads the environment once per value. */
export function factoryIngressResponse(request: Request, env: Readonly<Record<string, string | undefined>> = process.env): Response | null {
  const key = `${env.EZCORP_INSTALLATION_HOSTNAME ?? ""}\u0000${env.EZCORP_INSTALLATION_ID ?? ""}`;
  if (cached?.env !== key) cached = { env: key, identity: factoryIngressIdentityFromEnv(env) };
  const refusal = factoryIngressRefusal(cached.identity, { pathname: new URL(request.url).pathname, headers: request.headers });
  if (refusal === null) return null;
  return new Response(JSON.stringify({ error: "misdirected_request", reason: refusal }), { status: 421, headers: { "content-type": "application/json" } });
}
