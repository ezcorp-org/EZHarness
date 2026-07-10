import type { RequestHandler } from "./$types";
import { resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { ReadableStream } from "node:stream/web";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { extensionDataRoot } from "$server/chat/attachments/ext-files-resolver";
import { getExtensionByName } from "$server/db/queries/extensions";
import { RateLimiter } from "$lib/server/security/rate-limiter";

// ── /api/extensions/[name]/data/[...path] — Phase A2 static-file route ──
//
// Serves files from `<projectRoot>/.ezcorp/extension-data/<name>/`.
// Pairs with the SDK's `extensionDataUrl()` URL builder
// (`packages/@ezcorp/sdk/src/runtime/preview.ts:94`). Without this
// route, every iframe-based extension would 404 because the SDK's
// canvas pattern points at this path.
//
// Security:
//   - `requireScope(locals, "chat")` — same scope as the events route.
//   - `requireAuth(locals)` — pulls the session user.
//   - Extension name is validated against the manifest regex
//     (defense-in-depth on the URL router).
//   - The extension must be INSTALLED and ENABLED (DB lookup) — without
//     this, any chat-scoped user could read the data dir of a disabled
//     (or never-installed but dir-present) extension name. Not-found
//     and disabled collapse to the same opaque 404.
//   - NOTE the served tree is PROJECT-SHARED, not per-user: every
//     chat-scoped user of the deployment can read any enabled
//     extension's data files here. Extensions must keep per-user
//     private data in `ctx.storage` (user scope) or `ctx.secrets` —
//     see docs/extensions/data-storage.md.
//   - Path is decoded once, normalized via `path.resolve`, and the
//     resolved absolute path MUST live under the extension's data
//     dir. `..` segments / `%2e%2e` survive into the resolved path
//     and are caught by the prefix check.
//   - The lexical prefix check is re-asserted on `realpath`s of both
//     sides (F4) — a symlink planted inside the data dir would
//     otherwise be followed by `stat`/`createReadStream` and escape
//     the data root.
//   - Strict CSP header on every response — blocks the
//     `<meta http-equiv="refresh" url=javascript:>` exfil class
//     called out as F5 in the security review by capping `script-src`
//     and forbidding cross-origin loads.
//   - 404 for unknown extensions / missing files / out-of-bounds paths.
//     Same status for every failure mode so the surface is opaque.

const NAME_REGEX = /^[a-z0-9][a-z0-9-_.]{0,63}$/;

// Per-user rate limit. The data route is hit by iframes in the chat UI
// rendering extension drafts — legitimate traffic is bursty (one fetch
// per draft revision) but bounded. 240/min/user comfortably handles a
// hot knob-tweak loop while capping a runaway iframe content that
// re-fetches in a tight loop.
// Module-scoped singleton so all requests share the limiter; cleanup
// runs on cold start (Bun keeps modules across requests).
export const __rateLimiter = new RateLimiter(240, 60_000);

const CONTENT_TYPE_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
});

function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = filePath.slice(dot + 1).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

// CSP header for served extension content. Strict by default —
// extensions can use inline scripts (their drafts are self-contained
// HTML), but cross-origin loads are blocked. `frame-ancestors 'self'`
// stops other origins from embedding our iframes.
//
// F5 caveat — this CSP does NOT contain a same-origin sandbox escape.
// The iframe that frames this content uses `sandbox="allow-scripts
// allow-same-origin"`, so the framed JS keeps the app's real origin:
// it can reach `window.parent` and drive the PARENT's fetch/DOM, which
// this (child-document) CSP cannot restrict. Tightening `connect-src`
// here would only break legitimate relative fetches inside drafts
// while leaving the `window.parent` path wide open. The real fix is
// serving extension content from a separate origin/subdomain — tracked
// in tasks/preview-port-exposure.md.
const STRICT_CSP =
  "default-src 'none'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; " +
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; " +
  "font-src 'self' data: https://fonts.gstatic.com; " +
  "img-src 'self' data: blob: https:; " +
  "connect-src 'self'; " +
  "frame-ancestors 'self'; " +
  "base-uri 'self'; " +
  "form-action 'none'";

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  // Per-user rate limit. Closes the DOS gap from the final review:
  // an authenticated user could otherwise pull arbitrary-size files
  // in a tight loop. Auth is the primary gate; this is defense-in-
  // depth + a budget signal for a runaway iframe.
  const rl = __rateLimiter.check(`user:${user.id}`);
  if (!rl.allowed) {
    return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(rl.retryAfter ?? 60),
      },
    });
  }

  const name = params.name;
  const rawPath = params.path;
  if (!name || !NAME_REGEX.test(name)) return errorJson(404, "Not found");
  if (!rawPath || rawPath.length === 0) return errorJson(404, "Not found");

  // Reject explicit ".." segments and absolute paths early. The
  // resolve+prefix check below catches everything, but failing fast
  // here keeps error messages clear and audit logs cleaner.
  const segments = rawPath.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return errorJson(404, "Not found");
  for (const seg of segments) {
    if (seg === "..") return errorJson(404, "Not found");
    // Reserved/control bytes in a segment — defense-in-depth (the SDK
    // already URI-encodes, the browser further encodes; surviving raw
    // control bytes here would be a bug elsewhere, but we reject.)
    if (/[\u0000-\u001f\u007f]/.test(seg)) return errorJson(404, "Not found");
  }

  // Enabled gate — the name must resolve to an INSTALLED and ENABLED
  // extension. A disabled extension's data dir stays on disk (disable
  // is not uninstall), and nothing stops a request from naming an
  // arbitrary `<name>` whose dir happens to exist; both cases must be
  // unreadable. Unknown and disabled collapse to the same opaque 404
  // as every other failure mode on this route.
  const ext = await getExtensionByName(name);
  if (!ext || !ext.enabled) return errorJson(404, "Not found");

  // Use the existing `extensionDataRoot` helper — single source of
  // truth for the `.ezcorp/extension-data/<name>/` layout. Defaults
  // to `process.cwd()`, matching every other host-side data resolver
  // in this codebase.
  const dataDir = extensionDataRoot(name);
  const target = resolve(dataDir, ...segments);

  // The resolved path MUST live under dataDir. Catches `..` traversal
  // attempts that survived the segment check (e.g. unicode normalization
  // cases) and any platform-specific edge case in `path.resolve`.
  if (!target.startsWith(dataDir + sep) && target !== dataDir) {
    return errorJson(404, "Not found");
  }

  // F4: the prefix check above is purely LEXICAL — it cannot see
  // symlinks, and `stat`/`createReadStream` below FOLLOW them. A
  // malicious extension that plants `link -> <repoRoot>/.ezcorp/data`
  // inside its own data dir would pass the lexical check and serve
  // bytes from outside the data root (DB files, JWT secret). So
  // canonicalize BOTH sides with `realpath` and re-assert containment
  // on the canonical paths. A symlink whose TARGET resolves inside the
  // data root still passes — the test is on the realpath, not "is a
  // symlink". This is a read route, so the file must exist: ENOENT
  // (missing file, missing data dir, dangling link) → opaque 404.
  let realTarget: string;
  try {
    const realRoot = await realpath(dataDir);
    realTarget = await realpath(target);
    if (!realTarget.startsWith(realRoot + sep)) {
      return errorJson(404, "Not found");
    }
  } catch {
    return errorJson(404, "Not found");
  }

  let info;
  try {
    info = await stat(realTarget);
  } catch {
    return errorJson(404, "Not found");
  }
  if (!info.isFile()) return errorJson(404, "Not found");

  const headers = new Headers({
    "Content-Type": contentTypeFor(target),
    "Content-Length": String(info.size),
    "Content-Security-Policy": STRICT_CSP,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    // Scanner-type extensions need getUserMedia on their top-level
    // extension page, so this route opts camera back IN for its own
    // served content. hooks.server.ts applies the global
    // `camera=()` deny only via `if (!response.headers.has(key))`, so
    // this route-level value wins here while every other route keeps the
    // deny. Camera still requires the browser's own per-origin user
    // consent — this header only stops the platform from pre-denying it.
    // Council trade-off documented in tasks/gcs-phase2.md (Phase D).
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
  });

  // Stream the file rather than buffering. For HTML drafts this is
  // overkill, but ingested PDFs / images can be large. Open the
  // CANONICAL path (not the symlink) so a link re-pointed between the
  // realpath check and the open can't redirect the read.
  const nodeStream = createReadStream(realTarget);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream;
  return new Response(webStream as unknown as BodyInit, { status: 200, headers });
};
