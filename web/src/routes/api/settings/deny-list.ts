// Sensitive setting keys that must never be read or written via the generic
// settings API, even by admins. These are managed by dedicated code paths
// (e.g. instance:jwtSecret by src/auth/jwt.ts, provider keys by the providers
// API). Exposing them here would let an attacker with admin cookies mint
// arbitrary JWTs or exfiltrate provider credentials.
const DENY_PATTERNS: readonly RegExp[] = [
  /^instance:jwtSecret$/,
  /^provider:apiKey:/,
  /^provider:oauth:/,
];

export function isSensitiveSettingKey(key: string): boolean {
  return DENY_PATTERNS.some((p) => p.test(key));
}
