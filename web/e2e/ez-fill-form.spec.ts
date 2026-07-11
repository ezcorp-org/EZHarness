/**
 * Ez — `fill_form` client-tool flow (on-demand page-context design).
 *
 * The retired `<EzContext>` registry required pages to register form
 * handlers; the current design discovers forms straight off the live DOM
 * (web/src/lib/ez/page-context.ts). This spec exercises the full intended
 * round-trip the model performs: `read_page` to discover the form id +
 * field vocabulary, then `fill_form` against that id — on /agents/new the
 * agent-config form is a real `<form>` with no id attribute, so its
 * discovered id is positional and MUST come from read_page.
 *
 * The runtime emits `ez:client-tool` on the global runtime-events SSE
 * stream; the panel's window-event listener dispatches to the client-tool
 * dispatcher, which fills the field (bubbling input/change so bind:value
 * reacts) and POSTs the per-field outcome back to
 * `/api/conversations/[id]/tool-results`.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

interface PostedPageContext {
	forms: { id: string; fields: { name: string; label: string; type: string }[] }[];
}

test.describe("Ez — fill_form on /agents/new", () => {
	const proj = makeProject({ id: "proj-1" });

	test("read_page discovers the agent form; fill_form populates its Name field", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj], ezConversation: { conversationId: "ez-conv-1" } });
		await page.goto("/agents/new");
		// The form lives under the Configure tab.
		await page.getByRole("button", { name: "Configure" }).click();
		await expect(page.getByLabel("Name")).toBeVisible();

		// Open the Ez panel so its ez:client-tool window listener attaches.
		await page.getByTestId("ez-button").click();
		await expect(page.getByTestId("ez-panel")).toBeVisible();

		// ── Step 1: read_page — discover the form id ──
		const readPost = page.waitForRequest(
			(req) => req.url().includes("/api/conversations/ez-conv-1/tool-results") && req.method() === "POST",
		);
		await emitSse({
			type: "ez:client-tool",
			data: {
				conversationId: "ez-conv-1",
				toolCallId: "tc-read-1",
				toolName: "read_page",
				input: {},
			},
		});
		const readBody = (await readPost).postDataJSON() as {
			result: { ok: boolean; detail?: PostedPageContext };
		};
		expect(readBody.result.ok).toBe(true);
		const agentForm = readBody.result.detail!.forms.find((f) =>
			f.fields.some((fld) => fld.label === "Name" || fld.name === "ac-name"),
		);
		expect(agentForm).toBeTruthy();

		// ── Step 2: fill_form against the discovered id ──
		const fillPost = page.waitForRequest(
			(req) =>
				req.url().includes("/api/conversations/ez-conv-1/tool-results") &&
				req.method() === "POST" &&
				(req.postDataJSON() as { toolCallId?: string })?.toolCallId === "tc-fill-1",
		);
		await emitSse({
			type: "ez:client-tool",
			data: {
				conversationId: "ez-conv-1",
				toolCallId: "tc-fill-1",
				toolName: "fill_form",
				input: { formId: agentForm!.id, values: { Name: "EmailTriager" } },
			},
		});

		await expect(page.getByLabel("Name")).toHaveValue("EmailTriager");

		// The dispatcher reports the per-field outcome back to the runtime.
		const fillBody = (await fillPost).postDataJSON() as {
			toolCallId: string;
			result: { ok: boolean; detail?: { formId: string; filled: string[] } };
		};
		expect(fillBody.result.ok).toBe(true);
		expect(fillBody.result.detail?.formId).toBe(agentForm!.id);
		expect(fillBody.result.detail?.filled).toContain("Name");
	});
});
