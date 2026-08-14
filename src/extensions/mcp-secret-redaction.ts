/**
 * MCP credential redaction — the ONE classifier that answers "which bytes of
 * this `McpServerDefinition` are a credential?".
 *
 * Four surfaces share it, which is the whole reason it is its own module:
 *
 *   1. **at rest** — `installMcpExtension` / `updateMcpExtension` persist
 *      `redactMcpServer(server)` in `extensions.manifest`
 *      (`src/db/queries/extensions.ts`).
 *   2. **read responses** — `redactExtensionSecrets` maps the same function
 *      over a row before any route serves it (defence in depth for rows
 *      written by an older build).
 *   3. **connect** — `rehydrateMcpServerSecrets` puts the real values back,
 *      using this module's redaction as its SAFETY GUARD (see
 *      {@link applyMcpSecretBlob}).
 *   4. **audit** — `mcp-audit.ts` runs {@link redactUrlSecretsInToken} over the
 *      stdio `command` it records.
 *
 * ── What counts as a credential (issue #205) ────────────────────────────
 *
 * `env` (stdio) and `headers` (http/sse) were the only carriers handled before
 * #205. Both are maps, and the rule there is simple and needs no heuristic:
 * every KEY survives, every VALUE is blanked — including innocuous ones like
 * `Accept`. Two more carriers get the same treatment here:
 *
 *   • **URL query values.** `?api_key=…` is a real MCP convention, and the
 *     `url` is served to every `read`-scope member. Every query VALUE is
 *     blanked and every NAME survives — exactly the header rule. The URL's
 *     PASSWORD (`https://user:pw@host`) goes too; the username survives,
 *     because a username is an identifier and a password is the credential.
 *   • **argv.** A token of the form `NAME=VALUE` loses its VALUE and keeps its
 *     NAME (`--token=x` → `--token=`, `GITHUB_TOKEN=x` → `GITHUB_TOKEN=`).
 *     That covers the flag form, the `-D`-style form and the
 *     `docker run -e NAME=VALUE` form with no name list to keep up to date.
 *
 * The `NAME=VALUE` rule is deliberately NOT gated on a "does this flag look
 * like a credential" list. `mcp-audit.ts` refused to write such a heuristic
 * for path segments for the right reason — a guess at a credential boundary
 * fails silently in the direction that costs the most — and the cost of
 * over-blanking is one operator-visible value moving from the manifest to the
 * secret store, which is where `Accept: application/json` already lives.
 *
 * ── Where a name list is unavoidable ───────────────────────────────────
 *
 * The SPACE-separated pair form (`--token SECRET`) cannot be blanked
 * wholesale: the token after a flag is indistinguishable from a positional
 * operand, and blanking every one of them would eat `npx -y <package>`. So
 * that one form is gated on {@link isSecretFlagName} — an exact-part match
 * over the flag's `-`/`_`/`.`-separated words, which is why `--path` and
 * `--author` do NOT match while `--gh-pat` and `--auth-header` do.
 *
 * ── Stated residual (this is a claim; `mcp-url-argv-secrets.test.ts` pins it) ──
 *
 * A BARE positional secret (`npx srv MY-SECRET`) is NOT redacted. Nothing
 * distinguishes it from a package name, a subcommand or a path, and blanking
 * it would break the command it belongs to. Every credential convention in
 * the wild attaches a name (`--token=…`, `--token …`, `?api_key=…`, an env
 * var, a header); the bare form does not, and is out of scope by design
 * rather than by omission.
 *
 * A URL's HOST is never touched, on purpose: `mcpNetworkHosts` derives the
 * manifest's `network` ceiling from the stored (redacted) definition, so
 * blanking a host would silently shrink the grant and deny the connect the
 * operator just authorised.
 *
 * Everything here is PURE — no DB, no fs, no env — and every function returns
 * its ARGUMENT BY REFERENCE when it changes nothing. That identity is load
 * bearing: `mcpServerHasPlaintextSecret` is `redactMcpServer(s) !== s`, which
 * is what makes the boot backfill exactly idempotent with no second
 * implementation of "is this row already clean".
 */
import type {
  ExtensionManifestV2,
  McpServerDefinition,
  McpServerHttp,
  McpServerSse,
  McpServerStdio,
} from "./types";

/**
 * A `<scheme>://<rest>` run inside a command-line token. Matched as a
 * SUBSTRING rather than anchored, because the operator writes the flag form
 * (`--endpoint=https://api.example.com`) about as often as the bare one, and
 * both name the same host. The scheme grammar is RFC 3986's
 * (`ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`), so a leading `--endpoint=`
 * can never be mistaken for one.
 *
 * Exported because `mcp-capabilities.ts` reads hosts off the same tokens this
 * module redacts. One regex, so "what counts as a URL here" cannot drift
 * between the redactor and the host derivation it must not break.
 */
export const TOKEN_URL_RE = /[a-z][a-z0-9+.-]*:\/\/\S+/i;

/** `<scheme>://<userinfo>@` at the START of a URL string. `[^/?#@]*` stops at
 *  the authority, so a later `@` inside a path or query never matches. */
const URL_USERINFO_RE = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#@]*)@/i;

/**
 * Blank every query-parameter VALUE in a URL string, keeping every NAME.
 *
 * String surgery, not `new URL(…).toString()`: the URL parser NORMALISES
 * (appends a root path, lower-cases the host, re-encodes escapes), so
 * round-tripping through it would rewrite bytes the operator typed even when
 * there is no secret to remove — and this function's identity-on-no-change
 * contract is what the backfill's idempotency rides on.
 *
 * A valueless (`?flag`) or already-blank (`?k=`) parameter is left alone.
 */
export function redactUrlQueryValues(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const hash = url.indexOf("#", q);
  const end = hash === -1 ? url.length : hash;
  const query = url.slice(q + 1, end);
  if (query.length === 0) return url;
  let changed = false;
  const params = query.split("&").map((param) => {
    const eq = param.indexOf("=");
    // No `=` at all → no value to leak. `=` as the last character → already blank.
    if (eq === -1 || eq === param.length - 1) return param;
    changed = true;
    return param.slice(0, eq + 1);
  });
  if (!changed) return url;
  return `${url.slice(0, q + 1)}${params.join("&")}${url.slice(end)}`;
}

/**
 * Drop a URL's userinfo PASSWORD, keeping the username.
 * `https://svc:pw@h/mcp` → `https://svc:@h/mcp`. A userinfo with no `:` is an
 * identifier alone and survives untouched.
 */
export function redactUrlPassword(url: string): string {
  const m = URL_USERINFO_RE.exec(url);
  if (!m) return url;
  const userinfo = m[2] ?? "";
  const colon = userinfo.indexOf(":");
  if (colon === -1 || colon === userinfo.length - 1) return url;
  return `${m[1]}${userinfo.slice(0, colon + 1)}@${url.slice(m[0].length)}`;
}

/** Both URL rules, applied in order. Identity when neither fires. */
export function redactUrlSecrets(url: string): string {
  return redactUrlQueryValues(redactUrlPassword(url));
}

/**
 * Apply {@link redactUrlSecrets} to the URL EMBEDDED in a command-line token,
 * leaving the rest of the token (`--endpoint=`, a trailing comma, …) verbatim.
 * Identity when the token holds no URL, or holds one with nothing to redact.
 */
export function redactUrlSecretsInToken(token: string): string {
  const m = TOKEN_URL_RE.exec(token);
  if (!m) return token;
  const url = m[0];
  const redacted = redactUrlSecrets(url);
  if (redacted === url) return token;
  return `${token.slice(0, m.index)}${redacted}${token.slice(m.index + url.length)}`;
}

/**
 * Flag words that mark the FOLLOWING argv token as a credential. Matched as
 * whole `-`/`_`/`.`-separated words so `--path`, `--pattern` and `--author` do
 * not collide with `pat`, `pat` and `auth`.
 */
const SECRET_FLAG_WORDS = new Set([
  "key", "keys", "apikey", "apikeys", "accesskey", "privatekey", "clientkey",
  "token", "tokens", "apitoken", "accesstoken", "authtoken", "bearer", "jwt",
  "secret", "secrets", "clientsecret",
  "password", "passwd", "pwd", "pass",
  "auth", "authorization", "oauth",
  "credential", "credentials", "cred", "creds",
  "pat", "sig", "signature",
  "session", "cookie", "header", "headers",
  "dsn", "connectionstring",
]);

/**
 * True when this flag token names a credential, i.e. the token AFTER it is a
 * secret value. Only consulted for the space-separated pair form — the
 * `NAME=VALUE` form needs no name list (see the module comment).
 */
export function isSecretFlagName(token: string): boolean {
  const name = token.replace(/^-+/, "").toLowerCase();
  if (name.length === 0) return false;
  for (const word of name.split(/[-_.]+/)) {
    if (word.length > 0 && SECRET_FLAG_WORDS.has(word)) return true;
  }
  return false;
}

/** `-v` / `--verbose` / `-Dx` — a token the shell reads as an option. */
function isFlagToken(token: string): boolean {
  return /^--?[A-Za-z]/.test(token);
}

/** A flag carrying no inline value, i.e. one whose value is the NEXT token. */
function isValuelessFlag(token: string): boolean {
  return isFlagToken(token) && !token.includes("=");
}

/**
 * Redact an argv array. Three rules, in precedence order, per token:
 *
 *   1. a token holding a URL keeps the URL's host+path and loses its query
 *      values + password ({@link redactUrlSecretsInToken});
 *   2. a `NAME=VALUE` token keeps `NAME=` and loses `VALUE`;
 *   3. a token following a credential-NAMED valueless flag is blanked whole.
 *
 * Rule 1 outranks rule 2 so `--endpoint=https://h/mcp?k=s` keeps the host the
 * `network` ceiling is derived from. Rule 3 skips a token that is itself a
 * flag (`--token --verbose` has no value to hide) and a token holding a URL
 * (rule 1 already handled it without destroying the host).
 *
 * Returns the SAME array reference when nothing changed.
 */
export function redactMcpArgv(args: readonly string[]): readonly string[] {
  const out: string[] = [];
  let changed = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? "";
    let next = token;
    const eq = token.indexOf("=");
    const prev = i > 0 ? (args[i - 1] ?? "") : "";
    if (TOKEN_URL_RE.test(token)) {
      next = redactUrlSecretsInToken(token);
    } else if (eq > 0 && eq < token.length - 1) {
      next = token.slice(0, eq + 1);
    } else if (!isFlagToken(token) && isValuelessFlag(prev) && isSecretFlagName(prev)) {
      next = "";
    }
    if (next !== token) changed = true;
    out.push(next);
  }
  return changed ? out : args;
}

/** Same-shaped map with every value blanked, or the SAME reference when every
 *  value is already blank (a redacted definition keeps its keys). */
function blankMapValues(map: Record<string, string>): Record<string, string> {
  const keys = Object.keys(map);
  if (keys.every((k) => map[k] === "")) return map;
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = "";
  return out;
}

/**
 * Strip every credential VALUE from an MCP server definition, preserving the
 * KEY/NAME set. The result is safe to persist in `extensions.manifest` and to
 * serve to a `read`-scope client.
 *
 * Returns the ARGUMENT BY REFERENCE when there was nothing to strip — see the
 * module comment on why that identity is load bearing.
 */
export function redactMcpServer(server: McpServerDefinition): McpServerDefinition {
  if (server.transport === "stdio") {
    const env = server.env ? blankMapValues(server.env) : undefined;
    const command = redactUrlSecretsInToken(server.command);
    const args = server.args ? redactMcpArgv(server.args) : undefined;
    if (env === server.env && command === server.command && args === server.args) return server;
    const out: McpServerStdio = { ...server, command };
    if (env) out.env = env;
    if (args) out.args = args as string[];
    return out;
  }
  const headers = server.headers ? blankMapValues(server.headers) : undefined;
  const url = redactUrlSecrets(server.url);
  if (headers === server.headers && url === server.url) return server;
  const out: McpServerHttp | McpServerSse = { ...server, url };
  if (headers) out.headers = headers;
  return out;
}

/**
 * Redact the MCP credentials from an extension ROW's manifest for a read-scope
 * response. Defence in depth: new installs already store a redacted manifest at
 * rest, but this also scrubs any legacy row whose manifest still carries
 * plaintext (until the boot backfill migrates it). Non-MCP rows pass through by
 * reference.
 *
 * Lives HERE, not in `db/queries/extensions.ts`, so a route can import it
 * without pulling in the DB module — which is also what lets a route's unit
 * test run the REAL redaction while it mocks every query away.
 */
export function redactExtensionSecrets<T extends { manifest: unknown }>(ext: T): T {
  const manifest = ext.manifest as ExtensionManifestV2 | null;
  if (!manifest || manifest.kind !== "mcp" || !manifest.mcpServers?.length) return ext;
  return {
    ...ext,
    manifest: { ...manifest, mcpServers: manifest.mcpServers.map(redactMcpServer) },
  };
}

/**
 * True when the definition still carries a credential in the clear — i.e.
 * redacting it would change something. The boot backfill's idempotency
 * predicate; deliberately DERIVED from the redactor rather than written twice,
 * so a carrier added to one can never be missed by the other.
 */
export function mcpServerHasPlaintextSecret(server: McpServerDefinition): boolean {
  return redactMcpServer(server) !== server;
}

/**
 * The plaintext an MCP extension's `extension_secrets` row holds.
 *
 * `auth` is the pre-#205 payload (stdio `env` / http-sse `headers`) and a blob
 * written by an older build is a BARE `auth` map with no envelope — see
 * {@link parseMcpSecretBlob}. `url` / `command` / `args` are #205's additions
 * and store the carrier VERBATIM rather than a per-name diff: rehydration then
 * needs no positional bookkeeping, and its guard is one equality (below).
 */
export type McpSecretBlob = {
  auth?: Record<string, string>;
  url?: string;
  command?: string;
  args?: string[];
};

/** Envelope discriminator. A blob without it is a pre-#205 bare `auth` map. */
export const MCP_SECRET_BLOB_VERSION = 2;

function hasNonBlankValue(map: Record<string, string>): boolean {
  return Object.values(map).some((v) => typeof v === "string" && v.length > 0);
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}

/**
 * The credential blob to encrypt for this definition, or `null` when it
 * carries none (in which case no secret row is written at all).
 *
 * Only carriers the redactor actually touched are stored, so a plain stdio
 * server still produces no row — the pre-#205 behaviour.
 */
export function buildMcpSecretBlob(server: McpServerDefinition): McpSecretBlob | null {
  const redacted = redactMcpServer(server);
  if (redacted === server) return null;
  const blob: McpSecretBlob = {};
  if (server.transport === "stdio") {
    const r = redacted as McpServerStdio;
    if (server.env && hasNonBlankValue(server.env)) blob.auth = { ...server.env };
    if (r.command !== server.command) blob.command = server.command;
    if (server.args && r.args !== server.args) blob.args = [...server.args];
  } else {
    const r = redacted as McpServerHttp | McpServerSse;
    if (server.headers && hasNonBlankValue(server.headers)) blob.auth = { ...server.headers };
    if (r.url !== server.url) blob.url = server.url;
  }
  return Object.keys(blob).length > 0 ? blob : null;
}

/** Serialize for `extension_secrets`. Always stamps the envelope version. */
export function serializeMcpSecretBlob(blob: McpSecretBlob): string {
  return JSON.stringify({ v: MCP_SECRET_BLOB_VERSION, ...blob });
}

/**
 * Parse a stored blob, accepting BOTH shapes: the `{v:2,…}` envelope and the
 * pre-#205 bare `{ "<header|env name>": "<value>" }` map, which is what every
 * row written before this change holds. `null` for anything unparseable — the
 * caller then leaves the (already blanked) definition alone.
 */
export function parseMcpSecretBlob(stored: string): McpSecretBlob | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.v === MCP_SECRET_BLOB_VERSION) {
    const blob: McpSecretBlob = {};
    if (isStringMap(rec.auth)) blob.auth = rec.auth;
    if (typeof rec.url === "string") blob.url = rec.url;
    if (typeof rec.command === "string") blob.command = rec.command;
    if (Array.isArray(rec.args) && rec.args.every((a) => typeof a === "string")) {
      blob.args = rec.args as string[];
    }
    return blob;
  }
  return isStringMap(rec) ? { auth: rec } : null;
}

function sameTokens(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * Put the real credentials back — the inverse of {@link redactMcpServer}, for
 * the server-side connect path only.
 *
 * `auth` OVERLAYS the map, so a key present only in the manifest survives as a
 * blank and a stored key wins. `url` / `command` / `args` are whole-value
 * substitutions and each is guarded by ONE equality: the stored value is used
 * only when redacting it reproduces what is at rest, i.e. only when the stored
 * value is provably the PRE-IMAGE of the stored manifest. A blob left over
 * from a config the manifest has since moved past therefore cannot dial a
 * stale host or paste one server's token into another's argv — the blanked
 * manifest value wins instead, which fails closed.
 */
export function applyMcpSecretBlob(
  server: McpServerDefinition,
  blob: McpSecretBlob,
): McpServerDefinition {
  if (server.transport === "stdio") {
    const out: McpServerStdio = { ...server };
    if (blob.auth) out.env = { ...(server.env ?? {}), ...blob.auth };
    if (blob.command !== undefined && redactUrlSecretsInToken(blob.command) === server.command) {
      out.command = blob.command;
    }
    if (blob.args && sameTokens(redactMcpArgv(blob.args), server.args ?? [])) {
      out.args = [...blob.args];
    }
    return out;
  }
  const out: McpServerHttp | McpServerSse = { ...server };
  if (blob.auth) out.headers = { ...(server.headers ?? {}), ...blob.auth };
  if (blob.url !== undefined && redactUrlSecrets(blob.url) === server.url) out.url = blob.url;
  return out;
}

// ── Edit-form merge: "blank means keep the existing secret" ───────────────
//
// The extension detail page pre-fills its edit form from the STORED
// (value-blanked) definition and posts it back, so every carrier arrives blank
// unless the admin retyped it. `PUT /api/mcp-servers/[id]` fills the blanks
// from the rehydrated previous definition before it re-connects — otherwise a
// description-only edit would authenticate with no token and 502.
//
// Everything is matched BY NAME, never by position: an admin who inserts a
// flag must not shift one secret into another slot.

/** name → value for every `NAME=VALUE` token, plus every credential-named
 *  flag's following token. The lookup table an edit's blanks are filled from. */
function argvValuesByName(args: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? "";
    const eq = token.indexOf("=");
    if (eq > 0 && eq < token.length - 1) {
      out.set(token.slice(0, eq), token.slice(eq + 1));
      continue;
    }
    if (!isValuelessFlag(token) || !isSecretFlagName(token)) continue;
    const value = args[i + 1];
    if (value !== undefined && value.length > 0 && !isFlagToken(value)) out.set(token, value);
  }
  return out;
}

/** name → value for every query parameter across every URL in `tokens`. */
function queryValuesByName(tokens: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const token of tokens) {
    const m = TOKEN_URL_RE.exec(token);
    if (!m) continue;
    const url = m[0];
    const q = url.indexOf("?");
    if (q === -1) continue;
    const hash = url.indexOf("#", q);
    const query = url.slice(q + 1, hash === -1 ? url.length : hash);
    for (const param of query.split("&")) {
      const eq = param.indexOf("=");
      if (eq > 0 && eq < param.length - 1) out.set(param.slice(0, eq), param.slice(eq + 1));
    }
  }
  return out;
}

/** Fill blank query values in one URL from `known`, and restore a blank
 *  password. Identity when nothing was blank. */
function mergeUrl(next: string, known: Map<string, string>, prevUrl: string | undefined): string {
  let out = next;
  const q = out.indexOf("?");
  if (q !== -1) {
    const hash = out.indexOf("#", q);
    const end = hash === -1 ? out.length : hash;
    let changed = false;
    const params = out
      .slice(q + 1, end)
      .split("&")
      .map((param) => {
        if (!param.endsWith("=")) return param;
        const value = known.get(param.slice(0, -1));
        if (value === undefined) return param;
        changed = true;
        return `${param}${value}`;
      });
    if (changed) out = `${out.slice(0, q + 1)}${params.join("&")}${out.slice(end)}`;
  }
  // A blank password (`svc:@h`) means "keep the previous one" — same rule.
  const m = URL_USERINFO_RE.exec(out);
  const prevMatch = prevUrl === undefined ? null : URL_USERINFO_RE.exec(prevUrl);
  if (m && prevMatch && (m[2] ?? "").endsWith(":")) {
    const prevInfo = prevMatch[2] ?? "";
    const colon = prevInfo.indexOf(":");
    if (colon !== -1 && prevInfo.slice(0, colon + 1) === m[2]) {
      out = `${m[1]}${prevInfo}@${out.slice(m[0].length)}`;
    }
  }
  return out;
}

/**
 * Fill every blank credential in an admin's submitted definition from the
 * (rehydrated) previous one. Blank means "unchanged"; a non-blank value
 * replaces. Keys present only in `prev` are preserved for maps, matching the
 * pre-#205 header behaviour.
 */
export function mergeMcpServerSecrets(
  next: McpServerDefinition,
  prev: McpServerDefinition | undefined,
): McpServerDefinition {
  if (next.transport === "stdio") {
    const prevStdio = prev && prev.transport === "stdio" ? prev : undefined;
    const prevArgs = prevStdio?.args ?? [];
    const out: McpServerStdio = { ...next };
    const prevEnv = prevStdio?.env ?? {};
    const env: Record<string, string> = { ...prevEnv };
    for (const [k, v] of Object.entries(next.env ?? {})) {
      if (v.trim() !== "") env[k] = v;
    }
    if (Object.keys(env).length > 0) out.env = env;
    const byName = argvValuesByName(prevArgs);
    const queries = queryValuesByName(prevArgs);
    out.command = mergeToken(next.command, byName, queries, prevStdio?.command);
    if (next.args) out.args = mergeArgv(next.args, byName, queries, prevArgs);
    return out;
  }
  const prevRemote = prev && prev.transport !== "stdio" ? prev : undefined;
  const headers: Record<string, string> = { ...(prevRemote?.headers ?? {}) };
  for (const [k, v] of Object.entries(next.headers ?? {})) {
    if (v.trim() !== "") headers[k] = v;
  }
  const out: McpServerHttp | McpServerSse = { ...next, headers };
  out.url = mergeUrl(next.url, queryValuesByName(prevRemote ? [prevRemote.url] : []), prevRemote?.url);
  return out;
}

/** One argv/command token's blanks filled from the previous definition. */
function mergeToken(
  token: string,
  byName: Map<string, string>,
  queries: Map<string, string>,
  prevToken: string | undefined,
): string {
  const m = TOKEN_URL_RE.exec(token);
  if (m) {
    const merged = mergeUrl(m[0], queries, prevToken);
    if (merged === m[0]) return token;
    return `${token.slice(0, m.index)}${merged}${token.slice(m.index + m[0].length)}`;
  }
  if (token.endsWith("=") && token.length > 1) {
    const value = byName.get(token.slice(0, -1));
    if (value !== undefined) return `${token}${value}`;
  }
  return token;
}

function mergeArgv(
  args: readonly string[],
  byName: Map<string, string>,
  queries: Map<string, string>,
  prevArgs: readonly string[],
): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? "";
    const prevPositional = prevArgs[out.length];
    out.push(mergeToken(token, byName, queries, prevPositional));
    // A credential-named flag whose value slot is empty or missing entirely —
    // the edit form joins argv on spaces, so a blanked pair-form value comes
    // back as a DROPPED token, not an empty one.
    if (!isValuelessFlag(token) || !isSecretFlagName(token)) continue;
    const value = byName.get(token);
    if (value === undefined) continue;
    const submitted = args[i + 1];
    if (submitted === undefined || isFlagToken(submitted)) {
      out.push(value);
    } else if (submitted.length === 0) {
      out.push(value);
      i += 1;
    }
  }
  return out;
}
