import { json } from "@sveltejs/kit";
import { z } from "zod";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";
import { requireAdmin, requireScope } from "$lib/server/security/api-keys";
import { listModels } from "$server/providers/local-model-check";
import { checkLocalProviderTarget } from "$lib/server/security/url-validation";

// Boundary validation. POST drives a server-side fetch() to a
// caller-supplied origin; the SSRF guards downstream still run on
// `baseUrl`. Schema only pins shape — exact 400 messages are preserved
// verbatim by the existing field guards so the test contract holds.
const postBodySchema = z
  .object({
    baseUrl: z.string().optional(),
  })
  .strict();

export const POST: RequestHandler = async ({ request, locals }) => {
  // sec-H1: admin role required. Pre-fix this route was only gated by
  // requireScope(locals, "admin") which is a no-op for cookie auth, so any
  // authenticated member could drive server-side fetch() to arbitrary URLs
  // (cloud metadata, internal services, …) — SSRF.
  //
  // F2: the sec-H1 fix closed the cookie hole but left the key axis open, so
  // a key minted `--scopes read --role admin` still reached this SSRF
  // primitive. `requireScope("admin")` closes it (cookie sessions carry no
  // `apiKeyScopes` and are unaffected). Both helpers RETURN their denial
  // (#84); role first so a non-admin gets the uniform 403.
  const adminErr = requireAdmin(locals);
  if (adminErr) return adminErr;
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;

  const raw = await request.json().catch(() => null);
  if (!raw || typeof raw !== "object") {
    return errorJson(400, "Invalid JSON body");
  }
  const parsedBody = postBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return errorJson(400, "baseUrl is required");
  }
  const { baseUrl } = parsedBody.data;

  if (!baseUrl || typeof baseUrl !== "string") {
    return errorJson(400, "baseUrl is required");
  }
  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
    return errorJson(400, "baseUrl must start with http:// or https://");
  }

  // sec-H1 (+ the documented loopback carve-out) — one shared decision so
  // this route and its /test sibling can never drift apart. Literal loopback
  // is allowed so the UI's own auto-filled Ollama URL works; every private,
  // link-local and DNS-rebound target is still refused. See
  // checkLocalProviderTarget's doc block.
  const target = await checkLocalProviderTarget(baseUrl);
  if (!target.ok) {
    return errorJson(400, target.error);
  }

  try {
    const result = await listModels(baseUrl);
    return json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return errorJson(500, message);
  }
};
