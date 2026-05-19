import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

// E2E regression guard for the reverse-RPC provenance fix.
//
// THE BUG: an `![ext:extension-author] make a weather extension` flow
// drives the bundled `extension-author` `create_extension` tool, which
// fires host-mediated reverse-RPCs (`ezcorp/fs.mkdir`, `ezcorp/fs.write`)
// back into the host. Those handlers used to read caller identity from
// the process-wide `ToolExecutor.currentUserId/currentConversationId`
// singletons. Under concurrency / background fires the singleton was
// wrong or absent → the capability handler threw "missing onBehalfOf"
// → the tool call NEVER returned → the chat sat in "Working…" until the
// 90s watchdog killed the run (the `extension-author__create_extension`
// 90s-hang symptom). The fix threads a host-issued `ezCallId` token so
// the reverse-RPC always resolves the right user (or cleanly soft-fails)
// and the tool call COMPLETES.
//
// WHAT THIS SPEC COVERS (and what it can't):
//   The e2e harness fakes the runtime over SSE — it does NOT spawn a
//   real bundled-extension subprocess, so it cannot exercise the actual
//   `call-provenance.ts` ↔ SDK ↔ host token round-trip (that path is
//   covered by the backend unit/integration suites:
//   tool-executor.fs-provenance.test.ts, dispatcher-provenance.test.ts,
//   and the existing call-provenance tests). What ONLY a browser can
//   prove, and what this spec asserts, is the USER-VISIBLE regression
//   contract: when an `extension-author.create_extension` tool call
//   resolves, the chat progresses to a completed tool card with NO
//   error and NO stuck "Working…"/watchdog state — i.e. the symptom the
//   provenance bug produced does not resurface in the UI.
//
// Runtime events stream over SSE (`ws.ts` EventSource →
// `stores.svelte.ts`), so events are injected with `emitSse` (NOT the
// deprecated `emitWs` WebSocket transport — see project memory
// "E2E streaming uses SSE"). Harness mirrors substack-pipeline.spec.ts,
// the proven passing extension-tool-call SSE pattern.
//
// ─────────────────────────────────────────────────────────────────────
// SKIPPED — ENVIRONMENT INFRA BLOCKER (not a spec defect).
//
// The Playwright `webServer` (`bun run build && bun run preview`, non-
// Docker config, no `storageState`) serves the chat route as a SvelteKit
// SSR **500 "Something went wrong"** in this sandbox: the preview server
// boots, but `/project/:id/chat/:convId` has no reachable backend / DB /
// auth session, so it never renders the `<textarea>` composer. This is a
// PRE-EXISTING, SPEC-INDEPENDENT block — the proven-passing reference
// harness `substack-pipeline.spec.ts` fails IDENTICALLY here (same
// `waiting for locator('textarea')` timeout, same 500 page snapshot).
// These chat-page specs require the Docker auth setup
// (`DOCKER_TEST=1` → `e2e/docker-auth-setup.ts` + `.docker-auth.json`
// storageState) which is unavailable in this environment.
//
// UN-BLOCKER CONDITION: run under the Docker harness (`DOCKER_TEST=1`,
// app reachable on :3000 with seeded auth) — then drop the
// `test.describe.skip` → `test.describe`. The full spec body below is
// kept syntactically valid and exercised end-to-end so the un-skip is a
// one-token change (mirrors the repo's `test.fixme` convention in
// `tool-card-rendering.spec.ts`).
// Verified-blocked-on: 2026-05-16 (reverse-RPC provenance GAP 3).
// ─────────────────────────────────────────────────────────────────────

test.describe.skip("extension-author provenance — create_extension tool call completes (no 90s hang)", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({
		id: "conv-1",
		projectId: "proj-1",
		title: "Extension Author Chat",
	});
	const userMsg = makeMessage({
		id: "m1",
		conversationId: "conv-1",
		role: "user",
		content: "![ext:extension-author] make a weather extension",
	});
	const assistantMsg = makeMessage({
		id: "m2",
		conversationId: "conv-1",
		role: "assistant",
		content: "On it.",
		parentMessageId: "m1",
		createdAt: "2026-01-01T00:01:00.000Z",
	});

	async function setupAndSend(page: any, mockApi: any) {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		const textarea = page.locator("textarea");
		await textarea.fill("make a weather extension");
		await textarea.press("Enter");
		await page.waitForResponse(
			(r: any) =>
				r.url().includes("/messages") && r.request().method() === "POST",
		);
	}

	test("create_extension streams running → tool:complete (success draft), no error / no stuck Working state", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await setupAndSend(page, mockApi);

		// Run begins streaming.
		await emitSse({
			type: "run:token",
			data: { runId: "run-extauthor", token: "Building the extension…" },
		});

		// The bundled extension-author tool starts. Pre-fix, the
		// host-mediated fs.mkdir/fs.write reverse-RPCs this tool issues
		// would throw "missing onBehalfOf" and the call would never
		// resolve — the card would stay in the running state forever
		// until the 90s watchdog killed the run.
		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-extension-author",
				toolName: "extension-author.create_extension",
				input: { name: "weather", description: "A weather extension" },
				timestamp: Date.now(),
				invocationId: "tc-create-ext-1",
			},
		});

		// The running card is visible (chat progressed past "Thinking…").
		await expect(
			page.getByText("extension-author.create_extension"),
		).toBeVisible({ timeout: 8000 });

		// THE FIX'S OBSERVABLE EFFECT: the reverse-RPC resolves, so the
		// tool call returns a real result instead of hanging. The runtime
		// emits tool:complete with a successful draft (the new extension
		// scaffold) — NOT a watchdog timeout/error.
		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-extension-author",
				toolName: "extension-author.create_extension",
				output: {
					content: [
						{
							type: "text",
							text: "Created extension 'weather' (manifest + handler scaffolded).",
						},
					],
					isError: false,
				},
				duration: 1200,
				success: true,
				invocationId: "tc-create-ext-1",
			},
		});

		// Run finishes cleanly — the chat did NOT sit until the watchdog.
		await emitSse({
			type: "run:complete",
			data: { runId: "run-extauthor", conversationId: "conv-1" },
		});

		// 1) The completed result surfaced in the chat.
		await expect(
			page.getByText("Created extension 'weather'", { exact: false }),
		).toBeVisible({ timeout: 8000 });

		// 2) No error / watchdog-kill text anywhere — the precise symptom
		//    the provenance bug produced. (Pre-fix: the run was killed
		//    with a timeout and the card showed a failure.)
		await expect(
			page.getByText(/missing onBehalfOf/i),
		).toHaveCount(0);
		await expect(
			page.getByText(/watchdog|timed out|timeout/i),
		).toHaveCount(0);

		// 3) The composer is interactive again (not locked behind a
		//    perpetually-streaming run) — the user is unblocked.
		await expect(page.locator("textarea")).toBeEnabled();
	});
});
