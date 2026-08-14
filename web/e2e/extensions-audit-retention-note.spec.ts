/**
 * #206 — the Audit Trail panel has to be true about two new facts.
 *
 * The PDP now FOLDS a burst of identical decisions into one row carrying the
 * count and the first/last times, and `audit_log` finally has a retention
 * sweep (180 days by default, `EZCORP_AUDIT_RETENTION_DAYS`). Both change
 * what an admin should conclude from this panel:
 *
 *   - a folded row is one row standing for many, so reading "one refusal"
 *     off a row that says 100 is exactly the wrong conclusion;
 *   - rows no longer live forever, so an absent row is no longer proof that
 *     nothing happened.
 *
 * A copy claim is only worth anything next to the rows it describes, so this
 * spec renders a real folded deny row beside the note and screenshots the
 * pair. The row shape is the one `permission-engine.ts` writes: action
 * `ext:perm:denied`, `reason` opening with the `coalesced-deny-tail` marker,
 * and `suppressed` / `totalInWindow` / `firstAt` / `lastAt` in metadata.
 */
import { test, expect } from "./fixtures/test-base.js";
import { captureEvidence } from "./fixtures/evidence.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });
const EXT_ID = "weather-mcp-206";

/** The e2e mock's `/api/auth/me` identity — see `fixtures/api-mocks.ts`. */
const ADMIN_ID = "e2e-admin";

const MCP_EXT = {
	id: EXT_ID,
	name: "weather-mcp",
	version: "1.0.0",
	description: "Weather tools over MCP",
	enabled: true,
	source: "mcp:stdio",
	installPath: null,
	checksumVerified: false,
	consecutiveFailures: 0,
	isBundled: false,
	creatorUserId: ADMIN_ID,
	manifest: {
		author: "local",
		entrypoint: "",
		kind: "mcp",
		mcpServers: [{ transport: "stdio", name: "weather", command: "npx", args: ["weather"] }],
		tools: [{ name: "forecast", description: "Get forecast", inputSchema: {} }],
		permissions: {},
	},
	grantedPermissions: { grantedAt: {} },
	installedPermissions: {},
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

const DENY_REASON =
	"missing capability network:api.weather.test for tool weather-mcp__forecast";

/**
 * A revoked grant refusing every call in a loop: the verbatim head row, then
 * the folded tail that accounts for the other 250.
 */
const AUDIT_ENTRIES = [
	{
		id: "d-tail",
		userId: ADMIN_ID,
		action: "ext:perm:denied",
		target: EXT_ID,
		metadata: {
			auditId: "audit-tail-1",
			toolName: "weather-mcp__forecast",
			capabilityKind: "network",
			capabilityValue: "api.weather.test",
			reason: `coalesced-deny-tail (250 suppressed in 10000ms) — ${DENY_REASON}`,
			conversationId: "conv-206",
			suppressed: 250,
			totalInWindow: 251,
			firstAt: "2026-08-14T09:00:00.000Z",
			lastAt: "2026-08-14T09:00:09.400Z",
			headAuditId: "audit-head-1",
		},
		createdAt: new Date(Date.now() - 60_000).toISOString(),
	},
	{
		id: "d-head",
		userId: ADMIN_ID,
		action: "ext:perm:denied",
		target: EXT_ID,
		metadata: {
			auditId: "audit-head-1",
			toolName: "weather-mcp__forecast",
			capabilityKind: "network",
			capabilityValue: "api.weather.test",
			reason: DENY_REASON,
			conversationId: "conv-206",
		},
		createdAt: new Date(Date.now() - 70_000).toISOString(),
	},
	{
		id: "m-install",
		userId: ADMIN_ID,
		action: "ext:mcp:server-installed",
		target: EXT_ID,
		metadata: {
			permission: "network",
			actor: ADMIN_ID,
			reason: "mcp-install",
			extensionName: "weather-mcp",
			oldValue: null,
			newValue: { transport: "stdio", target: "npx", argCount: 1, toolCount: 1 },
		},
		createdAt: new Date(Date.now() - 180_000).toISOString(),
	},
];

/** One handler for the detail GET + every subroute the page fans out to. */
function extRoutes(entries: unknown[]) {
	return {
		[`/api/extensions/${EXT_ID}`]: (url: URL) => {
			const p = url.pathname;
			if (p === `/api/extensions/${EXT_ID}`) return MCP_EXT;
			if (p.endsWith("/audit")) return { entries };
			if (p.endsWith("/settings")) return { schema: {}, userValues: {} };
			if (p.endsWith("/expired-grants")) return { grants: [] };
			if (p.endsWith("/violations")) return [];
			if (p.endsWith("/permissions")) return MCP_EXT.grantedPermissions;
			return {};
		},
	};
}

test.describe("Extensions detail — audit trail folding + retention note", () => {
	test("@evidence the panel explains folding and the retention window, next to a folded row", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({
			projects: [proj],
			extensions: [MCP_EXT],
			routes: extRoutes(AUDIT_ENTRIES),
		});

		await page.goto(`/extensions/${EXT_ID}`);

		const trail = page
			.locator("div", { has: page.getByRole("heading", { name: "Audit Trail" }) })
			.last();
		await expect(trail).toBeVisible();

		// The note itself. Both halves matter: a folded row stands for many
		// (so the count is on the row), and rows are swept.
		const note = trail.getByTestId("audit-trail-retention-note");
		await expect(note).toBeVisible();
		await expect(note).toContainText("folded into one row that carries the count");
		await expect(note).toContainText("180 days by default");

		// The pre-existing sentence is intact — #204's copy fix is not
		// regressed by appending to it.
		await expect(trail).toContainText("MCP server lifecycle");

		// And the row the note describes is on screen, with its count. Before
		// this change a PDP row rendered as the bare slug `perm denied` — no
		// capability, no tool, and nothing saying it stood for 251 refusals.
		await expect(trail).toContainText(
			"Denied network:api.weather.test — weather-mcp__forecast · 251 decisions folded into this row",
		);
		// The verbatim head of the same burst renders too, without a count.
		const rows = trail.locator("li");
		await expect(rows.filter({ hasText: "Denied network:api.weather.test" })).toHaveCount(2);
		await expect(trail).not.toContainText("perm denied");
		// The empty state must be gone, or "no rows" would read as a pass
		// against a panel that rendered nothing.
		await expect(trail).not.toContainText("No audit entries yet");

		// The default capture is a VIEWPORT shot and this panel sits well
		// below the fold — without framing it the attachment is the top of
		// the page, which shows none of what this test is named after.
		await trail.scrollIntoViewIfNeeded();
		await captureEvidence(page, testInfo, "audit-trail-folding-and-retention-note");
	});

	test("a member never sees the panel, note included", async ({ page, mockApi }) => {
		// The rows name refused capabilities and hostnames, so the whole panel
		// — including the note — is admin-only. The page gates on
		// /api/auth/me.
		await mockApi({
			projects: [proj],
			extensions: [MCP_EXT],
			routes: {
				...extRoutes(AUDIT_ENTRIES),
				"/api/auth/me": () => ({
					user: { id: "member-1", email: "m@x.test", name: "Member", role: "member" },
				}),
			},
		});

		await page.goto(`/extensions/${EXT_ID}`);
		// The page itself rendered, so this is a real negative.
		await expect(page.getByText("weather-mcp").first()).toBeVisible();

		await expect(page.getByRole("heading", { name: "Audit Trail" })).toHaveCount(0);
		await expect(page.getByTestId("audit-trail-retention-note")).toHaveCount(0);
	});
});
