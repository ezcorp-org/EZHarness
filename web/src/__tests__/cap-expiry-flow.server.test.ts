/**
 * Phase 4 (capability-expiry) — E2E-flavored integration test.
 *
 * NOTE on what this test does and does NOT exercise:
 *   This is a TIGHT integration test (vitest + jsdom + vi.mock'd
 *   server modules), not a true browser E2E. Playwright is configured
 *   in the repo (web/playwright.config.ts) but its `webServer` boots
 *   `bun run build && bun run preview`, which is too heavy for the
 *   per-file vitest harness this test runs in. A future Playwright
 *   spec under `web/e2e/` can exercise the same flow end-to-end with
 *   a real browser; the milestone deferred that to follow-up rather
 *   than fork the test infrastructure mid-phase.
 *
 *   This test instead verifies the *server-side flow* the brief calls
 *   out:
 *     - install ext (seeded as a mock)
 *     - sweep wrote an audit row 1 day ago
 *     - banner load fn (`/api/extensions/[id]/expired-grants`) returns it
 *     - banner click POSTs `/api/extensions/[id]/reapprove`
 *     - reapprove handler updates `grantedPermissions.grantedAt[key]`
 *       to ~now AND re-grants from the manifest
 *
 *   The component layer (banner + modal rendering) is covered separately
 *   by `expired-grants-banner.component.test.ts` and
 *   `extension-permission-modal-expired-branch.component.test.ts`.
 */

import {
	describe,
	test,
	expect,
	vi,
	beforeEach,
} from "vitest";

// ── Mocks: shared backend modules ─────────────────────────────────

vi.mock("$server/db/queries/extensions", () => ({
	getExtension: vi.fn(),
	updateExtension: vi.fn(async (_id: string, data: unknown) => ({ id: _id, ...(data as object) })),
}));

vi.mock("$server/db/queries/expired-grants", () => ({
	listExpiredGrantsForExtension: vi.fn(),
}));

vi.mock("$server/db/queries/audit-log", () => ({
	insertAuditEntry: vi.fn(async () => "audit-id-mock"),
}));

vi.mock("$server/extensions/registry", () => ({
	ExtensionRegistry: {
		getInstance: () => ({ reload: vi.fn(async () => undefined) }),
	},
}));

const { getExtension, updateExtension } = await import("$server/db/queries/extensions");
const { listExpiredGrantsForExtension } = await import("$server/db/queries/expired-grants");
const { insertAuditEntry } = await import("$server/db/queries/audit-log");

const expiredGrantsRoute = await import(
	"../routes/api/extensions/[id]/expired-grants/+server.ts"
);
const reapproveRoute = await import(
	"../routes/api/extensions/[id]/reapprove/+server.ts"
);

const DAY_MS = 24 * 60 * 60 * 1000;

const adminUser = { id: "u-admin", email: "a@x", name: "a", role: "admin" } as const;
const memberUser = { id: "u-member", email: "m@x", name: "m", role: "member" } as const;

function makeEvent(opts: {
	id?: string;
	locals?: Record<string, unknown>;
	body?: unknown;
	method?: string;
	path?: string;
}) {
	const id = opts.id ?? "scratchpad";
	const path = opts.path ?? `/api/extensions/${id}/expired-grants`;
	return {
		url: new URL(`http://localhost${path}`),
		locals: opts.locals ?? {},
		params: { id },
		request: new Request(`http://localhost${path}`, {
			method: opts.method ?? "GET",
			headers: { "content-type": "application/json" },
			body: opts.body ? JSON.stringify(opts.body) : undefined,
		}),
	} as any;
}

beforeEach(() => {
	vi.mocked(getExtension).mockReset();
	vi.mocked(updateExtension).mockReset();
	vi.mocked(listExpiredGrantsForExtension).mockReset();
	vi.mocked(insertAuditEntry).mockReset();

	// Default: updateExtension echoes back its input shape.
	vi.mocked(updateExtension).mockImplementation(async (_id: string, data: any) => ({
		id: _id,
		...data,
	}));
	vi.mocked(insertAuditEntry).mockResolvedValue("audit-id-mock");
});

describe("cap-expiry flow — banner load → reapprove → grantedAt resets", () => {
	test("banner load fn returns the audit-row shape the banner consumes", async () => {
		vi.mocked(getExtension).mockResolvedValue({
			id: "scratchpad",
			name: "Scratchpad",
			manifest: {},
		} as any);
		vi.mocked(listExpiredGrantsForExtension).mockResolvedValue([
			{
				auditId: "a-1",
				extensionId: "scratchpad",
				capability: "shell",
				ageMs: 1 * DAY_MS,
				expiredAt: Date.now() - 1 * DAY_MS,
			},
		]);

		const res = await expiredGrantsRoute.GET(
			makeEvent({ locals: { user: memberUser } }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { grants: any[] };
		expect(body.grants).toHaveLength(1);
		expect(body.grants[0]).toMatchObject({
			auditId: "a-1",
			capability: "shell",
			extensionId: "scratchpad",
		});
	});

	test("banner load returns 404 for unknown extension", async () => {
		vi.mocked(getExtension).mockResolvedValue(null as any);
		const res = await expiredGrantsRoute.GET(
			makeEvent({ locals: { user: memberUser } }),
		);
		expect(res.status).toBe(404);
	});

	test("banner load requires authentication", async () => {
		// No `user` in locals — requireAuth throws a 401 Response.
		let res: Response | undefined;
		try {
			res = await expiredGrantsRoute.GET(makeEvent({ locals: {} }));
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(Response);
			res = thrown as Response;
		}
		expect(res!.status).toBe(401);
	});

	test("reapprove resets grantedAt[key] and re-grants manifest value", async () => {
		const ninetyOneDaysAgo = Date.now() - 91 * DAY_MS;
		vi.mocked(getExtension).mockResolvedValue({
			id: "scratchpad",
			name: "Scratchpad",
			manifest: {
				permissions: {
					shell: true,
					filesystem: ["/tmp/scratchpad"],
				},
			},
			grantedPermissions: {
				// shell was swept (key gone, no grantedAt entry)
				filesystem: ["/tmp/scratchpad"],
				grantedAt: {
					filesystem: ninetyOneDaysAgo,
					// shell intentionally absent — that's the swept state.
				},
			},
		} as any);

		const before = Date.now();
		const res = await reapproveRoute.POST(
			makeEvent({
				method: "POST",
				path: "/api/extensions/scratchpad/reapprove",
				locals: { user: memberUser },
				body: { capability: "shell" },
			}),
		);
		const after = Date.now();
		expect(res.status).toBe(200);

		// updateExtension was called with the next granted-permissions
		// snapshot. Verify shell was re-granted from the manifest AND
		// grantedAt[shell] = ~now.
		expect(vi.mocked(updateExtension)).toHaveBeenCalledTimes(1);
		const call = vi.mocked(updateExtension).mock.calls[0]!;
		expect(call[0]).toBe("scratchpad");
		const nextGrant = (call[1] as any).grantedPermissions;
		expect(nextGrant.shell).toBe(true);
		expect(nextGrant.grantedAt.shell).toBeGreaterThanOrEqual(before);
		expect(nextGrant.grantedAt.shell).toBeLessThanOrEqual(after);
		// filesystem (untouched) preserved.
		expect(nextGrant.filesystem).toEqual(["/tmp/scratchpad"]);
		expect(nextGrant.grantedAt.filesystem).toBe(ninetyOneDaysAgo);

		// Audit row written.
		expect(vi.mocked(insertAuditEntry)).toHaveBeenCalled();
	});

	test("reapprove with capability='filesystem-write' re-grants manifest filesystem slot", async () => {
		vi.mocked(getExtension).mockResolvedValue({
			id: "scratchpad",
			name: "Scratchpad",
			manifest: { permissions: { filesystem: ["/var/lib/scratchpad"] } },
			grantedPermissions: { grantedAt: {} },
		} as any);

		const res = await reapproveRoute.POST(
			makeEvent({
				method: "POST",
				path: "/api/extensions/scratchpad/reapprove",
				locals: { user: memberUser },
				body: { capability: "filesystem-write" },
			}),
		);
		expect(res.status).toBe(200);
		const call = vi.mocked(updateExtension).mock.calls[0]!;
		const nextGrant = (call[1] as any).grantedPermissions;
		expect(nextGrant.filesystem).toEqual(["/var/lib/scratchpad"]);
		expect(typeof nextGrant.grantedAt.filesystem).toBe("number");
	});

	test("reapprove rejects scope='forever' from non-admin (defense in depth)", async () => {
		vi.mocked(getExtension).mockResolvedValue({
			id: "scratchpad",
			name: "Scratchpad",
			manifest: { permissions: { shell: true } },
			grantedPermissions: { grantedAt: {} },
		} as any);

		let res: Response | undefined;
		try {
			res = await reapproveRoute.POST(
				makeEvent({
					method: "POST",
					path: "/api/extensions/scratchpad/reapprove",
					locals: { user: memberUser },
					body: { capability: "shell", scope: "forever" },
				}),
			);
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(Response);
			res = thrown as Response;
		}
		expect(res!.status).toBe(403);
		// updateExtension MUST NOT have been called.
		expect(vi.mocked(updateExtension)).not.toHaveBeenCalled();
	});

	test("reapprove with scope='forever' from admin succeeds", async () => {
		vi.mocked(getExtension).mockResolvedValue({
			id: "scratchpad",
			name: "Scratchpad",
			manifest: { permissions: { shell: true } },
			grantedPermissions: { grantedAt: {} },
		} as any);

		const res = await reapproveRoute.POST(
			makeEvent({
				method: "POST",
				path: "/api/extensions/scratchpad/reapprove",
				locals: { user: adminUser },
				body: { capability: "shell", scope: "forever" },
			}),
		);
		expect(res.status).toBe(200);
		expect(vi.mocked(updateExtension)).toHaveBeenCalledTimes(1);
	});

	test("reapprove rejects unknown capability with 400", async () => {
		vi.mocked(getExtension).mockResolvedValue({
			id: "scratchpad",
			name: "Scratchpad",
			manifest: { permissions: {} },
			grantedPermissions: { grantedAt: {} },
		} as any);

		const res = await reapproveRoute.POST(
			makeEvent({
				method: "POST",
				path: "/api/extensions/scratchpad/reapprove",
				locals: { user: memberUser },
				body: { capability: "bogus-capability" },
			}),
		);
		expect(res.status).toBe(400);
		expect(vi.mocked(updateExtension)).not.toHaveBeenCalled();
	});

	test("reapprove rejects invalid scope with 400", async () => {
		// Phase 56 widened the scope vocabulary to accept all four
		// AlwaysAllowScope values (session/conversation/project/forever).
		// To still hit the validator, pass a scope value OUTSIDE that
		// vocabulary — e.g. the literal "bogus".
		vi.mocked(getExtension).mockResolvedValue({
			id: "scratchpad",
			name: "Scratchpad",
			manifest: { permissions: { shell: true } },
			grantedPermissions: { grantedAt: {} },
		} as any);

		const res = await reapproveRoute.POST(
			makeEvent({
				method: "POST",
				path: "/api/extensions/scratchpad/reapprove",
				locals: { user: adminUser },
				body: { capability: "shell", scope: "bogus" },
			}),
		);
		expect(res.status).toBe(400);
		expect(vi.mocked(updateExtension)).not.toHaveBeenCalled();
	});
});

// ── v1.3 security review HIGH 2 — reapprove clamp ─────────────────
//
// Three scenarios, each asserts both the clamped grant value AND the
// `metadata.reason: "user-reapprove"` audit row contract.
//
//   1. Bundled extension whose manifest exceeds BUNDLED_CEILING →
//      reapprove clamps to ceiling, NOT manifest.
//   2. User-installed extension with installedPermissions narrower
//      than manifest → reapprove restores narrowed choice only.
//   3. Legacy row (installedPermissions = NULL) → falls back to
//      manifest clamp (preserves pre-fix behavior).
//
// The bundled scenario uses extension name "github-stats" so
// `isBundledExtensionName` returns true and the bundled-ceiling
// second-stage clamp fires.

describe("v1.3 security review HIGH 2 — reapprove clamps to install-time ceiling", () => {
	test("(1) bundled extension manifest exceeds BUNDLED_CEILING → reapprove clamps to ceiling", async () => {
		// github-stats's BUNDLED_CEILING is `network: ["api.github.com"]`.
		// Simulate a tampered manifest that declares a wider list. Pre-fix,
		// reapprove would write the manifest verbatim — bundled-ceiling
		// bypassed. Post-fix, the second-stage clamp narrows to ceiling.
		vi.mocked(getExtension).mockResolvedValue({
			id: "ext-gh",
			name: "github-stats",
			isBundled: true,
			manifest: {
				permissions: {
					network: ["api.github.com", "api.attacker.com"],
					env: ["GITHUB_TOKEN"],
				},
			},
			// installedPermissions intentionally NOT set — legacy bundled
			// row exercises the second-stage clamp on its own.
			installedPermissions: null,
			grantedPermissions: { grantedAt: {} },
		} as any);

		const res = await reapproveRoute.POST(
			makeEvent({
				method: "POST",
				path: "/api/extensions/ext-gh/reapprove",
				locals: { user: memberUser },
				body: { capability: "network" },
			}),
		);
		expect(res.status).toBe(200);

		expect(vi.mocked(updateExtension)).toHaveBeenCalledTimes(1);
		const call = vi.mocked(updateExtension).mock.calls[0]!;
		const nextGrant = (call[1] as any).grantedPermissions;
		// Clamped to bundled ceiling (api.github.com only) — api.attacker.com
		// from the (tampered) manifest is dropped.
		expect(nextGrant.network).toEqual(["api.github.com"]);
		expect(nextGrant.network).not.toContain("api.attacker.com");

		// Audit row contract — reason marks this as user-reapprove.
		expect(vi.mocked(insertAuditEntry)).toHaveBeenCalled();
		const auditCall = vi.mocked(insertAuditEntry).mock.calls[0]!;
		const auditMeta = auditCall[3] as any;
		expect(auditMeta.reason).toBe("user-reapprove");
	});

	test("(2) user-installed extension w/ installedPermissions narrower than manifest → reapprove restores narrowed", async () => {
		// User originally approved api.foo.com only, even though the
		// manifest requested both. After a sweep, network is gone.
		// Reapprove must restore the narrowed list, NOT the full manifest.
		vi.mocked(getExtension).mockResolvedValue({
			id: "ext-user",
			name: "third-party-fetcher", // NOT bundled
			isBundled: false,
			manifest: {
				permissions: {
					network: ["api.foo.com", "api.bar.com"],
				},
			},
			installedPermissions: {
				network: ["api.foo.com"],
				grantedAt: { network: Date.now() - 30 * DAY_MS },
			},
			grantedPermissions: { grantedAt: {} },
		} as any);

		const res = await reapproveRoute.POST(
			makeEvent({
				method: "POST",
				path: "/api/extensions/ext-user/reapprove",
				locals: { user: memberUser },
				body: { capability: "network" },
			}),
		);
		expect(res.status).toBe(200);

		const call = vi.mocked(updateExtension).mock.calls[0]!;
		const nextGrant = (call[1] as any).grantedPermissions;
		// Narrowed install-time choice survived — api.bar.com (manifest
		// only, never approved) does NOT come back.
		expect(nextGrant.network).toEqual(["api.foo.com"]);
		expect(nextGrant.network).not.toContain("api.bar.com");

		const auditCall = vi.mocked(insertAuditEntry).mock.calls[0]!;
		const auditMeta = auditCall[3] as any;
		expect(auditMeta.reason).toBe("user-reapprove");
	});

	test("(3) legacy row (installedPermissions = NULL) → falls back to manifest clamp", async () => {
		// Pre-fix install rows have no `installedPermissions`. Reapprove
		// falls back to clamping against the manifest — pre-fix
		// behavior is preserved for non-bundled extensions.
		vi.mocked(getExtension).mockResolvedValue({
			id: "ext-legacy",
			name: "legacy-third-party", // NOT bundled
			isBundled: false,
			manifest: {
				permissions: {
					network: ["api.legacy.com"],
				},
			},
			installedPermissions: null, // legacy row
			grantedPermissions: { grantedAt: {} },
		} as any);

		const res = await reapproveRoute.POST(
			makeEvent({
				method: "POST",
				path: "/api/extensions/ext-legacy/reapprove",
				locals: { user: memberUser },
				body: { capability: "network" },
			}),
		);
		expect(res.status).toBe(200);

		const call = vi.mocked(updateExtension).mock.calls[0]!;
		const nextGrant = (call[1] as any).grantedPermissions;
		// Legacy fallback: full manifest restored (pre-fix behavior for
		// non-bundled rows).
		expect(nextGrant.network).toEqual(["api.legacy.com"]);

		const auditCall = vi.mocked(insertAuditEntry).mock.calls[0]!;
		const auditMeta = auditCall[3] as any;
		expect(auditMeta.reason).toBe("user-reapprove");
	});
});

/**
 * POST /api/extensions/[id]/reapprove — gap-filler input-validation tests.
 *
 * The earlier describe block covers the happy path + role gating; this
 * block locks the auth gate, the missing-extension shape, and the two
 * shapes of malformed-body rejection so the asymmetry with the GET
 * sibling endpoint (which already tests 401 + 404) is closed.
 */
describe("POST /api/extensions/[id]/reapprove — input validation", () => {
	test("unauthenticated returns 401 (requireAuth throws Response)", async () => {
		// Deliberately omit getExtension setup — auth must reject BEFORE
		// the handler reaches the DB lookup.
		let res: Response | undefined;
		try {
			res = await reapproveRoute.POST(
				makeEvent({
					method: "POST",
					path: "/api/extensions/scratchpad/reapprove",
					locals: {}, // no `user`
					body: { capability: "shell" },
				}),
			);
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(Response);
			res = thrown as Response;
		}
		expect(res!.status).toBe(401);
		// updateExtension MUST NOT have been called — auth fails first.
		expect(vi.mocked(updateExtension)).not.toHaveBeenCalled();
	});

	test("unknown extension returns 404 (no updateExtension call)", async () => {
		vi.mocked(getExtension).mockResolvedValue(null as any);
		const res = await reapproveRoute.POST(
			makeEvent({
				method: "POST",
				path: "/api/extensions/does-not-exist/reapprove",
				locals: { user: memberUser },
				body: { capability: "shell" },
			}),
		);
		expect(res.status).toBe(404);
		expect(vi.mocked(updateExtension)).not.toHaveBeenCalled();
	});

	test("invalid JSON body returns 400 (handler's request.json() catch)", async () => {
		// Build the event by hand so we can pass a raw, non-JSON body.
		// The shared `makeEvent` helper JSON.stringifies whatever's
		// supplied; this test needs the literal "not-json{" on the wire
		// to trip the try/catch around `request.json()`.
		const event = {
			url: new URL("http://localhost/api/extensions/scratchpad/reapprove"),
			locals: { user: memberUser },
			params: { id: "scratchpad" },
			request: new Request(
				"http://localhost/api/extensions/scratchpad/reapprove",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "not-json{",
				},
			),
		} as any;

		const res = await reapproveRoute.POST(event);
		expect(res.status).toBe(400);
		// The handler short-circuits before reaching the DB; no DB
		// reads, no writes.
		expect(vi.mocked(getExtension)).not.toHaveBeenCalled();
		expect(vi.mocked(updateExtension)).not.toHaveBeenCalled();
	});

	test("missing capability field returns 400", async () => {
		// Body has valid JSON but no `capability` key — the validator
		// at line 92 of +server.ts must reject before the DB lookup.
		const res = await reapproveRoute.POST(
			makeEvent({
				method: "POST",
				path: "/api/extensions/scratchpad/reapprove",
				locals: { user: memberUser },
				body: {}, // <- no capability
			}),
		);
		expect(res.status).toBe(400);
		expect(vi.mocked(getExtension)).not.toHaveBeenCalled();
		expect(vi.mocked(updateExtension)).not.toHaveBeenCalled();
	});

	test("empty-string capability returns 400 (treated as missing)", async () => {
		// `capability: ""` is typeof "string" but `!capability` is true,
		// so the handler's `if (!capability)` branch must fire.
		const res = await reapproveRoute.POST(
			makeEvent({
				method: "POST",
				path: "/api/extensions/scratchpad/reapprove",
				locals: { user: memberUser },
				body: { capability: "" },
			}),
		);
		expect(res.status).toBe(400);
		expect(vi.mocked(getExtension)).not.toHaveBeenCalled();
		expect(vi.mocked(updateExtension)).not.toHaveBeenCalled();
	});
});

// ── Phase 54 SEC-04 — reapprove writes PERMISSION_REAPPROVED, not GRANTED ──
//
// Pre-fix: the reapprove handler wrote `EXT_AUDIT_ACTIONS.PERMISSION_GRANTED`
// with `metadata.reason = "user-reapprove"`. SOC 2 / SIEM dashboards
// could not distinguish a first-time grant from a reapprove without
// parsing the free-form reason field.
//
// Post-fix: the action is `EXT_AUDIT_ACTIONS.PERMISSION_REAPPROVED`
// (= "ext:permission-reapproved"). A first-time grant from
// `/api/extensions/+server.ts:101` keeps the `PERMISSION_GRANTED`
// action — semantically distinct.
describe("Phase 54 SEC-04 — reapprove writes PERMISSION_REAPPROVED action", () => {
	test("audit row uses 'ext:permission-reapproved' action (NOT 'ext:permission-granted')", async () => {
		vi.mocked(getExtension).mockResolvedValue({
			id: "scratchpad",
			name: "Scratchpad",
			manifest: { permissions: { shell: true } },
			grantedPermissions: { grantedAt: {} },
		} as any);

		const res = await reapproveRoute.POST(
			makeEvent({
				method: "POST",
				path: "/api/extensions/scratchpad/reapprove",
				locals: { user: memberUser },
				body: { capability: "shell" },
			}),
		);
		expect(res.status).toBe(200);

		// Audit row uses the new dedicated action constant.
		expect(vi.mocked(insertAuditEntry)).toHaveBeenCalled();
		const auditCall = vi.mocked(insertAuditEntry).mock.calls[0]!;
		expect(auditCall[1]).toBe("ext:permission-reapproved");
	});

	test("no audit row with action='ext:permission-granted' is written for the same reapprove flow", async () => {
		vi.mocked(getExtension).mockResolvedValue({
			id: "scratchpad",
			name: "Scratchpad",
			manifest: { permissions: { shell: true } },
			grantedPermissions: { grantedAt: {} },
		} as any);

		await reapproveRoute.POST(
			makeEvent({
				method: "POST",
				path: "/api/extensions/scratchpad/reapprove",
				locals: { user: memberUser },
				body: { capability: "shell" },
			}),
		);

		const grantedCalls = vi
			.mocked(insertAuditEntry)
			.mock.calls.filter((c) => c[1] === "ext:permission-granted");
		expect(grantedCalls).toHaveLength(0);
	});
});
