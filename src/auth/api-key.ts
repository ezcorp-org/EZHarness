/**
 * Pure, dependency-free primitives for EZCorp user API keys (`ezk_*`).
 *
 * This lives in `src/` (backend, node:crypto only — no web `$server`/`$lib`
 * aliases) so BOTH the SvelteKit server (`web/.../security/api-keys.ts`,
 * which re-exports these) AND the backend CLI (`src/cli.ts key:mint`) share
 * ONE definition of how a key is generated, hashed, and where its settings
 * row lives. Verification (`verifyApiKey`) and request gating
 * (`requireScope`) stay web-side — they need the settings store and
 * `locals`.
 */
import crypto from "node:crypto";
import type { ToolPolicy } from "./tool-policy";

/**
 * The surfaces an API key may touch.
 *
 * `write` was added 2026-08 because the other four are SURFACE names and none
 * of them meant "may modify data". `read` was doing that job for 18 handlers —
 * including `DELETE /api/memories/:id` — while the shipped operator docs called
 * it "no writes". See docs/audit/2026-08-read-scope-mutation-inventory.md.
 *
 * These are FLAT: `hasRequiredScope` is an `includes()`, so nothing here
 * subsumes anything else. `write` does NOT imply `read`, and holding `admin`
 * grants none of the others. A key that both reads and mutates its own data
 * carries `["read","write"]` — which is what the CLI now mints by default.
 */
export type ApiKeyScope = "read" | "write" | "chat" | "extensions" | "admin";

/** Canonical scope list — the source of truth for CLI/route validation. */
export const API_KEY_SCOPES: readonly ApiKeyScope[] = [
  "read",
  "write",
  "chat",
  "extensions",
  "admin",
];

export function isApiKeyScope(value: string): value is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(value);
}

/**
 * The `scope` value that marks an API route SESSION-ONLY.
 *
 * Authorization on such a route is by INTERACTIVE BROWSER SESSION and by
 * nothing else: `requireSessionAuth` (`src/auth/middleware.ts`) refuses EVERY
 * API key with a 403, whatever scopes that key holds, so there is no scope an
 * operator could mint to reach it. It is the answer to the question the
 * registry could not previously express — a route with no `scope` at all was
 * indistinguishable from a route whose author forgot one.
 *
 * DELIBERATELY NOT A MEMBER OF {@link API_KEY_SCOPES}, and so
 * `isApiKeyScope("session")` is false: it can never be minted onto a key, it
 * can never satisfy `hasRequiredScope`, and `requireScope` cannot be called
 * with it (the parameter is typed `ApiKeyScope`). The one thing that must
 * never happen to this value is being read as a key scope, and the type
 * system refuses it in every place a key scope is accepted.
 *
 * It lives HERE, beside the vocabulary it is defined against, because the two
 * modules that need the literal — `src/api-registry.ts`, which spells it into
 * `ApiRouteScope`, and `src/auth/tool-policy.ts`, which refuses to mint an
 * allowlist naming such a route — must not import each other: tool-policy is
 * loaded by the SvelteKit hook on every request, and pulling the 300-entry
 * registry array into that graph to reach one string is the wrong trade.
 */
export const SESSION_ROUTE_SCOPE = "session";

/**
 * Does an API-key principal's scope set satisfy a required scope?
 *
 * `undefined` scopes mean the request is a COOKIE session (no API key), which
 * is NOT scope-gated — those callers are authorized purely by role, so this
 * returns `true`. For a key-authed request the required scope must be present.
 * Pure + shared so the web `requireScope` gate and the backend `checkRole`
 * (role + scope) gate can never drift on the "cookie ⇒ allow-all" rule.
 */
export function hasRequiredScope(
  apiKeyScopes: readonly ApiKeyScope[] | undefined,
  scope: ApiKeyScope,
): boolean {
  if (!apiKeyScopes) return true;
  return apiKeyScopes.includes(scope);
}

/**
 * A key's ROLE — the second authorization axis, orthogonal to scopes.
 *
 * Scopes gate WHICH surfaces a key can touch (`requireScope`); role gates
 * whether it is a full admin principal (`requireRole`/`checkRole`). Every
 * key defaults to `member`; an `admin`-role key is an explicit opt-in that
 * makes `requireRole(admin)` routes (settings, extension lifecycle, MCP
 * servers, users/teams, audit) reachable by an external harness. Bearer
 * principals were historically hard-coded to `member`, which is why those
 * routes were unreachable by ANY key before role-carrying keys existed.
 */
export type ApiKeyRole = "member" | "admin";

/** Canonical role list — source of truth for CLI/route/schema validation. */
export const API_KEY_ROLES: readonly ApiKeyRole[] = ["member", "admin"];

export function isApiKeyRole(value: string): value is ApiKeyRole {
  return (API_KEY_ROLES as readonly string[]).includes(value);
}

export interface GeneratedKey {
  raw: string;
  hash: string;
  keyId: string;
}

/** Shape of the value stored at the `apikey:<userId>:<keyId>` settings row. */
export interface ApiKeyEntry {
  hash: string;
  userId: string;
  scopes: ApiKeyScope[];
  /** The key's role. Optional on-disk: keys minted before role-carrying keys
   *  existed have no `role` field and are read back as `member` (see
   *  `verifyApiKey`). No DB migration is needed — the settings row is JSON. */
  role?: ApiKeyRole;
  /** Per-key tool policy (route allowlist, locked mode, caller-tool caps).
   *  Optional on-disk for exactly the reason `role` is: the settings row is
   *  JSON, so a key minted before policies existed simply has no field and
   *  reads back as an UNPOLICIED key — today's behaviour, no migration.
   *  See `src/auth/tool-policy.ts` for the shape and its predicates. */
  toolPolicy?: ToolPolicy;
  name: string;
  createdAt: number;
}

/** Settings-store key for a user's API key. Single source of truth so the
 *  GET/POST/DELETE routes and the CLI never drift on the prefix format. */
export function apiKeySettingsKey(userId: string, keyId: string): string {
  return `apikey:${userId}:${keyId}`;
}

/** Prefix used to enumerate a user's keys (e.g. in the list endpoint). */
export function apiKeySettingsPrefix(userId: string): string {
  return `apikey:${userId}:`;
}

/**
 * Pointer row written at mint time so `verifyApiKey` can do an O(1) lookup
 * by hash instead of a full settings-table scan on every Bearer request.
 * Keyed by the key's SHA-256 hash; the value points back at the canonical
 * per-user `apikey:<userId>:<keyId>` row. This is a derived INDEX — the
 * per-user row stays the source of truth (GET-list / DELETE-by-keyId rely
 * on it), so the index can always be rebuilt by re-scanning. No DB
 * migration is needed: it is just another settings row.
 */
export function apiKeyHashIndexKey(hash: string): string {
  return `apikeyhash:${hash}`;
}

/** Value stored at the `apikeyhash:<hash>` index row. */
export interface ApiKeyHashIndexEntry {
  userId: string;
  keyId: string;
}

/**
 * Scope ceiling enforced at mint time: a key must never carry authority its
 * OWNER lacks. Only an instance admin may mint the `admin` scope; everyone
 * else is capped at the non-privileged scopes. Pure + shared by the HTTP
 * route and the CLI so the two paths can never drift.
 *
 * Returns the offending (over-ceiling) scopes, or an empty array when the
 * request is within ceiling. Callers turn a non-empty result into a 403
 * (HTTP) or an exit(1) (CLI).
 */
export function scopesOverCeiling(
  role: string | undefined,
  scopes: readonly ApiKeyScope[],
): ApiKeyScope[] {
  if (role === "admin") return []; // admins may mint any scope, incl. admin
  return scopes.filter((s) => s === "admin");
}

/**
 * Anti-escalation gate for the ROLE axis: may an actor whose own role is
 * `actorRole` mint a key carrying `requestedRole`?
 *
 * Minting an `admin`-role key requires the actor to ALREADY be an admin —
 * otherwise a member-role key that merely holds the `admin` SCOPE (which is
 * enough to reach the mint route) could bootstrap itself an admin-role key
 * and cross the role wall. Minting a `member`-role key is always allowed
 * (that is the default posture). Pure + shared by the HTTP route so the
 * escalation check can never drift from the storage layer. The CLI mint path
 * is operator-trusted (shell access) and does not run this gate.
 */
export function canMintRole(
  actorRole: string | undefined,
  requestedRole: ApiKeyRole,
): boolean {
  if (requestedRole !== "admin") return true;
  return actorRole === "admin";
}

/**
 * Mint-time footgun guard for the ROLE↔SCOPE pair.
 *
 * The two axes are orthogonal, and `--scopes read --role admin` is accepted
 * by every mint path. Before F2 that combination silently WORKED on the admin
 * write routes, because they gated on role alone — which is the hole F2
 * closed. Now the same combination mints a key that its own role implies can
 * administer the instance but that every admin route refuses, and the operator
 * only finds out from a 403 later.
 *
 * This is a WARNING, not a refusal, on purpose: an admin-role key deliberately
 * scoped narrowly is a legitimate thing to want now that the scope is actually
 * enforced (e.g. an admin-owned key restricted to `read` for a dashboard). The
 * requirement is only that it never be minted SILENTLY. Callers print the
 * returned text; `null` means the pair is unremarkable.
 *
 * Pure + shared so the CLI and the HTTP mint route cannot drift on the advice,
 * exactly like `scopesOverCeiling` and `canMintRole` above.
 */
export function adminRoleScopeWarning(
  role: ApiKeyRole,
  scopes: readonly ApiKeyScope[],
): string | null {
  if (role !== "admin" || scopes.includes("admin")) return null;
  return [
    'WARNING: this key carries role "admin" but NOT the "admin" scope.',
    "  Admin routes authorize on BOTH axes, so it will be refused with",
    '  403 {"error":"Insufficient scope","required":"admin"} on every admin',
    "  surface — provider keys, search backend, MCP servers, instance settings.",
    "  It still works for whatever its other scopes allow.",
    "  For a key that can actually administer the instance, add the scope:",
    "    ezcorp key mint --user <email> --scopes admin --role admin",
  ].join("\n");
}

export function generateApiKey(): GeneratedKey {
  const raw = "ezk_" + crypto.randomBytes(32).toString("base64url");
  return { raw, hash: hashApiKey(raw), keyId: crypto.randomUUID() };
}

export function hashApiKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}
