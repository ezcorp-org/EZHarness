import { json } from "@sveltejs/kit";
import * as settingQueries from "$server/db/queries/settings";
import { requireAdmin, requireScope } from "$lib/server/security/api-keys";
import { isSensitiveSettingKey } from "./deny-list";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  // F6: BOTH authorization axes, the `requireAdmin` + `requireScope("admin")`
  // pairing that route-contract.test.ts sanctions and that
  // `/api/settings/:key` already enforced via `checkRole`.
  //
  // Role alone proves the PRINCIPAL is an admin and says nothing about what
  // the KEY was scoped for, so a key minted `--scopes read --role admin`
  // reached the whole instance settings blob — provider/model config, feature
  // flags, every non-deny-listed key. A cookie session carries no
  // `apiKeyScopes`, so `requireScope` is a no-op for it and browser admins are
  // unaffected. Both helpers RETURN their denial; a thrown Response is what
  // SvelteKit renders as a 500. Role first, so a non-admin gets the uniform
  // 403 "Admin role required" rather than learning that scope was also short.
  const adminErr = requireAdmin(locals);
  if (adminErr) return adminErr;
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  const all = await settingQueries.getAllSettings();
  // Scrub sensitive keys even from admin list views. They must be managed via
  // dedicated endpoints (e.g. instance:jwtSecret via src/auth/jwt.ts).
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (!isSensitiveSettingKey(k)) filtered[k] = v;
  }
  return json(filtered);
};
