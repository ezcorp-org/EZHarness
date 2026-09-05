import { test, expect, describe, beforeEach, mock } from "bun:test";

// ── Mutable auth/scope state swapped by individual tests ─────────────────
// `authUser` drives requireAuth/requireRole. `apiKeyScopes` drives
// requireScope (undefined == cookie auth; arrays == API-key request).
let authUser: { id: string; email: string; name: string; role: string } | null = {
	id: "admin-1",
	email: "admin@test.com",
	name: "Admin",
	role: "admin",
};
let apiKeyScopes: string[] | undefined ;

const mockRequireAuth = mock(() => {
	if (!authUser) {
		throw new Response(JSON.stringify({ error: "Authentication required" }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		});
	}
	return authUser;
});

const mockRequireRole = mock((_locals: unknown, role: string) => {
	if (!authUser) {
		throw new Response(JSON.stringify({ error: "Authentication required" }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		});
	}
	if (authUser.role !== role) {
		throw new Response(JSON.stringify({ error: "Insufficient permissions" }), {
			status: 403,
			headers: { "Content-Type": "application/json" },
		});
	}
	return authUser;
});

const mockRequireScope = mock((_locals: unknown, scope: string) => {
	if (!apiKeyScopes) return null;
	if (apiKeyScopes.includes(scope)) return null;
	return new Response(JSON.stringify({ error: "Insufficient scope", required: scope }), {
		status: 403,
		headers: { "Content-Type": "application/json" },
	});
});

// checkRole (added when role-gated routes moved to a non-throwing gate): the
// route handlers import it and RETURN its Response on denial. Mirror the real
// impl — delegate to requireRole (which throws a Response on 401/403; catch and
// return it), then enforce the admin-scope axis for API-key principals only
// (undefined scopes = cookie session ⇒ allow-all). Returns the auth user on
// success.
const mockCheckRole = mock((locals: unknown, role: string) => {
	try {
		const user = mockRequireRole(locals, role);
		if (apiKeyScopes && !apiKeyScopes.includes("admin")) {
			return new Response(JSON.stringify({ error: "Insufficient scope", required: "admin" }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			});
		}
		return user;
	} catch (e) {
		if (e instanceof Response) return e;
		throw e;
	}
});

mock.module("$server/auth/middleware", () => ({
	requireAuth: mockRequireAuth,
	requireRole: mockRequireRole,
	checkRole: mockCheckRole,
}));

mock.module("$lib/server/security/api-keys", () => ({
	requireScope: mockRequireScope,
}));

// ── DB/query mocks ───────────────────────────────────────────────────────
const extensionFixture = {
	id: "ext-1",
	name: "sample-ext",
	enabled: false,
	manifest: {
		name: "sample-ext",
		version: "1.0.0",
		permissions: { network: ["api.example.com"], shell: false },
	},
	grantedPermissions: { grantedAt: {} },
	consecutiveFailures: 0,
	disabledUntil: null,
	disabledReason: null,
	manifestPermissionsSnapshot: null,
	installPath: "/tmp/ext",
	kind: "extension",
	origin: "local",
	sourceUrl: null,
	sourceRef: null,
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
};

let extensionStore: any = null;

const mockGetExtension = mock(async (_id: string) => extensionStore as any);
const mockUpdateExtension = mock(async (_id: string, patch: Partial<any>) => {
	if (!extensionStore) return null;
	extensionStore = { ...extensionStore, ...patch };
	return extensionStore;
});
const mockResetFailures = mock(async (_id: string) => {});
const mockListExtensions = mock(async () => (extensionStore ? [extensionStore] : []));
const mockDeleteExtension = mock(async (_id: string) => true);

mock.module("$server/db/queries/extensions", () => ({
	getExtension: mockGetExtension,
	// The GET route resolves its route param as a REFERENCE (id OR manifest
	// name) so the post-install `/extensions/<name>` deep-link renders. This
	// double resolves by either, mirroring the real query's id-wins rule.
	getExtensionByRef: mock(async (ref: string) => {
		const byId = await mockGetExtension(ref);
		if (byId) return byId;
		const all = await mockListExtensions();
		return (all as any[]).find((e) => e.name === ref) ?? null;
	}),
	updateExtension: mockUpdateExtension,
	resetFailures: mockResetFailures,
	listExtensions: mockListExtensions,
	deleteExtension: mockDeleteExtension,
	createExtension: mock(async (d: any) => d),
	getExtensionByName: mock(async () => null),
	incrementFailures: mock(async () => 0),
	// Faithful double of the real redaction: blanks MCP transport-secret
	// VALUES (headers/env) while keeping the KEY set, non-MCP passes through.
	// The real impl is unit-tested against PGlite in
	// src/__tests__/mcp-secrets-query.test.ts.
	redactExtensionSecrets: (ext: any) => {
		const m = ext?.manifest;
		if (!m || m.kind !== "mcp" || !m.mcpServers?.length) return ext;
		const blank = (map: any) =>
			Object.fromEntries(Object.keys(map ?? {}).map((k) => [k, ""]));
		return {
			...ext,
			manifest: {
				...m,
				mcpServers: m.mcpServers.map((s: any) =>
					s.transport === "stdio"
						? s.env && Object.keys(s.env).length
							? { ...s, env: blank(s.env) }
							: s
						: s.headers && Object.keys(s.headers).length
							? { ...s, headers: blank(s.headers) }
							: s,
				),
			},
		};
	},
}));

// ── Installer mocks ──────────────────────────────────────────────────────
const installedRecord = (overrides: Partial<any> = {}) => ({
	...extensionFixture,
	enabled: false,
	grantedPermissions: { grantedAt: {} },
	...overrides,
});

const mockInstallFromLocal = mock(async (_path: string, _perms: any, _enabled: boolean) =>
	installedRecord({ origin: "local", installPath: _path }),
);
const mockInstallFromGitHub = mock(async (_repo: string, _perms: any, _enabled: boolean) =>
	installedRecord({ origin: "github", sourceUrl: _repo }),
);
const mockInstallFromGit = mock(async (_src: string, _perms: any, _opts: any) =>
	installedRecord({ origin: "git", sourceUrl: _src }),
);

// Real allowlist contents — kept here as the single in-test source of
// truth so the installer mock and the assertions stay in lockstep.
const AUTO_ENABLE_NAMES = [
	"task-stack",
	"property-intelligence-agent",
	"substack-pipeline",
	"excel",
	"substack-pilot",
];
const autoEnableSet = new Set(AUTO_ENABLE_NAMES);

/**
 * Stand-in for the real uninstall, faithful in the two effects the DELETE
 * tests below assert on: the row goes, and the registry reloads. Stubbed
 * rather than real because the real one deletes DIRECTORIES, and its own
 * containment rules are covered where they belong
 * (`src/__tests__/installer-coverage.test.ts`).
 */
const mockUninstallExtension = mock(
	async (ext: { id: string }, opts?: { purgeData?: boolean }) => {
		await mockDeleteExtension(ext.id);
		await mockReload();
		return { installPathRemoved: true, dataRemoved: opts?.purgeData === true };
	},
);

mock.module("$server/extensions/installer", () => ({
	installFromLocal: mockInstallFromLocal,
	installFromGitHub: mockInstallFromGitHub,
	installFromGit: mockInstallFromGit,
	uninstallExtension: mockUninstallExtension,
	AUTO_ENABLE_ON_INSTALL: autoEnableSet,
	shouldAutoEnableOnInstall: (name: string) => autoEnableSet.has(name),
}));

// Logger mock — the Library route logs a non-fatal warning when
// auto-enable fails; keep it a no-op so test output stays clean.
const mockLogWarn = mock((..._a: unknown[]) => {});
mock.module("$server/logger", () => ({
	logger: { child: () => ({ warn: mockLogWarn, info: () => {}, error: () => {} }) },
	// Transitive imports (secrets-store, github-projects-handler) pull
	// extensionLogger from the same module — the mock must export it too,
	// or every import of $server/logger fails with a missing-export error.
	extensionLogger: () => ({ warn: mockLogWarn, info: () => {}, error: () => {}, debug: () => {} }),
}));

// ── Registry mock (reload is a no-op in tests) ───────────────────────────
const mockReload = mock(async () => {});
const mockKillAll = mock(() => {});
mock.module("$server/extensions/registry", () => ({
	ExtensionRegistry: {
		getInstance: () => ({ reload: mockReload, killAll: mockKillAll }),
	},
}));

// ── Security check mock ──────────────────────────────────────────────────
const mockHasSecurityViolation = mock(async (_id: string) => false);
mock.module("$server/extensions/security", () => ({
	hasSecurityViolation: mockHasSecurityViolation,
}));

// ── Audit log mock ───────────────────────────────────────────────────────
const mockInsertAuditEntry = mock(async (..._args: unknown[]) => ({}));
mock.module("$server/db/queries/audit-log", () => ({
	insertAuditEntry: mockInsertAuditEntry,
}));

// ── cache-utils passthrough (GET uses it, not under test but static-imported)
mock.module("$server/lib/cache-utils", () => ({
	cacheableResponse: (_req: Request, data: unknown, _opts: unknown) =>
		new Response(JSON.stringify(data), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
}));

let legacy = false;
const lifecycleUninstall = mock(async () => {});
const lifecycleDisable = mock(async () => { extensionStore = { ...extensionStore, enabled: false, disabledByUser: true }; });
mock.module("$server/extensions/extension-lifecycle-service", () => ({
  getExtensionLifecycle: async () => ({
    inspect: async () => {
      if (!extensionStore || legacy) {
        const { LifecycleError } = await import("../../../src/extensions/v4/types");
        throw new LifecycleError("not_found", "Installation not found");
      }
      return {};
    },
    disable: lifecycleDisable,
    uninstall: lifecycleUninstall,
  }),
}));
beforeEach(() => { legacy = false; lifecycleUninstall.mockClear(); lifecycleDisable.mockClear(); });

// ── Import handlers AFTER mocks ──────────────────────────────────────────
const { POST: installPOST, GET: listGET } = await import("../routes/api/extensions/+server");
const { POST: activatePOST } = await import("../routes/api/extensions/[id]/activate/+server");
const {
	PATCH: extPATCH,
	GET: extGET,
	DELETE: extDELETE,
} = await import("../routes/api/extensions/[id]/+server");
const { activateExtension } = await import(
	"../lib/server/extensions/activate-extension"
);

// ── Request helpers ──────────────────────────────────────────────────────
function installReq(body: unknown) {
	return {
		request: new Request("http://localhost/api/extensions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user: authUser, apiKeyScopes },
	} as any;
}

function activateReq(id: string, body?: unknown) {
	return {
		request: new Request(`http://localhost/api/extensions/${id}/activate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: body === undefined ? "" : JSON.stringify(body),
		}),
		params: { id },
		locals: { user: authUser, apiKeyScopes },
	} as any;
}

function patchReq(id: string, body: unknown) {
	return {
		request: new Request(`http://localhost/api/extensions/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		params: { id },
		locals: { user: authUser, apiKeyScopes },
	} as any;
}

function listReq(query = "") {
	const href = `http://localhost/api/extensions${query}`;
	return {
		request: new Request(href, { method: "GET" }),
		url: new URL(href),
		locals: { user: authUser, apiKeyScopes },
	} as any;
}

function detailReq(id: string) {
	return {
		request: new Request(`http://localhost/api/extensions/${id}`, { method: "GET" }),
		params: { id },
		locals: { user: authUser, apiKeyScopes },
	} as any;
}

/**
 * `url` is part of the real SvelteKit event and the DELETE handler reads it
 * for `?purgeData=1` — the opt-in that also deletes the extension's stored
 * data. `query` lets a test drive that branch.
 */
function deleteReq(id: string, query = "") {
	const href = `http://localhost/api/extensions/${id}${query}`;
	return {
		request: new Request(href, { method: "DELETE" }),
		url: new URL(href),
		params: { id },
		locals: { user: authUser, apiKeyScopes },
	} as any;
}

// runThrowable — activate/PATCH/POST handlers let requireAuth/requireRole
// throw a Response (non-2xx). Tests convert the throw into a normal value so
// `expect(res.status).toBe(...)` works uniformly.
async function runThrowable<T extends { status: number }>(
	fn: () => T | Promise<T>,
): Promise<Response | T> {
	try {
		return await fn();
	} catch (e) {
		if (e instanceof Response) return e;
		throw e;
	}
}

// ── Tests ────────────────────────────────────────────────────────────────
beforeEach(() => {
  authUser = { id: "admin-1", email: "admin@test.com", name: "Admin", role: "admin" };
  apiKeyScopes = undefined;
  extensionStore = { ...extensionFixture };
  mockUpdateExtension.mockClear();
  mockDeleteExtension.mockClear();
  mockReload.mockClear();
  mockInstallFromLocal.mockClear();
  mockInstallFromGitHub.mockClear();
  mockInstallFromGit.mockClear();
  mockInsertAuditEntry.mockClear();
});

describe("retired install and activation routes cannot grant authority", () => {
  const inputs = [
    { source: "local", path: "/tmp/ext" },
    { source: "github", repo: "owner/repo" },
    { source: "git", url: "https://evil.test/repo" },
    { source: "unknown" }, { source: "github" },
    { grantedPermissions: { network: ["evil.com", "api.example.com.evil.com"], shell: true } },
    { grantedPermissions: { filesystem: ["/*"], env: ["SECRET"], storage: true, grantedAt: { storage: 1 } } },
    { grantedPermissions: { storage: false, grantedAt: { shell: {} } } },
    {},
  ];
  for (const [label, handler] of [
    ["install", (body: unknown) => installPOST(installReq(body))],
    ["activate", (body: unknown) => activatePOST(activateReq("ext-1", body))],
  ] as const) {
    test.each(inputs)(label + " rejects legacy input %j without side effects", async (input) => {
      const response = await handler(input);
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ code: "extension_v4_required", controlUrl: "/api/extensions/control", openUrl: "/extensions/author" });
      expect(mockInstallFromLocal).not.toHaveBeenCalled();
      expect(mockInstallFromGitHub).not.toHaveBeenCalled();
      expect(mockInstallFromGit).not.toHaveBeenCalled();
      expect(mockUpdateExtension).not.toHaveBeenCalled();
      expect(mockInsertAuditEntry).not.toHaveBeenCalled();
      expect(mockReload).not.toHaveBeenCalled();
    });
    test(label + " still requires authentication and extensions scope", async () => {
      authUser = null;
      expect((await runThrowable(() => handler({}))).status).toBe(401);
      authUser = { id: "user", email: "user@test.com", name: "User", role: "member" };
      apiKeyScopes = ["read", "write"];
      expect((await runThrowable(() => handler({}))).status).toBe(403);
      apiKeyScopes = ["extensions"];
      expect((await handler({})).status).toBe(410);
      expect(mockUpdateExtension).not.toHaveBeenCalled();
    });
  }
  test.each(AUTO_ENABLE_NAMES)("%s cannot auto-enable through a retired endpoint", async (name) => {
    extensionStore = { ...extensionFixture, name };
    const response = await installPOST(installReq({ source: "local", path: "/tmp/" + name }));
    expect(response.status).toBe(410);
    expect(extensionStore.enabled).toBe(false);
    expect(mockUpdateExtension).not.toHaveBeenCalled();
  });
  test("direct activation helper refuses all authority changes", async () => {
    for (const input of inputs) {
      expect(await activateExtension("ext-1", input, "admin-1")).toMatchObject({ ok: false, status: 410 });
      expect(mockUpdateExtension).not.toHaveBeenCalled();
    }
  });
});

describe("PATCH /api/extensions/:id", () => {
	beforeEach(() => {
		authUser = { id: "admin-1", email: "admin@test.com", name: "Admin", role: "admin" };
		apiKeyScopes = undefined;
		extensionStore = { ...extensionFixture, enabled: true };
		mockGetExtension.mockClear();
		mockUpdateExtension.mockClear();
		mockReload.mockClear();
	});

	test("direct enable is retired and points at release control", async () => {
		const res = await (extPATCH(patchReq("ext-1", { enabled: true })) as any);
		expect(res.status).toBe(410);
		const body = await res.json();
		expect(body.controlUrl).toBe("/api/extensions/control");
	});

	test("{enabled:false} → 200, disabled AND recorded as the user's choice", async () => {
		const res = await (extPATCH(patchReq("ext-1", { enabled: false })) as any);
		expect(res.status).toBe(200);
		expect(lifecycleDisable).toHaveBeenCalledWith({ principalId: "admin-1", scope: "global", kind: "agent" }, "ext-1");
    expect(extensionStore).toMatchObject({ enabled: false, disabledByUser: true });
	});

	test("API key lacking 'extensions' scope → 403", async () => {
		authUser = { id: "api-user", email: "api@test.com", name: "API", role: "member" };
		apiKeyScopes = ["read"];
		const res = await runThrowable(() => extPATCH(patchReq("ext-1", { enabled: false })) as any);
		expect(res.status).toBe(403);
	});

	test("non-admin cookie user CANNOT disable an extension → 403 (was a back-door)", async () => {
		authUser = { id: "u2", email: "u2@test.com", name: "U2", role: "member" };
		apiKeyScopes = undefined;
		const res = await runThrowable(() => extPATCH(patchReq("ext-1", { enabled: false })) as any);
		expect(res.status).toBe(403);
		expect(mockUpdateExtension).not.toHaveBeenCalled();
	});
});

describe("GET /api/extensions", () => {
	beforeEach(() => {
		authUser = { id: "admin-1", email: "admin@test.com", name: "Admin", role: "admin" };
		apiKeyScopes = undefined;
		extensionStore = { ...extensionFixture };
		mockListExtensions.mockClear();
	});

	test("admin → 200 with list", async () => {
		const res = await (listGET(listReq()) as any);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body)).toBe(true);
		expect(body).toHaveLength(1);
		expect(body[0].id).toBe("ext-1");
		expect(mockListExtensions).toHaveBeenCalledTimes(1);
	});

	test("empty list → 200 []", async () => {
		extensionStore = null;
		const res = await (listGET(listReq()) as any);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual([]);
	});

	test("MCP transport secrets are stripped from the payload", async () => {
		// A legacy row whose manifest still carries a plaintext bearer token —
		// the GET handler must redact it so a read-scope member cannot exfiltrate.
		extensionStore = {
			...extensionFixture,
			id: "mcp-ext",
			name: "mcp-ext",
			manifest: {
				kind: "mcp",
				name: "mcp-ext",
				mcpServers: [
					{
						transport: "http",
						name: "mcp-ext",
						url: "https://x.example/mcp",
						headers: { Authorization: "Bearer LEAKME" },
					},
				],
				tools: [],
				permissions: {},
			},
		};
		const res = await (listGET(listReq()) as any);
		expect(res.status).toBe(200);
		const raw = JSON.stringify(await res.json());
		expect(raw).not.toContain("LEAKME");
		const body = JSON.parse(raw);
		// Key survives (edit UI shows which headers exist); value is blanked.
		expect(body[0].manifest.mcpServers[0].headers).toEqual({ Authorization: "" });
	});

	test("member (cookie) → 200 — handler has requireAuth but no role gate", async () => {
		// Documents current behavior: GET /api/extensions is not admin-gated. If
		// the audit recommends adding requireRole("admin"), update this test to
		// expect 403.
		authUser = { id: "u2", email: "u2@test.com", name: "U2", role: "member" };
		const res = await runThrowable(() => listGET(listReq()) as any);
		expect(res.status).toBe(200);
	});

	test("unauthenticated → 401", async () => {
		authUser = null;
		const res = await runThrowable(() => listGET(listReq()) as any);
		expect(res.status).toBe(401);
	});

	test("API key without 'read' scope → 403", async () => {
		authUser = { id: "api-user", email: "api@test.com", name: "API", role: "member" };
		apiKeyScopes = ["extensions"];
		const res = await runThrowable(() => listGET(listReq()) as any);
		expect(res.status).toBe(403);
	});
});

describe("GET /api/extensions/:id", () => {
	beforeEach(() => {
		authUser = { id: "admin-1", email: "admin@test.com", name: "Admin", role: "admin" };
		apiKeyScopes = undefined;
		extensionStore = { ...extensionFixture };
		mockGetExtension.mockClear();
	});

	test("admin → 200 with extension fields", async () => {
		const res = await (extGET(detailReq("ext-1")) as any);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.id).toBe("ext-1");
		expect(body.name).toBe("sample-ext");
		expect(body.manifest).toBeDefined();
		expect(body.grantedPermissions).toBeDefined();
		expect(body.enabled).toBe(false);
		expect(mockGetExtension).toHaveBeenCalledWith("ext-1");
	});

	test("unknown id → 404", async () => {
		extensionStore = null;
		const res = await (extGET(detailReq("missing")) as any);
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toBe("Not found");
	});

	test("unauthenticated → 401", async () => {
		authUser = null;
		const res = await runThrowable(() => extGET(detailReq("ext-1")) as any);
		expect(res.status).toBe(401);
	});

	test("API key without 'read' scope → 403", async () => {
		authUser = { id: "api-user", email: "api@test.com", name: "API", role: "member" };
		apiKeyScopes = ["extensions"];
		const res = await runThrowable(() => extGET(detailReq("ext-1")) as any);
		expect(res.status).toBe(403);
	});
});

describe("DELETE /api/extensions/:id", () => {
  test("uninstall uses the scoped lifecycle and retains stored data", async () => {
    const response = await extDELETE(deleteReq("ext-1"));
    expect(response.status).toBe(204);
    expect(lifecycleUninstall).toHaveBeenCalledWith({ principalId: "admin-1", scope: "global", kind: "agent" }, "ext-1");
    expect(mockDeleteExtension).not.toHaveBeenCalled();
    expect(mockKillAll).not.toHaveBeenCalled();
  });
  test("purge requires a separate retention review", async () => {
    const response = await extDELETE(deleteReq("ext-1", "?purgeData=1"));
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error");
    expect(lifecycleUninstall).not.toHaveBeenCalled();
  });
  test("missing installation is 404", async () => {
    extensionStore = null;
    expect((await extDELETE(deleteReq("missing"))).status).toBe(404);
    expect(lifecycleUninstall).not.toHaveBeenCalled();
  });
  test("legacy projection cannot bypass migration", async () => {
    legacy = true;
    expect((await extDELETE(deleteReq("ext-1"))).status).toBe(410);
    expect(lifecycleUninstall).not.toHaveBeenCalled();
  });
  test("uninstall checks both role and API key scope", async () => {
    authUser = null;
    expect((await extDELETE(deleteReq("ext-1"))).status).toBe(401);
    authUser = { id: "member", email: "member@test.com", name: "Member", role: "member" };
    expect((await extDELETE(deleteReq("ext-1"))).status).toBe(403);
    authUser.role = "admin"; apiKeyScopes = ["extensions"];
    expect((await extDELETE(deleteReq("ext-1"))).status).toBe(403);
    apiKeyScopes = ["admin"];
    expect((await extDELETE(deleteReq("ext-1"))).status).toBe(403);
    expect(lifecycleUninstall).not.toHaveBeenCalled();
  });
});
