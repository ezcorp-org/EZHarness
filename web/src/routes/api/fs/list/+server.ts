import { json } from "@sveltejs/kit";
import { readdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  if (user.role !== "admin") {
    return json({ error: "Access denied: admin role required" }, { status: 403 });
  }

  const sandboxRoot = process.env.EZCORP_PROJECT_ROOT ?? process.cwd();
  const raw = url.searchParams.get("dir") ?? sandboxRoot;
  const requested = resolve(raw);

  // Resolve symlinks on both the sandbox root and the requested path, then
  // compare real paths.  This closes the symlink-escape gap: a symlink inside
  // the sandbox that points outside it will resolve to a real path that does
  // not share the sandbox prefix and therefore be rejected.
  let realSandbox: string;
  try {
    realSandbox = await realpath(sandboxRoot);
  } catch {
    return json({ error: "Sandbox root unavailable" }, { status: 500 });
  }

  let realRequested: string;
  try {
    realRequested = await realpath(requested);
  } catch {
    // Nonexistent path — preserve prior behaviour of returning an empty listing.
    return json([], { status: 200 });
  }

  if (realRequested !== realSandbox && !realRequested.startsWith(realSandbox + "/")) {
    return json({ error: "Access denied: path outside allowed sandbox" }, { status: 403 });
  }

  const showHidden = url.searchParams.get("hidden") === "1";
  try {
    const dirents = await readdir(realRequested, { withFileTypes: true });
    const entries = dirents
      .filter((d) => showHidden || !d.name.startsWith("."))
      .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
      .sort((a, b) =>
        a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
      );
    return json(entries);
  } catch {
    return json([], { status: 200 });
  }
};
