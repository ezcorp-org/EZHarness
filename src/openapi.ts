/**
 * OpenAPI 3 spec generated from the hand-maintained `apiRegistry`
 * (`src/api-registry.ts`) — the single source of truth for the app's HTTP
 * surface. This is the external contract an integrating harness generates a
 * client against. Detailed request/response schemas are intentionally
 * omitted here (the registry keeps Zod schemas out to avoid cross-workspace
 * instance issues — the `/api/docs` endpoint maps them at serve time); this
 * builder captures paths, methods, tags, scope-based security, and summaries.
 */
import { apiRegistry, type ApiRouteEntry } from "./api-registry";
import { SESSION_ROUTE_SCOPE } from "./auth/api-key";

/**
 * The cookie an interactive browser session presents.
 *
 * Spelled here rather than imported: the definition lives in
 * `web/src/lib/server/auth/session-cookie.ts`, which this backend module
 * cannot reach (`$lib` is a web alias, and a `bun:test` under `src/` must not
 * import a `web/src/lib/**` module — it corrupts that module's coverage). The
 * two are pinned equal in `src/__tests__/openapi.test.ts`, so a rename there
 * fails here rather than silently publishing a cookie name that no longer
 * exists. NOT `pi_session` — that is the legacy cookie the migration bridge in
 * `hooks.server.ts` accepts and clears, not what a session presents today.
 */
const SESSION_COOKIE_NAME = "ezcorp_session";

function templatePath(path: string): string {
  // Registry uses Express-style `:id`; OpenAPI uses `{id}`.
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function operationId(e: ApiRouteEntry): string {
  const slug = e.path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${e.method.toLowerCase()}_${slug}`;
}

export interface OpenApiOptions {
  title?: string;
  version?: string;
  serverUrl?: string;
}

export function buildOpenApiSpec(opts: OpenApiOptions = {}): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const e of apiRegistry) {
    const p = templatePath(e.path);
    const op: Record<string, unknown> = {
      summary: e.description,
      operationId: operationId(e),
      tags: [e.category],
      responses: { "200": { description: e.responseDescription ?? "OK" } },
    };
    // Scope-based security. "public" (or unset) → no auth requirement.
    //
    // `"session"` IS NOT A KEY SCOPE and must never reach `bearerAuth`:
    // emitting `security: [{ bearerAuth: ["session"] }]` would tell an
    // integrator to mint a key with a scope that does not exist, for a route
    // that answers every key with a 403. It renders as the COOKIE scheme
    // instead — the true statement, and one no generated client can turn into
    // a bearer call. Ordered first so the key-scope branch below can only ever
    // see an `ApiKeyScope`.
    if (e.scope === SESSION_ROUTE_SCOPE) {
      op.security = [{ sessionCookie: [] }];
    } else if (e.scope && e.scope !== "public") {
      op.security = [{ bearerAuth: [e.scope] }];
    }
    // Path params from the template.
    const params = [...p.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    if (params.length > 0) op.parameters = params;

    (paths[p] ??= {})[e.method.toLowerCase()] = op;
  }

  return {
    openapi: "3.0.3",
    info: {
      title: opts.title ?? "EZCorp API",
      version: opts.version ?? "0.1.0",
      description: "Generated from src/api-registry.ts. Bearer auth uses ezk_* API keys; scope names appear in each operation's security requirement. An operation secured with sessionCookie is SESSION-ONLY — it refuses every API key with a 403, whatever scopes the key holds, so there is no key to mint for it.",
    },
    ...(opts.serverUrl ? { servers: [{ url: opts.serverUrl }] } : {}),
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "ezk_* API key" },
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: SESSION_COOKIE_NAME,
          description:
            "Interactive browser session. An operation requiring it cannot be called with an API key of ANY scope — requireSessionAuth answers every key with 403.",
        },
      },
    },
    paths,
  };
}
