import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireRole } from "$server/auth/middleware";
import { listUsers, listUsersPage } from "$server/db/queries/users";
import { requireScope } from "$lib/server/security/api-keys";

/** Clamp bound for the opt-in pager. */
const MAX_LIMIT = 100;

/** Marker for a parsed param that was syntactically invalid. */
const INVALID = Symbol("invalid-param");

/**
 * Parse a non-negative-integer query param.
 * - absent → `undefined`
 * - valid → the number
 * - malformed → `INVALID`
 *
 * Only accepts plain decimal-digit strings. `Number()` would coerce
 * `1e2`→100 and `0x10`→16, letting non-canonical forms (and the empty
 * string → 0) slip past; the `/^\d+$/` guard rejects anything that
 * isn't a run of base-10 digits before we parse.
 */
function parseNonNegInt(raw: string | null): number | undefined | typeof INVALID {
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) return INVALID;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return INVALID;
  return n;
}

export const GET: RequestHandler = async ({ locals, url }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  try {
    requireRole(locals, "admin");

    const limitRaw = url.searchParams.get("limit");

    // Opt-in pagination (Settings v2, locked decision 1): with NO `limit`
    // param the contract is unchanged — return the full list as `{ users }`
    // (TeamsSection + others depend on this). Only branch to paging when
    // `limit` is explicitly present.
    if (limitRaw === null) {
      const allUsers = await listUsers();
      const sanitized = allUsers.map(({ passwordHash, ...u }) => u);
      return json({ users: sanitized });
    }

    const limit = parseNonNegInt(limitRaw);
    if (limit === INVALID || limit === undefined || limit < 1) {
      return json({ error: "Invalid limit: must be a positive integer" }, { status: 400 });
    }
    const offset = parseNonNegInt(url.searchParams.get("offset"));
    if (offset === INVALID) {
      return json({ error: "Invalid offset: must be a non-negative integer" }, { status: 400 });
    }
    const q = url.searchParams.get("q")?.trim() || undefined;

    const { users: page, total } = await listUsersPage({
      limit: Math.min(limit, MAX_LIMIT),
      offset: offset ?? 0,
      q,
    });
    const sanitized = page.map(({ passwordHash, ...u }) => u);
    return json({ users: sanitized, total });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
