/**
 * defineEntity SDK — generic CRUD flow on the extension detail page.
 *
 * Drives the auto-generated EntityTable + EntityFormModal against a
 * fixture extension declaration ("note" entity, the same shape used by
 * `src/__tests__/helpers/test-entities-fixture/`). Everything talks to
 * mocked routes — the test never hits a real DB.
 *
 * Covers the spec's Playwright contract (plan §346):
 *   - the detail page renders the entity table for a declared type
 *   - the table shows seeded records on first load
 *   - `+ Create` opens the modal; submitting persists a new record
 *   - `Edit` opens the modal with the existing values; saving persists
 *   - `Delete` confirms then removes the record from the table
 */
import { test, expect } from "./fixtures/test-base.js";
import type { Page } from "@playwright/test";
import { makeProject } from "./fixtures/data.js";

const USER_ME = {
	user: {
		id: "user-1",
		email: "u@test.local",
		name: "Test User",
		role: "user",
	},
};

const NOTE_DECL = {
	type: "note",
	label: "Note",
	pluralLabel: "Notes",
	scope: "user",
	schema: {
		type: "object",
		properties: {
			title: { type: "string", minLength: 1, maxLength: 100 },
			body: { type: "string", minLength: 1, maxLength: 10_000 },
			pinned: { type: "boolean" },
		},
		required: ["title", "body"],
		additionalProperties: false,
	},
	preview: "{title}",
} as const;

function makeFixtureDetail() {
	return {
		id: "ext-notes",
		name: "test-entities-fixture",
		version: "1.0.0",
		description: "Fixture extension for end-to-end entity tests.",
		enabled: true,
		source: "local",
		installPath: "/tmp/test-entities-fixture",
		checksumVerified: true,
		consecutiveFailures: 0,
		manifest: {
			schemaVersion: 2,
			name: "test-entities-fixture",
			author: "EZCorp Tests",
			entrypoint: "./index.ts",
			persistent: false,
			tools: [],
			permissions: { storage: true },
			entities: [NOTE_DECL],
		},
		grantedPermissions: {
			network: [],
			filesystem: [],
			shell: false,
			env: [],
			grantedAt: { storage: Date.now() },
		},
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

/**
 * In-memory mock for the per-entity routes. Mirrors the server's
 * shape: list returns `{items: [{slug, data}]}`, create returns 201
 * with the saved row, update PUT returns 200, delete returns
 * `{deleted: boolean}`.
 */
async function installEntityMock(
	page: Page,
	opts: {
		extId: string;
		type: string;
		initial: Array<{ slug: string; data: Record<string, unknown> }>;
	},
) {
	const rows: Map<string, Record<string, unknown>> = new Map(
		opts.initial.map((r) => [r.slug, r.data]),
	);

	const base = `/api/extensions/${opts.extId}/entities/${opts.type}`;
	const collectionRx = new RegExp(`${base.replace(/\//g, "\\/")}$`);
	const recordRx = new RegExp(`${base.replace(/\//g, "\\/")}\\/([^/]+)$`);

	await page.route(`**${base}**`, async (route) => {
		const method = route.request().method();
		const url = new URL(route.request().url());
		const collectionMatch = collectionRx.test(url.pathname);
		const recordMatch = url.pathname.match(recordRx);

		if (collectionMatch && method === "GET") {
			const items = [...rows.entries()].map(([slug, data]) => ({ slug, data }));
			return route.fulfill({ json: { items } });
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
			if (method === "GET") {
				const data = rows.get(slug);
				if (!data) return route.fulfill({ status: 404, json: { error: "not found" } });
				return route.fulfill({ json: { slug, data } });
			}
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

	return {
		state: () => Object.fromEntries(rows),
	};
}

test.describe("defineEntity SDK — auto-generated CRUD UI", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });

	test("renders seeded records, then create / edit / delete round-trip", async ({
		page,
		mockApi,
	}) => {
		const detail = makeFixtureDetail();
		await mockApi({
			projects: [proj],
			routes: {
				"/api/extensions/ext-notes": () => detail,
				"/api/auth/me": () => USER_ME,
			},
		});

		// Suppress the EntityTable's `confirm()` so Delete proceeds in
		// the headless run without a popup dialog blocking the click.
		page.on("dialog", (d) => d.accept());

		const ctrl = await installEntityMock(page, {
			extId: "ext-notes",
			type: "note",
			initial: [
				{ slug: "first", data: { title: "First Note", body: "body-1", pinned: true } },
				{ slug: "second", data: { title: "Second Note", body: "body-2" } },
			],
		});

		await page.goto("/extensions/ext-notes");

		// Section renders for the `note` declaration.
		await expect(page.getByTestId("entity-table-section-note")).toBeVisible({
			timeout: 5_000,
		});

		// Two seeded rows render. Slugs in the data-testid.
		await expect(page.getByTestId("entity-row-note-first")).toBeVisible();
		await expect(page.getByTestId("entity-row-note-second")).toBeVisible();

		// ── Create flow ──
		await page.getByTestId("entity-create-note").click();
		await expect(page.getByTestId("entity-form-modal-note")).toBeVisible();
		await page.getByTestId("entity-form-slug").fill("third");
		await page.getByTestId("entity-input-title").fill("Third Note");
		// The body field is "long" (maxLength 10_000) so EntityFormModal
		// renders it as a textarea but the same test-id applies.
		await page.getByTestId("entity-input-body").fill("body-3");
		await page.getByTestId("entity-form-submit").click();
		await expect(page.getByTestId("entity-row-note-third")).toBeVisible({
			timeout: 5_000,
		});
		expect(ctrl.state().third).toEqual({ title: "Third Note", body: "body-3" });

		// ── Edit flow ──
		await page.getByTestId("entity-edit-note-first").click();
		await expect(page.getByTestId("entity-form-modal-note")).toBeVisible();
		await expect(page.getByTestId("entity-form-slug-readonly")).toHaveText(
			"first",
		);
		await page.getByTestId("entity-input-title").fill("First Note (edited)");
		await page.getByTestId("entity-form-submit").click();
		// Modal closes on success, table reloads with the new preview.
		await expect(page.getByTestId("entity-form-modal-note")).toHaveCount(0, {
			timeout: 5_000,
		});
		await expect(
			page.getByTestId("entity-row-note-first").locator("td").nth(1),
		).toContainText("First Note (edited)");
		expect(
			(ctrl.state().first as Record<string, unknown>).title,
		).toBe("First Note (edited)");

		// ── Delete flow ──
		await page.getByTestId("entity-delete-note-second").click();
		await expect(page.getByTestId("entity-row-note-second")).toHaveCount(0, {
			timeout: 5_000,
		});
		expect(ctrl.state().second).toBeUndefined();
	});
});
