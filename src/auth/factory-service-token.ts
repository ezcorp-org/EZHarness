import { signInstallationToken, verifyInstallationToken } from "./jwt";

export const FACTORY_SERVICE_TOKEN_PREFIX = "ezkfsvc_";
export const FACTORY_SERVICE_CREDENTIAL_MAX_SECONDS = 60 * 60;
export const FACTORY_SERVICE_SCOPES = ["read", "write", "chat"] as const;
export type FactoryServiceScope = (typeof FACTORY_SERVICE_SCOPES)[number];

export interface FactoryServiceTokenIdentity {
  readonly serviceAccountId: string;
  readonly projectId: string;
  readonly credentialId: string;
  readonly revision: number;
  readonly scopes: readonly FactoryServiceScope[];
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface FactoryServiceTokenClaims extends FactoryServiceTokenIdentity {
  readonly tokenUse: "factory-service";
}

/** The service token is deterministic from its committed credential row. */
export async function signFactoryServiceToken(
  identity: FactoryServiceTokenIdentity,
  secret: string,
  installationId: string,
): Promise<string> {
  const scopes = canonicalScopes(identity.scopes);
  if (!isFactoryServiceTokenIdentity(identity) || !scopes || scopes.length !== identity.scopes.length
    || identity.issuedAtMs % 1_000 !== 0 || identity.expiresAtMs % 1_000 !== 0) {
    throw new Error("Invalid factory service credential identity");
  }
  const token = await signInstallationToken({
    tokenUse: "factory-service",
    sub: identity.serviceAccountId,
    projectId: identity.projectId,
    credentialId: identity.credentialId,
    revision: identity.revision,
    scopes,
    issuedAtMs: identity.issuedAtMs,
    expiresAtMs: identity.expiresAtMs,
    iat: Math.floor(identity.issuedAtMs / 1_000),
    exp: identity.expiresAtMs / 1_000,
  }, secret, installationId);
  return `${FACTORY_SERVICE_TOKEN_PREFIX}${token}`;
}

export async function verifyFactoryServiceToken(
  raw: string,
  secret: string,
  installationId: string,
): Promise<FactoryServiceTokenClaims | null> {
  if (!raw.startsWith(FACTORY_SERVICE_TOKEN_PREFIX)) return null;
  const payload = await verifyInstallationToken(raw.slice(FACTORY_SERVICE_TOKEN_PREFIX.length), secret, installationId);
  if (!payload || !exactClaims(payload)) return null;
  const scopes = canonicalScopes(payload.scopes);
  if (!scopes || scopes.length !== payload.scopes.length
    || scopes.some((scope, index) => scope !== payload.scopes[index])) return null;
  const identity = {
    serviceAccountId: payload.sub,
    projectId: payload.projectId,
    credentialId: payload.credentialId,
    revision: payload.revision,
    scopes,
    issuedAtMs: payload.issuedAtMs,
    expiresAtMs: payload.expiresAtMs,
  };
  if (!isFactoryServiceTokenIdentity(identity)
    || payload.iat !== Math.floor(payload.issuedAtMs / 1_000)
    || payload.exp !== payload.expiresAtMs / 1_000) return null;
  return Object.freeze({ tokenUse: "factory-service", ...identity, scopes: Object.freeze(scopes) });
}

export function isFactoryServiceScope(value: unknown): value is FactoryServiceScope {
  return typeof value === "string" && (FACTORY_SERVICE_SCOPES as readonly string[]).includes(value);
}

export function canonicalScopes(values: readonly unknown[]): FactoryServiceScope[] | null {
  if (values.length === 0 || values.some((value) => !isFactoryServiceScope(value))) return null;
  const selected = new Set(values as readonly FactoryServiceScope[]);
  return FACTORY_SERVICE_SCOPES.filter((scope) => selected.has(scope));
}

function exactClaims(value: Record<string, unknown>): value is Record<string, unknown> & {
  tokenUse: "factory-service";
  sub: string;
  projectId: string;
  credentialId: string;
  revision: number;
  scopes: FactoryServiceScope[];
  issuedAtMs: number;
  expiresAtMs: number;
  iat: number;
  exp: number;
} {
  const keys = ["tokenUse", "sub", "projectId", "credentialId", "revision", "scopes", "issuedAtMs", "expiresAtMs", "iat", "exp", "iss", "aud"];
  return Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key))
    && value.tokenUse === "factory-service"
    && typeof value.sub === "string"
    && typeof value.projectId === "string"
    && typeof value.credentialId === "string"
    && Array.isArray(value.scopes)
    && Number.isSafeInteger(value.revision)
    && Number.isSafeInteger(value.issuedAtMs)
    && Number.isSafeInteger(value.expiresAtMs);
}

export function isFactoryServiceTokenIdentity(identity: FactoryServiceTokenIdentity): boolean {
  const scopes = canonicalScopes(identity.scopes);
  return [identity.serviceAccountId, identity.projectId, identity.credentialId]
    .every((value) => value.length > 0 && value.length <= 512 && !value.includes("\0"))
    && Number.isSafeInteger(identity.revision) && identity.revision > 0
    && Number.isSafeInteger(identity.issuedAtMs) && identity.issuedAtMs >= 0
    && Number.isSafeInteger(identity.expiresAtMs) && identity.expiresAtMs > identity.issuedAtMs
    && identity.issuedAtMs % 1_000 === 0 && identity.expiresAtMs % 1_000 === 0
    && scopes !== null && scopes.length === identity.scopes.length
    && scopes.every((scope, index) => scope === identity.scopes[index]);
}
