/**
 * Spawns a temporary Bun subprocess that catches OAuth provider callbacks
 * on a fixed port and redirects the browser to the main app's callback page.
 *
 * A subprocess is still used (rather than in-process Bun.serve) because the
 * initiator route runs inside Vite SSR during dev, where Bun.serve() doesn't
 * bind ports reliably.
 *
 * sec-L5: historically this module inlined the worker script as a template
 * literal passed to `bun -e <script>`, interpolating values via JSON.stringify.
 * That worked but was one edit away from RCE — any future change that dropped
 * the JSON.stringify wrapper would yield unescaped code execution on the
 * developer's machine. The worker is now a standalone file
 * (oauth-callback-worker.ts) launched via `bun run <worker>`, and all
 * configuration is passed via environment variables. No user-influenced value
 * is ever interpolated into source code.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const activeProcs = new Map<number, import("bun").Subprocess>();

let cachedWorkerPath: string | null = null;

// Resolve the worker path lazily & robustly across runtimes:
//   • Bun sets import.meta.dir (absolute filesystem dir)
//   • Node / Vite SSR sets import.meta.url (file:// URL) but .dir is undefined
//   • Last-resort fallback is process.cwd() + known project-relative path
// Resolving at module top-level threw under Vite SSR (where .dir is undefined
// and path.resolve rejects undefined), crashing the entire route module before
// the handler could run — hence the opaque "Internal Error" 500s.
function getWorkerPath(): string {
  if (cachedWorkerPath) return cachedWorkerPath;
  const dir = (import.meta as { dir?: string }).dir;
  if (dir && typeof dir === "string") {
    cachedWorkerPath = resolve(dir, "oauth-callback-worker.ts");
    return cachedWorkerPath;
  }
  const url = (import.meta as { url?: string }).url;
  if (url && typeof url === "string") {
    try {
      cachedWorkerPath = fileURLToPath(new URL("./oauth-callback-worker.ts", url));
      return cachedWorkerPath;
    } catch { /* fall through */ }
  }
  cachedWorkerPath = resolve(process.cwd(), "src/auth/oauth-callback-worker.ts");
  return cachedWorkerPath;
}

/**
 * Spawn a temporary Bun process on `port` that catches a single OAuth callback
 * and 302-redirects to `appCallbackUrl` with code/state params forwarded.
 * Auto-exits after handling one request or after 5 minutes.
 */
export function startOAuthCallbackServer(port: number, appCallbackUrl: string): void {
  // sec-L5: defensive validation at the spawn boundary. These values are
  // trusted today (port from OAUTH_CONFIG, origin from url.origin after
  // sec-M1), but defense in depth: reject anything that isn't a plain
  // integer port and a well-formed http(s) URL before handing it to the
  // worker environment.
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`[oauth] invalid callback port: ${port}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(appCallbackUrl);
  } catch {
    throw new Error(`[oauth] invalid callback URL: ${appCallbackUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`[oauth] invalid callback protocol: ${parsed.protocol}`);
  }

  // Kill any existing process on this port
  const existing = activeProcs.get(port);
  if (existing) {
    existing.kill();
    activeProcs.delete(port);
  }

  // sec-L5: no template-string script. Worker is a static file; config goes
  // through env vars (which Bun.spawn does NOT interpret as shell).
  const proc = Bun.spawn(["bun", "run", getWorkerPath()], {
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      EZCORP_OAUTH_CB_PORT: String(port),
      EZCORP_OAUTH_CB_URL: parsed.toString(),
    },
  });

  activeProcs.set(port, proc);
}
