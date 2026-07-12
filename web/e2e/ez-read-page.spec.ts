/**
 * Ez — `read_page` client-tool flow (on-demand page context).
 *
 * The LLM asks what the user is looking at; the runtime emits an
 * `ez:client-tool` frame with `toolName: "read_page"`; the panel's
 * dispatcher serializes the live DOM (route, title, headings, discovered
 * forms + fields — the Ez panel's own subtree excluded) and POSTs the
 * context back to `/api/conversations/[id]/tool-results` so the suspended
 * tool call resolves with real page awareness.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

interface PostedPageContext {
	path: string;
	title: string;
	headings: string[];
	content: string;
	forms: { id: string; fields: { name: string; label: string; type: string; value?: string }[] }[];
}

test.describe("Ez — read_page client tool", () => {
	const proj = makeProject({ id: "proj-1" });

	test("read_page on /agents/new returns route + discovered form fields", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj], ezConversation: { conversationId: "ez-conv-1" } });
		await page.goto("/agents/new");
		await page.getByRole("button", { name: "Configure" }).click();
		await expect(page.getByLabel("Name")).toBeVisible();

		await page.getByTestId("ez-button").click();
		await expect(page.getByTestId("ez-panel")).toBeVisible();

		const resultPost = page.waitForRequest(
			(req) => req.url().includes("/api/conversations/ez-conv-1/tool-results") && req.method() === "POST",
		);
		await emitSse({
			type: "ez:client-tool",
			data: {
				conversationId: "ez-conv-1",
				toolCallId: "tc-read-1",
				toolName: "read_page",
				input: { detail: "summary" },
			},
		});

		const body = (await resultPost).postDataJSON() as {
			toolCallId: string;
			result: { ok: boolean; detail?: PostedPageContext };
		};
		expect(body.toolCallId).toBe("tc-read-1");
		expect(body.result.ok).toBe(true);
		const ctx = body.result.detail!;
		expect(ctx.path).toContain("/agents/new");
		// The standalone bind:value inputs land in the synthetic group, and
		// the Name field is discoverable by its label.
		const allFields = ctx.forms.flatMap((f) => f.fields);
		expect(allFields.some((f) => /name/i.test(f.label) || /name/i.test(f.name))).toBe(true);
		// Summary detail carries structure only — no field values.
		expect(allFields.every((f) => f.value === undefined)).toBe(true);
		// The Ez panel's own composer is excluded from serialization.
		expect(allFields.some((f) => /Ask Ez to do something/.test(f.label))).toBe(false);
		// The visible-text excerpt carries the page's actual content — the
		// user-reported gap: read_page used to return an empty skeleton on
		// pages without headings, leaving Ez blind to what's on screen.
		expect(typeof ctx.content).toBe("string");
		expect(ctx.content.length).toBeGreaterThan(0);
		expect(ctx.content).toMatch(/Configure|agent/i);
		// The Ez panel's own text never leaks into the excerpt.
		expect(ctx.content).not.toContain("Ask Ez to do something");
	});
});
