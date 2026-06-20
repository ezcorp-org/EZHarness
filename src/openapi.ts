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
    if (e.scope && e.scope !== "public") {
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
      description: "Generated from src/api-registry.ts. Bearer auth uses ezk_* API keys; scope names appear in each operation's security requirement.",
    },
    ...(opts.serverUrl ? { servers: [{ url: opts.serverUrl }] } : {}),
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "ezk_* API key" },
      },
    },
    paths,
  };
}
