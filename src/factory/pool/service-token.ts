import { createPublicKey, verify } from "node:crypto";

export interface PoolTokenClaims { sub: string; iss: string; aud: string | string[]; exp: number; scope: string[] }
export interface PoolTokenVerifierOptions { issuer: string; audience: string; publicKeys: Readonly<Record<string, string>> }

function segment(value: string): Record<string, unknown> {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  const parsed = JSON.parse(decoded) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Pool token payload is malformed.");
  return parsed as Record<string, unknown>;
}
function stringArray(value: unknown): string[] { if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error("Pool token scope is malformed."); return value; }

/** Verifies the issuer, audience, expiry, and signature before any caller reads a claim. */
export function verifyPoolToken(token: string, options: PoolTokenVerifierOptions, now = Date.now()): PoolTokenClaims {
  const pieces = token.split("."); if (pieces.length !== 3) throw new Error("Pool token is malformed.");
  const header = segment(pieces[0]!); const claims = segment(pieces[1]!);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Pool token algorithm is rejected.");
  const publicKey = options.publicKeys[header.kid]; if (!publicKey) throw new Error("Pool token key is untrusted.");
  if (!verify("RSA-SHA256", Buffer.from(`${pieces[0]}.${pieces[1]}`), createPublicKey(publicKey), Buffer.from(pieces[2]!, "base64url"))) throw new Error("Pool token signature is invalid.");
  const audience = claims.aud; const audiences = typeof audience === "string" ? [audience] : stringArray(audience);
  if (typeof claims.sub !== "string" || typeof claims.iss !== "string" || typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now || claims.iss !== options.issuer || !audiences.includes(options.audience)) throw new Error("Pool token claims are rejected.");
  return { sub: claims.sub, iss: claims.iss, aud: audience as string | string[], exp: claims.exp, scope: stringArray(claims.scope) };
}
