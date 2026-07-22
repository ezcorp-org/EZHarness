import { mock } from "bun:test";
import type { AuthUser } from "../../auth/types";

// ── $server alias mocking ──────────────────────────────────────────
// SvelteKit route handlers import from "$server/*" which is aliased to "src/".
// Must be called at module level BEFORE importing any +server.ts handler files.
export function mockServerAlias() {
  const aliases: Record<string, string> = {
    "$server/auth/middleware": "../../auth/middleware",
    "$server/auth/jwt": "../../auth/jwt",
    "$server/auth/password": "../../auth/password",
    "$server/db/queries/users": "../../db/queries/users",
    "$server/db/queries/teams": "../../db/queries/teams",
    "$server/db/queries/invites": "../../db/queries/invites",
    "$server/db/queries/settings": "../../db/queries/settings",
    "$server/db/queries/audit-log": "../../db/queries/audit-log",
    "$server/db/queries/password-resets": "../../db/queries/password-resets",
    "$server/db/queries/agent-configs": "../../db/queries/agent-configs",
    "$server/db/queries/sessions": "../../db/queries/sessions",
    "$server/db/queries/error-logs": "../../db/queries/error-logs",
    "$server/db/queries/analytics": "../../db/queries/analytics",
    "$server/db/queries/agent-shares": "../../db/queries/agent-shares",
    "$server/db/queries/conversations": "../../db/queries/conversations",
    "$server/db/queries/marketplace": "../../db/queries/marketplace",
    "$server/db/queries/marketplace-versions": "../../db/queries/marketplace-versions",
    "$server/db/queries/marketplace-ratings": "../../db/queries/marketplace-ratings",
    "$server/db/queries/projects": "../../db/queries/projects",
    "$server/extensions/manifest": "../../extensions/manifest",
    "$server/extensions/types": "../../extensions/types",
    "$server/providers/credentials": "../../providers/credentials",
    "$server/providers/encryption": "../../providers/encryption",
    "$server/providers/registry": "../../providers/registry",
    "$server/db/connection": "../../db/connection",
    "$server/db/schema": "../../db/schema",
  };

  // $lib/server aliases resolve to the web/ tree
  const libAliases: Record<string, string> = {
    "$lib/server/security/validation": "../../../web/src/lib/server/security/validation",
  };

  for (const [alias, path] of Object.entries(aliases)) {
    mock.module(alias, () => require(path));
  }
  for (const [alias, path] of Object.entries(libAliases)) {
    mock.module(alias, () => require(path));
  }
}

/**
 * Additional $server alias mocks for MCP handlers, including a stub
 * replacement for `$server/mcp/client` so route tests don't spawn real
 * MCP processes.
 *
 * Call in addition to mockServerAlias(). Tests drive stub behavior via
 * the hooks exported from `./stub-mcp-client`.
 */
export function mockMcpServerAliases() {
  mock.module("$server/mcp/client", () => require("./stub-mcp-client"));
  mock.module("$server/db/queries/extensions", () => require("../../db/queries/extensions"));
  mock.module("$server/extensions/registry", () => require("../../extensions/registry"));
}

// ── Mock RequestEvent ──────────────────────────────────────────────
export interface MockEventOptions {
  method?: string;
  url?: string;
  body?: unknown;
  params?: Record<string, string>;
  user?: AuthUser;
  cookies?: Record<string, string>;
}

export function createMockEvent(opts: MockEventOptions = {}) {
  const method = opts.method ?? "GET";
  const url = new URL(opts.url ?? "http://localhost/test");

  const headers = new Headers({ "Content-Type": "application/json" });
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined && method !== "GET") {
    init.body = JSON.stringify(opts.body);
  }
  const request = new Request(url.toString(), init);

  const cookieStore = new Map<string, string>(
    Object.entries(opts.cookies ?? {}),
  );

  return {
    request,
    url,
    params: opts.params ?? {},
    locals: { user: opts.user } as App.Locals,
    cookies: {
      get: (name: string) => cookieStore.get(name) ?? null,
      getAll: () =>
        [...cookieStore.entries()].map(([name, value]) => ({ name, value })),
      set: (name: string, value: string, _opts?: unknown) => {
        cookieStore.set(name, value);
      },
      delete: (name: string, _opts?: unknown) => {
        cookieStore.delete(name);
      },
      serialize: () =>
        [...cookieStore.entries()].map(([n, v]) => `${n}=${v}`).join("; "),
    },
    route: { id: null },
    platform: {},
    isDataRequest: false,
    isSubRequest: false,
    getClientAddress: () => "127.0.0.1",
    fetch: globalThis.fetch,
    setHeaders: () => {},
  } as any; // Cast — close enough for handler testing
}

// Convenience: parse JSON from Response
export async function jsonFromResponse(res: Response): Promise<any> {
  return res.json();
}

// Convenience: admin and member user fixtures
export const ADMIN_USER: AuthUser = {
  id: "admin-001",
  email: "admin@test.local",
  name: "Test Admin",
  role: "admin",
};

export const MEMBER_USER: AuthUser = {
  id: "member-001",
  email: "member@test.local",
  name: "Test Member",
  role: "member",
};
