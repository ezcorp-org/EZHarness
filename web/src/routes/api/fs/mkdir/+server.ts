import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  if (user.role !== "admin") {
    return errorJson(403, "Access denied: admin role required");
  }

  const body = (await request.json().catch(() => ({}))) as { path?: unknown };
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
