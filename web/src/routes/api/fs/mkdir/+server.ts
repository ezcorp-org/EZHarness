import { json } from "@sveltejs/kit";
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
    return json({ error: "Access denied: admin role required" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { path?: unknown };
  if (typeof body.path !== "string" || !body.path.trim()) {
    return json({ error: "path required" }, { status: 400 });
  }

  const sandboxRoot = process.env.EZCORP_PROJECT_ROOT ?? process.cwd();
  const requested = resolve(body.path);

  let realSandbox: string;
  try {
    realSandbox = await realpath(sandboxRoot);
  } catch {
    return json({ error: "Sandbox root unavailable" }, { status: 500 });
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
    return json({ error: "Unable to resolve path" }, { status: 400 });
  }
  if (realAncestor !== realSandbox && !realAncestor.startsWith(realSandbox + "/")) {
    return json({ error: "Access denied: path outside allowed sandbox" }, { status: 403 });
  }

  try {
    await mkdir(requested, { recursive: true });
    return json({ path: requested }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "mkdir failed";
    return json({ error: msg }, { status: 500 });
  }
};
