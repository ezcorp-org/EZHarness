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
	updateExtension: mockUpdateExtension,
	resetFailures: mockResetFailures,
	listExtensions: mockListExtensions,
	deleteExtension: mockDeleteExtension,
	createExtension: mock(async (d: any) => d),
	getExtensionByName: mock(async () => null),
	incrementFailures: mock(async () => 0),
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

mock.module("$server/extensions/installer", () => ({
	installFromLocal: mockInstallFromLocal,
	installFromGitHub: mockInstallFromGitHub,
	installFromGit: mockInstallFromGit,
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

function deleteReq(id: string) {
	return {
		request: new Request(`http://localhost/api/extensions/${id}`, { method: "DELETE" }),
		params: { id },
		locals: { user: authUser, apiKeyScopes },
	} as any;
}

// runThrowable — activate/PATCH/POST handlers let requireAuth/requireRole
// throw a Response (non-2xx). Tests convert the throw into a normal value so
// `expect(res.status).toBe(...)` works uniformly.
async function runThrowable<T extends { status: number }>(
	fn: () => Promise<T>,
): Promise<Response | T> {
	try {
		return await fn();
	} catch (e) {
		if (e instanceof Response) return e;
		throw e;
	}
}

// ── Tests ────────────────────────────────────────────────────────────────
describe("POST /api/extensions", () => {
	beforeEach(() => {
		authUser = { id: "admin-1", email: "admin@test.com", name: "Admin", role: "admin" };
		apiKeyScopes = undefined;
		mockInstallFromLocal.mockClear();
		mockInstallFromGitHub.mockClear();
		mockInstallFromGit.mockClear();
		mockInsertAuditEntry.mockClear();
		mockReload.mockClear();
	});

	test("non-admin cookie user → 403", async () => {
		authUser = { id: "u2", email: "u2@test.com", name: "U2", role: "member" };
		const res = await runThrowable(() =>
			installPOST(installReq({ source: "local", path: "/tmp/ext" })) as any,
		);
		expect(res.status).toBe(403);
	});

	test("admin + source:local → 201 with enabled:false + empty perms", async () => {
		const res = await (installPOST(installReq({ source: "local", path: "/tmp/ext" })) as any);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.enabled).toBe(false);
		expect(body.grantedPermissions).toEqual({ grantedAt: {} });
		expect(mockInstallFromLocal).toHaveBeenCalledTimes(1);
	});

	test("admin + source:github → 201; sec-C3 regression: caller permissions ignored", async () => {
		const res = await (installPOST(
			installReq({ source: "github", repo: "foo/bar", permissions: { shell: true } }),
		) as any);
		expect(res.status).toBe(201);
		// Installer was handed an empty perms bag regardless of caller input.
		const call = mockInstallFromGitHub.mock.calls[0] as any[];
		const permsArg = call[1];
		expect(permsArg).toEqual({ grantedAt: {} });
		expect(permsArg.shell).toBeUndefined();
	});

	test("admin + source:git + url → 201", async () => {
		const res = await (installPOST(
			installReq({ source: "git", url: "https://example.com/repo.git" }),
		) as any);
		expect(res.status).toBe(201);
		expect(mockInstallFromGit).toHaveBeenCalledTimes(1);
	});

	test("unknown source → 400", async () => {
		const res = await (installPOST(installReq({ source: "svn", path: "/x" })) as any);
		expect(res.status).toBe(400);
	});

	test("missing required field (github without repo) → 400", async () => {
		const res = await (installPOST(installReq({ source: "github" })) as any);
		expect(res.status).toBe(400);
	});

	test("sec-C3 regression: API key with read+write scope but role:member → 403", async () => {
		authUser = { id: "api-user", email: "api@test.com", name: "API", role: "member" };
		apiKeyScopes = ["read", "extensions"];
		const res = await runThrowable(() =>
			installPOST(installReq({ source: "local", path: "/tmp/ext" })) as any,
		);
		expect(res.status).toBe(403);
	});

	// Scope-axis regression: an admin-ROLE key also needs the admin SCOPE. A key
	// minted `--scopes read --role admin` clears the role wall but not the scope
	// wall → 403, and no install happens.
	test("scope axis: admin-role key WITHOUT admin scope → 403; no install", async () => {
		apiKeyScopes = ["read"]; // admin ROLE (authUser) but no admin SCOPE
		const res = await runThrowable(() =>
			installPOST(installReq({ source: "local", path: "/tmp/ext" })) as any,
		);
		expect(res.status).toBe(403);
		expect(mockInstallFromLocal).not.toHaveBeenCalled();
	});

	test("scope axis: admin-role key WITH admin scope → 201", async () => {
		apiKeyScopes = ["read", "admin"];
		const res = await (installPOST(installReq({ source: "local", path: "/tmp/ext" })) as any);
		expect(res.status).toBe(201);
		expect(mockInstallFromLocal).toHaveBeenCalledTimes(1);
	});

	test("FR-2: github install throws 'No tarball found' → rewritten to suggest source:git", async () => {
		mockInstallFromGitHub.mockImplementationOnce(async () => {
			throw new Error("No tarball found for release v1.0.0");
		});
		const res = await (installPOST(installReq({ source: "github", repo: "foo/bar" })) as any);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("No tarball found");
		expect(body.error).toMatch(/source:\s*"git"/);
		expect(body.error).toMatch(/clone URL/i);
	});

	test("FR-2: github install throws 'Failed to fetch release' → same rewrite", async () => {
		mockInstallFromGitHub.mockImplementationOnce(async () => {
			throw new Error("Failed to fetch release: 404 Not Found");
		});
		const res = await (installPOST(installReq({ source: "github", repo: "foo/bar" })) as any);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("Failed to fetch release");
		expect(body.error).toMatch(/source:\s*"git"/);
	});

	test("FR-2 regression: unrelated github install error passes through unchanged", async () => {
		mockInstallFromGitHub.mockImplementationOnce(async () => {
			throw new Error("checksum mismatch: manifest hash does not match");
		});
		const res = await (installPOST(installReq({ source: "github", repo: "foo/bar" })) as any);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe("checksum mismatch: manifest hash does not match");
		// Guard: the git-suggestion hint must NOT be appended to unrelated errors.
		expect(body.error).not.toMatch(/source:\s*"git"/);
		expect(body.error).not.toMatch(/clone URL/i);
	});
});

describe("POST /api/extensions/:id/activate", () => {
	beforeEach(() => {
		authUser = { id: "admin-1", email: "admin@test.com", name: "Admin", role: "admin" };
		apiKeyScopes = undefined;
		extensionStore = {
			...extensionFixture,
			manifest: {
				name: "sample-ext",
				version: "1.0.0",
				permissions: { network: ["api.example.com"], shell: false },
			},
			grantedPermissions: { grantedAt: {} },
			enabled: false,
		};
		mockGetExtension.mockClear();
		mockUpdateExtension.mockClear();
		mockResetFailures.mockClear();
		mockReload.mockClear();
		mockInsertAuditEntry.mockClear();
		mockHasSecurityViolation.mockClear();
	});

	test("sec-C4 clamp: evil.com + shell:true dropped, only manifest perms kept", async () => {
		const res = await (activatePOST(
			activateReq("ext-1", {
				grantedPermissions: {
					network: ["api.example.com", "evil.com"],
					shell: true,
				},
			}),
		) as any);
		expect(res.status).toBe(200);
		const call = mockUpdateExtension.mock.calls[0] as any[];
		const patch = call[1];
		expect(patch.enabled).toBe(true);
		expect(patch.grantedPermissions.network).toEqual(["api.example.com"]);
		expect(patch.grantedPermissions.shell).toBeUndefined();
	});

	test("unknown id → 404", async () => {
		extensionStore = null;
		const res = await (activatePOST(activateReq("missing", {})) as any);
		expect(res.status).toBe(404);
	});

	test("non-admin → 403", async () => {
		authUser = { id: "u2", email: "u2@test.com", name: "U2", role: "member" };
		const res = await runThrowable(() => activatePOST(activateReq("ext-1", {})) as any);
		expect(res.status).toBe(403);
	});

	// Scope-axis regression: admin-ROLE key still needs the admin SCOPE.
	test("scope axis: admin-role key WITHOUT admin scope → 403; no activate", async () => {
		apiKeyScopes = ["read"]; // admin ROLE (authUser) but no admin SCOPE
		const res = await runThrowable(() => activatePOST(activateReq("ext-1", {})) as any);
		expect(res.status).toBe(403);
		expect(mockUpdateExtension).not.toHaveBeenCalled();
	});

	test("scope axis: admin-role key WITH admin scope → 200", async () => {
		apiKeyScopes = ["read", "admin"];
		const res = await (activatePOST(activateReq("ext-1", {})) as any);
		expect(res.status).toBe(200);
	});

	test("omitted grantedPermissions → flips enabled without changing perms", async () => {
		extensionStore.grantedPermissions = { grantedAt: {}, network: ["api.example.com"] };
		const res = await (activatePOST(activateReq("ext-1")) as any);
		expect(res.status).toBe(200);
		const call = mockUpdateExtension.mock.calls[0] as any[];
		const patch = call[1];
		expect(patch.enabled).toBe(true);
		expect(patch.grantedPermissions).toBeUndefined();
	});

	test("audit-log entry written with action extension:confirmed", async () => {
		await (activatePOST(
			activateReq("ext-1", {
				grantedPermissions: { network: ["api.example.com"] },
			}),
		) as any);
		expect(mockInsertAuditEntry).toHaveBeenCalled();
		const call = mockInsertAuditEntry.mock.calls[0] as unknown[];
		expect(call[0]).toBe("admin-1"); // actor
		expect(call[1]).toBe("extension:confirmed"); // action
		expect(call[2]).toBe("ext-1"); // target
	});

	test("hasSecurityViolation:true → 403 with violation error, no side effects", async () => {
		mockHasSecurityViolation.mockImplementationOnce(async (_id: string) => true);
		const res = await (activatePOST(
			activateReq("ext-1", { grantedPermissions: { network: ["api.example.com"] } }),
		) as any);
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error).toMatch(/security violations/i);
		// Handler short-circuits: no DB write, no registry reload, no resetFailures.
		expect(mockUpdateExtension).not.toHaveBeenCalled();
		expect(mockResetFailures).not.toHaveBeenCalled();
		expect(mockReload).not.toHaveBeenCalled();
		// Current handler also skips the audit entry on rejection. Captured as
		// a negative assertion so if that changes it surfaces as a test update
		// rather than silently shifting behavior.
		expect(mockInsertAuditEntry).not.toHaveBeenCalled();
	});

	test("unresolvable npmDependencies → 403 with the actionable message, no enable", async () => {
		// The extension declares a third-party npm dep that cannot resolve
		// from its install path — activate must REFUSE with a 4xx (never a
		// 500) and never flip `enabled`, mirroring the violations 403 shape.
		extensionStore = {
			...extensionStore,
			installPath: "/tmp/ext",
			manifest: {
				name: "sample-ext",
				version: "1.0.0",
				permissions: {},
				npmDependencies: { "nonexistent-pkg-xyz": "^1.0.0" },
			},
		};
		const res = await (activatePOST(activateReq("ext-1", {})) as any);
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error).toMatch(/requires npm package\(s\) it cannot resolve/);
		expect(body.error).toContain("nonexistent-pkg-xyz@^1.0.0 (missing)");
		// No enable / reload on refusal.
		expect(mockUpdateExtension).not.toHaveBeenCalled();
		expect(mockReload).not.toHaveBeenCalled();
	});

	test("unknown id short-circuits before hasSecurityViolation is consulted", async () => {
		extensionStore = null;
		const res = await (activatePOST(activateReq("missing", {})) as any);
		expect(res.status).toBe(404);
		// ext-lookup is the first gate — security-violation check comes after.
		expect(mockHasSecurityViolation).not.toHaveBeenCalled();
	});
});

describe("POST /api/extensions/:id/activate — clampToManifest legs", () => {
	// One assertion per leg of clampToManifest (filesystem/env/storage/grantedAt
	// + a regression for the naïve-substring suffix attack). network + shell
	// are already covered by the sec-C4 test above.
	beforeEach(() => {
		authUser = { id: "admin-1", email: "admin@test.com", name: "Admin", role: "admin" };
		apiKeyScopes = undefined;
		mockGetExtension.mockClear();
		mockUpdateExtension.mockClear();
		mockResetFailures.mockClear();
		mockReload.mockClear();
		mockInsertAuditEntry.mockClear();
		mockHasSecurityViolation.mockClear();
	});

	function setManifestPerms(perms: Record<string, unknown>) {
		extensionStore = {
			...extensionFixture,
			manifest: { name: "sample-ext", version: "1.0.0", permissions: perms },
			grantedPermissions: { grantedAt: {} },
			enabled: false,
		};
	}

	test("filesystem: entries outside manifest dropped", async () => {
		setManifestPerms({ filesystem: ["$CWD/data"] });
		const res = await (activatePOST(
			activateReq("ext-1", {
				grantedPermissions: { filesystem: ["$CWD/data", "/etc", "/root"] },
			}),
		) as any);
		expect(res.status).toBe(200);
		const patch = (mockUpdateExtension.mock.calls[0] as any[])[1];
		expect(patch.grantedPermissions.filesystem).toEqual(["$CWD/data"]);
	});

	test("filesystem: all entries outside manifest → filesystem omitted entirely", async () => {
		setManifestPerms({ filesystem: ["$CWD/data"] });
		const res = await (activatePOST(
			activateReq("ext-1", {
				grantedPermissions: { filesystem: ["/etc", "/root"] },
			}),
		) as any);
		expect(res.status).toBe(200);
		const patch = (mockUpdateExtension.mock.calls[0] as any[])[1];
		expect(patch.grantedPermissions.filesystem).toBeUndefined();
	});

	test("env: vars outside manifest dropped", async () => {
		setManifestPerms({ env: ["FOO"] });
		const res = await (activatePOST(
			activateReq("ext-1", {
				grantedPermissions: { env: ["FOO", "SECRET", "AWS_SECRET_ACCESS_KEY"] },
			}),
		) as any);
		expect(res.status).toBe(200);
		const patch = (mockUpdateExtension.mock.calls[0] as any[])[1];
		expect(patch.grantedPermissions.env).toEqual(["FOO"]);
	});

	test("storage: manifest:true + submit:true → granted", async () => {
		setManifestPerms({ storage: true });
		const res = await (activatePOST(
			activateReq("ext-1", { grantedPermissions: { storage: true } }),
		) as any);
		expect(res.status).toBe(200);
		const patch = (mockUpdateExtension.mock.calls[0] as any[])[1];
		expect(patch.grantedPermissions.storage).toBe(true);
	});

	test("storage: manifest omits storage + submit:true → NOT granted", async () => {
		setManifestPerms({ network: ["api.example.com"] });
		const res = await (activatePOST(
			activateReq("ext-1", { grantedPermissions: { storage: true } }),
		) as any);
		expect(res.status).toBe(200);
		const patch = (mockUpdateExtension.mock.calls[0] as any[])[1];
		expect(patch.grantedPermissions.storage).toBeUndefined();
	});

	test("storage: manifest:true + submit:false → NOT granted (only true opts in)", async () => {
		setManifestPerms({ storage: true });
		const res = await (activatePOST(
			activateReq("ext-1", { grantedPermissions: { storage: false } }),
		) as any);
		expect(res.status).toBe(200);
		const patch = (mockUpdateExtension.mock.calls[0] as any[])[1];
		expect(patch.grantedPermissions.storage).toBeUndefined();
	});

	test("grantedAt: numeric values pass through, object values dropped", async () => {
		setManifestPerms({ network: ["api.example.com"] });
		const res = await (activatePOST(
			activateReq("ext-1", {
				grantedPermissions: {
					grantedAt: {
						shell: 12345,
						network: { nested: "oops" } as any,
						filesystem: "not-a-number" as any,
						env: 67890,
					},
				},
			}),
		) as any);
		expect(res.status).toBe(200);
		const patch = (mockUpdateExtension.mock.calls[0] as any[])[1];
		expect(patch.grantedPermissions.grantedAt).toEqual({ shell: 12345, env: 67890 });
	});

	test("suffix attack: 'api.example.com.evil.com' not granted when manifest allows 'api.example.com'", async () => {
		setManifestPerms({ network: ["api.example.com"] });
		const res = await (activatePOST(
			activateReq("ext-1", {
				grantedPermissions: {
					network: ["api.example.com.evil.com", "evilapi.example.com"],
				},
			}),
		) as any);
		expect(res.status).toBe(200);
		const patch = (mockUpdateExtension.mock.calls[0] as any[])[1];
		// Neither crafted host ends up in the allowlist. clamp uses array
		// includes(), not substring matching — this is what prevents an
		// attacker from registering a lookalike FQDN and bypassing the filter.
		expect(patch.grantedPermissions.network).toBeUndefined();
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

	test("#2 regression: {enabled:true} → 400, points at /activate", async () => {
		const res = await (extPATCH(patchReq("ext-1", { enabled: true })) as any);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toMatch(/POST \/:?id?\/activate|activate/i);
	});

	test("{enabled:false} → 200 and extension disabled", async () => {
		const res = await (extPATCH(patchReq("ext-1", { enabled: false })) as any);
		expect(res.status).toBe(200);
		const call = mockUpdateExtension.mock.calls[0] as any[];
		expect(call[1]).toEqual({ enabled: false });
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
	beforeEach(() => {
		authUser = { id: "admin-1", email: "admin@test.com", name: "Admin", role: "admin" };
		apiKeyScopes = undefined;
		extensionStore = { ...extensionFixture };
		mockGetExtension.mockClear();
		mockDeleteExtension.mockClear();
		mockKillAll.mockClear();
		mockReload.mockClear();
	});

	test("admin → 204; killAll + deleteExtension + reload all called", async () => {
		const res = await (extDELETE(deleteReq("ext-1")) as any);
		expect(res.status).toBe(204);
		expect(mockKillAll).toHaveBeenCalledTimes(1);
		expect(mockDeleteExtension).toHaveBeenCalledWith("ext-1");
		expect(mockReload).toHaveBeenCalledTimes(1);
	});

	test("unknown id → 404; no kill/delete/reload side effects", async () => {
		extensionStore = null;
		const res = await (extDELETE(deleteReq("missing")) as any);
		expect(res.status).toBe(404);
		expect(mockKillAll).not.toHaveBeenCalled();
		expect(mockDeleteExtension).not.toHaveBeenCalled();
		expect(mockReload).not.toHaveBeenCalled();
	});

	test("killAll throwing is swallowed; delete still proceeds", async () => {
		mockKillAll.mockImplementationOnce(() => {
			throw new Error("registry unavailable");
		});
		const res = await (extDELETE(deleteReq("ext-1")) as any);
		expect(res.status).toBe(204);
		expect(mockDeleteExtension).toHaveBeenCalledWith("ext-1");
		expect(mockReload).toHaveBeenCalledTimes(1);
	});

	test("unauthenticated → 401", async () => {
		authUser = null;
		const res = await runThrowable(() => extDELETE(deleteReq("ext-1")) as any);
		expect(res.status).toBe(401);
		expect(mockDeleteExtension).not.toHaveBeenCalled();
	});

	test("API key without 'extensions' scope → 403; no side effects", async () => {
		authUser = { id: "api-user", email: "api@test.com", name: "API", role: "member" };
		apiKeyScopes = ["read"];
		const res = await runThrowable(() => extDELETE(deleteReq("ext-1")) as any);
		expect(res.status).toBe(403);
		expect(mockKillAll).not.toHaveBeenCalled();
		expect(mockDeleteExtension).not.toHaveBeenCalled();
	});

	test("non-admin cookie user CANNOT delete an extension → 403; no side effects", async () => {
		authUser = { id: "u2", email: "u2@test.com", name: "U2", role: "member" };
		apiKeyScopes = undefined;
		const res = await runThrowable(() => extDELETE(deleteReq("ext-1")) as any);
		expect(res.status).toBe(403);
		expect(mockKillAll).not.toHaveBeenCalled();
		expect(mockDeleteExtension).not.toHaveBeenCalled();
		expect(mockReload).not.toHaveBeenCalled();
	});
});

describe("POST /api/extensions — auto-enable allowlist", () => {
	beforeEach(() => {
		authUser = { id: "admin-1", email: "admin@test.com", name: "Admin", role: "admin" };
		apiKeyScopes = undefined;
		mockInstallFromLocal.mockClear();
		mockUpdateExtension.mockClear();
		mockResetFailures.mockClear();
		mockReload.mockClear();
		mockInsertAuditEntry.mockClear();
		mockHasSecurityViolation.mockClear();
		mockLogWarn.mockClear();
	});

	test("allow-listed extension → 201 enabled:true with declared manifest perms granted", async () => {
		extensionStore = {
			...extensionFixture,
			name: "excel",
			manifest: {
				name: "excel",
				version: "1.0.0",
				permissions: { network: ["api.example.com"], shell: true, storage: true },
			},
			grantedPermissions: { grantedAt: {} },
			enabled: false,
		};
		const res = await (installPOST(
			installReq({ source: "local", path: "/tmp/excel" }),
		) as any);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.enabled).toBe(true);
		// Full declared manifest perms flow through clampExtensionPermissions
		// (clamped to itself = identity) — including the substack-pilot-style
		// shell + network grant.
		expect(body.grantedPermissions.network).toEqual(["api.example.com"]);
		expect(body.grantedPermissions.shell).toBe(true);
		expect(body.grantedPermissions.storage).toBe(true);
		const patch = (mockUpdateExtension.mock.calls[0] as any[])[1];
		expect(patch.enabled).toBe(true);
		expect(patch.grantedPermissions).toEqual(patch.installedPermissions);
		// Activate path also writes the extension:confirmed audit row.
		expect(
			(mockInsertAuditEntry.mock.calls as any[][]).some(
				(c) => c[1] === "extension:confirmed",
			),
		).toBe(true);
	});

	test("regression: non-allow-listed extension stays disabled (install≠enable invariant)", async () => {
		extensionStore = {
			...extensionFixture,
			name: "sample-ext", // not in AUTO_ENABLE_ON_INSTALL
			grantedPermissions: { grantedAt: {} },
			enabled: false,
		};
		const res = await (installPOST(
			installReq({ source: "local", path: "/tmp/ext" }),
		) as any);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.enabled).toBe(false);
		expect(body.grantedPermissions).toEqual({ grantedAt: {} });
		// Auto-enable skipped entirely — no activate side effects.
		expect(mockUpdateExtension).not.toHaveBeenCalled();
		expect(mockHasSecurityViolation).not.toHaveBeenCalled();
	});

	test("allow-listed but activate fails → still 201, left disabled, warning logged", async () => {
		extensionStore = {
			...extensionFixture,
			name: "substack-pilot",
			manifest: {
				name: "substack-pilot",
				version: "1.0.0",
				permissions: { shell: true },
			},
			grantedPermissions: { grantedAt: {} },
			enabled: false,
		};
		mockHasSecurityViolation.mockImplementationOnce(async () => true);
		const res = await (installPOST(
			installReq({ source: "local", path: "/tmp/substack-pilot" }),
		) as any);
		expect(res.status).toBe(201);
		const body = await res.json();
		// Installer return is preserved (disabled) — non-fatal failure.
		expect(body.enabled).toBe(false);
		expect(mockUpdateExtension).not.toHaveBeenCalled();
		expect(mockLogWarn).toHaveBeenCalledTimes(1);
	});

	test.each(AUTO_ENABLE_NAMES)(
		"%s auto-enables on install",
		async (name) => {
			extensionStore = {
				...extensionFixture,
				name,
				manifest: { name, version: "1.0.0", permissions: { storage: true } },
				grantedPermissions: { grantedAt: {} },
				enabled: false,
			};
			const res = await (installPOST(
				installReq({ source: "local", path: `/tmp/${name}` }),
			) as any);
			expect(res.status).toBe(201);
			expect((await res.json()).enabled).toBe(true);
		},
	);
});

describe("activateExtension service (direct)", () => {
	beforeEach(() => {
		extensionStore = {
			...extensionFixture,
			manifest: {
				name: "sample-ext",
				version: "1.0.0",
				permissions: { network: ["api.example.com"], shell: false },
			},
			grantedPermissions: { grantedAt: {} },
			enabled: false,
		};
		mockGetExtension.mockClear();
		mockUpdateExtension.mockClear();
		mockResetFailures.mockClear();
		mockReload.mockClear();
		mockInsertAuditEntry.mockClear();
		mockHasSecurityViolation.mockClear();
	});

	test("unknown id → {ok:false,404}, no side effects", async () => {
		extensionStore = null;
		const r = await activateExtension("missing", {}, "admin-1");
		expect(r).toEqual({ ok: false, status: 404, message: "Not found" });
		expect(mockHasSecurityViolation).not.toHaveBeenCalled();
		expect(mockUpdateExtension).not.toHaveBeenCalled();
	});

	test("security violation → {ok:false,403}, no DB write / reload / audit", async () => {
		mockHasSecurityViolation.mockImplementationOnce(async () => true);
		const r = await activateExtension(
			"ext-1",
			{ submittedPermissions: { network: ["api.example.com"] } },
			"admin-1",
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.status).toBe(403);
		expect(mockUpdateExtension).not.toHaveBeenCalled();
		expect(mockResetFailures).not.toHaveBeenCalled();
		expect(mockReload).not.toHaveBeenCalled();
		expect(mockInsertAuditEntry).not.toHaveBeenCalled();
	});

	test("submitted perms clamped to manifest + stored as granted & installed", async () => {
		const r = await activateExtension(
			"ext-1",
			{ submittedPermissions: { network: ["api.example.com", "evil.com"], shell: true } },
			"admin-1",
		);
		expect(r.ok).toBe(true);
		const patch = (mockUpdateExtension.mock.calls[0] as any[])[1];
		expect(patch.enabled).toBe(true);
		expect(patch.grantedPermissions.network).toEqual(["api.example.com"]);
		expect(patch.grantedPermissions.shell).toBeUndefined(); // manifest shell:false
		expect(patch.installedPermissions).toEqual(patch.grantedPermissions);
		expect(mockResetFailures).toHaveBeenCalledTimes(1);
		expect(mockReload).toHaveBeenCalledTimes(1);
		const audit = (mockInsertAuditEntry.mock.calls[0] as any[]);
		expect(audit[0]).toBe("admin-1");
		expect(audit[1]).toBe("extension:confirmed");
		expect(audit[2]).toBe("ext-1");
	});

	test("omitted submittedPermissions → only flips enabled, perms untouched", async () => {
		const r = await activateExtension("ext-1", {}, "admin-1");
		expect(r.ok).toBe(true);
		const patch = (mockUpdateExtension.mock.calls[0] as any[])[1];
		expect(patch.enabled).toBe(true);
		expect(patch.grantedPermissions).toBeUndefined();
		expect(patch.installedPermissions).toBeUndefined();
	});
});
