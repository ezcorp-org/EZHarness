/**
 * substack-pilot — defineEntity SDK CRUD UI regression.
 *
 * Mirror of `entities-crud.spec.ts`, scoped to the substack-pilot
 * bundled extension's `post-type` declaration. This is the "ported"
 * extension whose pre-port `lib/post-types.ts` (~421 LOC of hand-rolled
 * CRUD) was deleted in commit `5b2109c`; the spec guards that the
 * SDK-generated UI ships the same end-user surface.
 *
 * substack-pilot is a bundled extension (auto-installed after
 * `bfe3be5`) so the page test exercises the same UI an end-user
 * receives on a fresh install. Like the sibling spec we mock the API
 * routes — no real bundled-install boot is required.
 */
import { test, expect } from "./fixtures/test-base.js";
import type { Page } from "@playwright/test";
import { makeProject } from "./fixtures/data.js";

const USER_ME = {
	user: {
		id: "user-substack",
		email: "u@test.local",
		name: "Test User",
		role: "user",
	},
};

const POST_TYPE_DECL = {
	type: "post-type",
	label: "Post Type",
	pluralLabel: "Post Types",
	scope: "user",
	cascadeOnUninstall: false,
	schema: {
		type: "object",
		properties: {
			name: { type: "string", minLength: 1, maxLength: 100 },
			systemPrompt: { type: "string", minLength: 1, maxLength: 100_000 },
			cadence: { type: "string" },
			defaults: {
				type: "object",
				properties: {
					titlePrefix: { type: "string" },
					subtitleTemplate: { type: "string" },
				},
			},
		},
		required: ["name", "systemPrompt"],
		additionalProperties: false,
	},
	preview: "Post type '{name}' ({cadence}):\n{systemPrompt}",
} as const;

function makeSubstackDetail() {
	return {
		id: "ext-substack",
		name: "substack-pilot",
		version: "1.0.0",
		description: "Manage Substack post types …",
		enabled: true,
		source: "bundled",
		installPath: "/bundled/substack-pilot",
		checksumVerified: true,
		consecutiveFailures: 0,
		manifest: {
			schemaVersion: 2,
			name: "substack-pilot",
			author: "EZCorp",
			entrypoint: "./index.ts",
			persistent: false,
			tools: [
				{ name: "summarize_urls", description: "", inputSchema: { type: "object", properties: {} } },
				{
					name: "generate_substack_draft",
					description: "",
					inputSchema: { type: "object", properties: {} },
				},
			],
			permissions: { storage: true, network: ["*"], shell: true },
			entities: [POST_TYPE_DECL],
		},
		grantedPermissions: {
			network: ["*"],
			filesystem: [],
			shell: true,
			env: [],
			grantedAt: { storage: Date.now(), network: Date.now(), shell: Date.now() },
		},
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

async function installPostTypeMock(
	page: Page,
	opts: {
		extId: string;
		initial: Array<{ slug: string; data: Record<string, unknown> }>;
	},
) {
	const rows: Map<string, Record<string, unknown>> = new Map(
		opts.initial.map((r) => [r.slug, r.data]),
	);
	const base = `/api/extensions/${opts.extId}/entities/post-type`;
	const collectionRx = new RegExp(`${base.replace(/\//g, "\\/")}$`);
	const recordRx = new RegExp(`${base.replace(/\//g, "\\/")}\\/([^/]+)$`);

	await page.route(`**${base}**`, async (route) => {
		const method = route.request().method();
		const url = new URL(route.request().url());
		const collectionMatch = collectionRx.test(url.pathname);
		const recordMatch = url.pathname.match(recordRx);

		if (collectionMatch && method === "GET") {
			return route.fulfill({
				json: {
					items: [...rows.entries()].map(([slug, data]) => ({ slug, data })),
				},
			});
		}
		if (collectionMatch && method === "POST") {
			const body = (route.request().postDataJSON() ?? {}) as {
				slug?: string;
				data?: Record<string, unknown>;
			};
			if (!body.slug || !body.data) {
				return route.fulfill({ status: 400, json: { error: "missing slug or data" } });
			}
			if (rows.has(body.slug)) {
				return route.fulfill({ status: 409, json: { error: "duplicate" } });
			}
			rows.set(body.slug, body.data);
			return route.fulfill({
				status: 201,
				json: { slug: body.slug, data: body.data },
			});
		}
		if (recordMatch) {
			const slug = decodeURIComponent(recordMatch[1]!);
			if (method === "PUT") {
				const body = (route.request().postDataJSON() ?? {}) as {
					patch?: Record<string, unknown>;
					data?: Record<string, unknown>;
				};
				const patch = body.patch ?? body.data ?? {};
				const current = rows.get(slug);
				if (!current) return route.fulfill({ status: 404, json: { error: "not found" } });
				const next = { ...current, ...patch };
				rows.set(slug, next);
				return route.fulfill({ json: { slug, data: next } });
			}
			if (method === "DELETE") {
				const had = rows.delete(slug);
				return route.fulfill({ json: { deleted: had } });
			}
		}
		return route.fallback();
	});

	return { state: () => Object.fromEntries(rows) };
}

test.describe("substack-pilot — post-type CRUD UI", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });

	test("renders seeded post types and edits one through the modal", async ({
		page,
		mockApi,
	}) => {
		const detail = makeSubstackDetail();
		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-substack": () => detail,
				"/api/auth/me": () => USER_ME,
			},
		});
		page.on("dialog", (d) => d.accept());

		const ctrl = await installPostTypeMock(page, {
			extId: "ext-substack",
			initial: [
				{
					slug: "weekly",
					data: {
						name: "Weekly Roundup",
						systemPrompt: "You are the weekly roundup writer.",
						cadence: "weekly",
					},
				},
				{
					slug: "monthly",
					data: {
						name: "Monthly Essay",
						systemPrompt: "You are the monthly essayist.",
						cadence: "monthly",
					},
				},
			],
		});

		await page.goto("/extensions/ext-substack");

		await expect(
			page.getByTestId("entity-table-section-post-type"),
		).toBeVisible({ timeout: 5_000 });

		// Two seeded rows render — matches the 3 substack-pilot seeds
		// minus `ad-hoc` to keep the assertion focused on the SDK
		// surface rather than the production seed count.
		await expect(page.getByTestId("entity-row-post-type-weekly")).toBeVisible();
		await expect(page.getByTestId("entity-row-post-type-monthly")).toBeVisible();

		// Create a new post type via the modal.
		await page.getByTestId("entity-create-post-type").click();
		await expect(page.getByTestId("entity-form-modal-post-type")).toBeVisible();
		await page.getByTestId("entity-form-slug").fill("ad-hoc");
		await page.getByTestId("entity-input-name").fill("Ad-hoc Post");
		await page.getByTestId("entity-input-systemPrompt").fill("Free-form.");
		await page.getByTestId("entity-input-cadence").fill("ad-hoc");
		await page.getByTestId("entity-form-submit").click();
		await expect(page.getByTestId("entity-row-post-type-ad-hoc")).toBeVisible({
			timeout: 5_000,
		});

		// Edit the weekly post type's name to confirm round-trip.
		await page.getByTestId("entity-edit-post-type-weekly").click();
		await expect(page.getByTestId("entity-form-modal-post-type")).toBeVisible();
		await page.getByTestId("entity-input-name").fill("Weekly Roundup (v2)");
		await page.getByTestId("entity-form-submit").click();
		await expect(page.getByTestId("entity-form-modal-post-type")).toHaveCount(0, {
			timeout: 5_000,
		});
		expect(
			(ctrl.state().weekly as Record<string, unknown>).name,
		).toBe("Weekly Roundup (v2)");

		// Delete the monthly post type.
		await page.getByTestId("entity-delete-post-type-monthly").click();
		await expect(page.getByTestId("entity-row-post-type-monthly")).toHaveCount(
			0,
			{ timeout: 5_000 },
		);
		expect(ctrl.state().monthly).toBeUndefined();
	});
});
