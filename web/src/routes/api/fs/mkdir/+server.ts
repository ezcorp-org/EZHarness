import { json } from "@sveltejs/kit";
import { z } from "zod";
import { errorJson } from "$lib/server/http-errors";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

// Boundary validation. POST mkdir accepts a single `path` field; the
// non-empty + sandbox-containment checks downstream still drive the
// "path required" 400 message verbatim so the existing test contract
// holds. Strict mode rejects unknown keys.
const postBodySchema = z.object({
  path: z.string().optional(),
}).strict();

export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  if (user.role !== "admin") {
    return errorJson(403, "Access denied: admin role required");
  }

  const parsed = postBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "path required");
  }
  const body = parsed.data;
  if (typeof body.path !== "string" || !body.path.trim()) {
    return errorJson(400, "path required");
  }

  const sandboxRoot = process.env.EZCORP_PROJECT_ROOT ?? process.cwd();
  const requested = resolve(body.path);

  let realSandbox: string;
  try {
    realSandbox = await realpath(sandboxRoot);
  } catch {
    return errorJson(500, "Sandbox root unavailable");
  }

  // The target itself does not exist yet; validate its nearest existing
  // ancestor against the sandbox so symlink escapes can't slip through.
  let ancestor = requested;
  let realAncestor: string | null = null;
  while (true) {
    try {
      realAncestor = await realpath(ancestor);
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  if (!realAncestor) {
    return errorJson(400, "Unable to resolve path");
  }
  if (realAncestor !== realSandbox && !realAncestor.startsWith(realSandbox + "/")) {
    return errorJson(403, "Access denied: path outside allowed sandbox");
  }

  try {
    await mkdir(requested, { recursive: true });
    return json({ path: requested }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "mkdir failed";
    return errorJson(500, msg);
  }
};
