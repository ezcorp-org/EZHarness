/**
 * THE EXTENSION RELEASE GATE (real-auth tier).
 *
 * "Installed" has been treated as success for extension authoring. It
 * isn't. A row in `extensions` proves a POST returned 2xx — nothing
 * about whether the thing a user asked for actually works. This spec is
 * the universal gate, asserted in order against a live server:
 *
 *   1. INSTALL         — the author page's Install button returns 2xx.
 *   2. LOAD            — the row is `enabled` AND the registry actually
 *                        registered `<name>__<tool>` in the toolset.
 *                        (The web author-install path deliberately lands
 *                        DISABLED — the user activates from the library —
 *                        so the gate performs that activation and then
 *                        proves the tools really entered the toolset.)
 *   3. REAL INVOCATION — the tool runs through the user's own path
 *                        (composer mention chip → inline tool form →
 *                        `/api/tool-invoke`) and a REAL, server-produced
 *                        `tool:complete` comes back over SSE.
 *   4. CONTRACT        — the returned envelope satisfies the manifest's
 *                        `smokeTest.expect.textIncludes` — the same
 *                        assertion `verifyExtension` makes, but POST-install
 *                        against the installed copy, not the draft.
 *   5. VISIBLE RESULT  — that text is rendered in a real browser card.
 *   6. REPEAT          — a second invocation returns the same result
 *                        (catches a killed / wedged / one-shot subprocess).
 *   7. UPGRADE         — reopen (the shared `reopenInstalledAsDraft` path
 *                        `modify_extension` uses), change the tool's
 *                        response string, re-install, invoke again, and
 *                        assert the NEW string comes back (catches a stale
 *                        module cache or a reused pre-upgrade subprocess).
 *
 * WHY EACH ASSERTION IS REAL (i.e. how each one can fail):
 *
 *   - Nothing in this spec injects a runtime event. There is no `emitSse`
 *     here and no fetch mocking (the real-auth tier deliberately never
 *     imports `fixtures/test-base`). Every event the browser reacts to is
 *     produced by the server's own `ToolExecutor` on the `getBus()` bus.
 *   - The completed-card assertions are load-bearing BECAUSE of how the
 *     client is wired: `invokeInlineTool` (web/src/lib/invoke-inline-tool.ts)
 *     only ever writes a `tool:error` into `inlineToolStore` from its own
 *     fetch. The ONLY writer of `status:'complete'` + `output` is the SSE
 *     handler in `stores.svelte.ts` (~line 1008). So a card that renders
 *     the tool's output text is proof that a genuine server-produced
 *     `tool:complete` crossed the wire — the spec cannot fabricate it.
 *   - Step 7's edit changes BOTH `index.ts` (the response string) and the
 *     manifest's `smokeTest.expect` (which the install endpoint re-runs as
 *     a hard gate). Editing only one of them fails the install — which is
 *     itself the acceptance gate proving `verifyExtension` really runs on
 *     an in-place upgrade.
 *
 * Wave-1 landed the fixes that make steps 2/6/7 meaningful (mid-run
 * toolset re-assembly, reload process invalidation by runtime signature,
 * bundled code checksums, fresh manifest reads). This is the spec that
 * proves them.
 *
 * NOT tagged `@evidence` on purpose: the `Visual evidence` capture job
 * runs the DEFAULT (mock, `PI_SKIP_INIT=1`) Playwright config over
 * `web/e2e/**`, where none of the real-auth surface exists — a
 * real-auth spec pulled into that lane would fail for environmental
 * reasons. Visual evidence for the chat tool-card surface is carried by
 * the mock-tier specs instead.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
	cleanupExtensionAuthorDraft,
	cleanupInstalledExtension,
	seedExtensionAuthorDraft,
} from "../fixtures/db-seed";
import { sandboxSpawnAvailable } from "./sandbox-probe";

/**
 * The scaffolded tool's response contract, verbatim from the SDK tool
 * template (`packages/@ezcorp/sdk/src/scaffold/templates/tool.ts`):
 * the handler answers `Received: <input>` and the manifest's smokeTest
 * asserts `textIncludes: "Received: smoke"` for `input: "smoke"`.
 */
const SMOKE_INPUT = "smoke";
const CONTRACT_TEXT = `Received: ${SMOKE_INPUT}`;
/** What step 7 rewrites the handler (and the smokeTest) to answer. */
const UPGRADED_TEXT = `Upgraded: ${SMOKE_INPUT}`;

interface ExtensionRow {
	id: string;
	name: string;
	enabled: boolean;
}

function makeName(slug: string): string {
	return `e2e-${slug}-${Date.now().toString(36)}`;
}

/** Fetch the single extension row for an exact manifest name (or null). */
async function fetchExtensionRow(
	request: APIRequestContext,
	name: string,
): Promise<ExtensionRow | null> {
	const res = await request.get(`/api/extensions?name=${encodeURIComponent(name)}`);
	expect(res.ok(), `GET /api/extensions?name=${name} → ${res.status()}`).toBe(true);
	const rows = (await res.json()) as ExtensionRow[];
	return rows.find((r) => r.name === name) ?? null;
}

/**
 * Drive the author preview page's Install button and wait for both the
 * POST and the redirect onto `/extensions/<name>`. Returns the install
 * response so the caller can assert its status.
 *
 * This is the user's real install path (the same button a human clicks),
 * and it runs the server's `verifyExtension` hard gate — a draft whose
 * smokeTest does not round-trip is rejected with 422 and never installs.
 */
async function installFromAuthorPage(page: Page, name: string): Promise<void> {
	const installResp = page.waitForResponse(
		(r) =>
			r.url().includes("/api/extensions/author/install") && r.request().method() === "POST",
		{ timeout: 60_000 },
	);
	const navigation = page.waitForURL(`**/extensions/${name}`, { timeout: 60_000 });
	await page.getByTestId("install-btn").click();
	const result = await installResp;
	// 201 Created — the author-install endpoint's success status.
	expect(result.status(), `install POST body: ${await result.text()}`).toBe(201);
	await navigation;
	expect(new URL(page.url()).pathname).toBe(`/extensions/${name}`);
}

/**
 * Edit one file of the open author draft through the page's own textarea
 * and wait for the debounced PUT to land, so the bytes are on disk before
 * the next action. `mutate` receives the current content.
 */
async function editDraftFile(
	page: Page,
	draftId: string,
	fileName: string,
	mutate: (current: string) => string,
): Promise<string> {
	await page.getByTestId(`file-tab-${fileName}`).click();
	const textarea = page.getByTestId("file-content");
	await expect(textarea).toBeVisible();
	const current = await textarea.inputValue();
	const next = mutate(current);
	expect(next, `mutation of ${fileName} was a no-op — the anchor text is gone`).not.toBe(current);
	const put = page.waitForRequest(
		(req) =>
			req.method() === "PUT" && req.url().includes(`/api/extensions/author/draft/${draftId}`),
		{ timeout: 10_000 },
	);
	await textarea.fill(next);
	await put;
	return next;
}

/**
 * Invoke the extension's scaffolded tool the way a user does: put the
 * `![ext:<name>]` token in the composer, click the rendered mention chip
 * (which opens the inline tool UI — a single-tool extension goes straight
 * to the form), fill the `input` field, and submit.
 *
 * Returns the locator for the tool-card summary line, which the caller
 * asserts on. The card only reaches its completed shape via a real
 * server-produced `tool:complete` (see the file header).
 */
async function invokeToolFromComposer(page: Page, name: string): Promise<void> {
	const textarea = page.locator("textarea.chat-textarea");
	await expect(textarea).toBeVisible({ timeout: 30_000 });
	const chip = page.locator(`[data-mention-kind="extension"][data-mention-name="${name}"]`);

	if ((await chip.count()) === 0) {
		// First invocation on this page load: type the `!` mention and pick
		// the extension out of the live mention popover — which also proves
		// the freshly installed extension is discoverable to the composer.
		// `pressSequentially` (not `fill`) because the composer projects a
		// compact display string over a wire string on each keystroke.
		await textarea.click();
		await textarea.pressSequentially(`!${name}`, { delay: 20 });
		const listbox = page.locator("#mention-listbox");
		await expect(listbox, "the installed extension never appeared in the ! mention popover").toBeVisible(
			{ timeout: 20_000 },
		);
		await listbox.getByText(name, { exact: false }).first().click();
	} else {
		// The token is already in the composer — clicking its chip is the
		// user's "run this again" affordance.
		await chip.click();
	}
	await expect(chip).toBeVisible({ timeout: 15_000 });

	// Single-tool extension → ChatInput opens InlineToolForm directly
	// (chooseInlineToolAction: 1 tool ⇒ "form"). The field id comes from
	// the tool's inputSchema property name.
	const field = page.locator("#field-input");
	await expect(field).toBeVisible({ timeout: 15_000 });
	await field.fill(SMOKE_INPUT);
	await page.locator("form").getByRole("button", { name: "Add", exact: true }).click();
}

test.describe("extension release gate — install → load → invoke → contract → visible → repeat → upgrade", () => {
	// Every step here spawns a REAL sandboxed extension subprocess
	// (`prlimit` + Landlock). On a runner whose jail cannot exec the
	// runtime bun the spawn dies at bring-up, so gate the group on the
	// real capability probe — the repo's sanctioned conditional-skip
	// pattern (allowed by scripts/gate-integrity.ts).
	//
	// This is NOT a silent escape hatch: ci.yml's `e2e-real-auth` job
	// runs `bun web/e2e/real-auth/_sandbox-spawn-probe.bun.ts` as its own
	// REQUIRED step immediately before playwright, so a runner that would
	// skip this suite fails the job first.
	test.skip(
		() => !sandboxSpawnAvailable(),
		"extension sandbox needs kernel caps (prlimit/Landlock) not available on this runner",
	);

	let draftId: string | null = null;
	let extensionName: string | null = null;

	test.afterEach(async ({ request }) => {
		if (extensionName) {
			await cleanupInstalledExtension(request, extensionName).catch(() => {});
		}
		if (draftId) {
			await cleanupExtensionAuthorDraft(request, draftId).catch(() => {});
		}
		draftId = null;
		extensionName = null;
	});

	test("a freshly authored extension loads, invokes, honors its output contract, repeats, and upgrades", async ({
		page,
		request,
	}) => {
		extensionName = makeName("relgate");

		// ── 1. INSTALL ────────────────────────────────────────────────
		const seeded = await seedExtensionAuthorDraft({
			request,
			name: extensionName,
			type: "tool",
			description: "E2E release-gate extension",
		});
		draftId = seeded.draftId;
		expect(seeded.files).toContain("ezcorp.config.ts");
		expect(seeded.files).toContain("index.ts");

		const previewResp = await page.goto(`/extensions/author?prefill=${seeded.draftId}`);
		expect(previewResp?.ok()).toBe(true);
		await installFromAuthorPage(page, extensionName);
		// Install consumed the draft row; afterEach must not DELETE it.
		draftId = null;

		// ── 2. LOAD ───────────────────────────────────────────────────
		// (a) the row exists. The web author-install path installs
		//     DISABLED on purpose (`enable:false` — see
		//     api/extensions/author/install/+server.ts); the user then
		//     activates it from the Extensions library. That "installed"
		//     row is exactly the state this gate exists to reject as
		//     success: it has no live tools.
		const installedRow = await fetchExtensionRow(request, extensionName);
		expect(
			installedRow,
			`no extensions row for ${extensionName} after a 201 install`,
		).not.toBeNull();
		expect(
			installedRow!.enabled,
			"the author-install path is supposed to land DISABLED (activation is a separate, admin-gated step)",
		).toBe(false);

		// (b) Activate — the exact endpoint the library's activation
		//     review modal POSTs to. With no body it enables the row and
		//     reloads the registry.
		const activate = await request.post(`/api/extensions/${installedRow!.id}/activate`);
		expect(activate.ok(), `activate → ${activate.status()} ${await activate.text()}`).toBe(true);

		const row = await fetchExtensionRow(request, extensionName);
		expect(
			row!.enabled,
			"extension is still not enabled after activate — its tools are not in any toolset",
		).toBe(true);

		// (c) the NAMESPACED tool is actually in the registry's toolset.
		//     `/api/extensions/<name>/tools` filters
		//     `registry.getAllTools()` by the `<name>__` prefix and strips
		//     it before returning, so a hit here proves the registry holds
		//     `<name>__<tool>` — the exact key `/api/tool-invoke` resolves.
		//     A manifest read would NOT prove this: the manifest is what
		//     the author wrote, the registry is what actually loaded.
		const toolsRes = await request.get(
			`/api/extensions/${encodeURIComponent(extensionName)}/tools`,
		);
		expect(
			toolsRes.ok(),
			`GET /api/extensions/${extensionName}/tools → ${toolsRes.status()} ${await toolsRes.text()}`,
		).toBe(true);
		const { tools } = (await toolsRes.json()) as { tools: Array<{ name: string }> };
		expect(tools.map((t) => t.name)).toContain(`${extensionName}-example`);

		// ── 3+4+5. REAL INVOCATION → CONTRACT → VISIBLE RESULT ────────
		const seedRes = await request.post("/api/__test/seed", {
			data: { title: "release-gate" },
		});
		expect(seedRes.status(), await seedRes.text()).toBe(201);
		const { projectId, conversationId } = (await seedRes.json()) as {
			projectId: string;
			conversationId: string;
		};

		await page.goto(`/project/${projectId}/chat/${conversationId}`);
		await invokeToolFromComposer(page, extensionName);

		// The card's summary line is `<ext> > <tool> -- <first line of
		// output> (<duration>s)`. Asserting the CONTRACT text inside it
		// is simultaneously (4) "the envelope matched the manifest's
		// smokeTest.expect.textIncludes" and (5) "a real browser rendered
		// it" — and it can only be reached through a server-produced
		// tool:complete (see the file header).
		const firstCard = page.getByText(CONTRACT_TEXT, { exact: false }).first();
		await expect(firstCard, "no rendered card carried the tool's contract text").toBeVisible({
			timeout: 90_000,
		});

		// ── 6. REPEAT ─────────────────────────────────────────────────
		// A second invocation against the SAME loaded extension. A tool
		// whose subprocess was killed, wedged, or one-shot after the first
		// call fails here while step 3 stays green.
		await invokeToolFromComposer(page, extensionName);
		await expect(
			page.getByText(CONTRACT_TEXT, { exact: false }),
			"the second invocation did not produce a second completed card",
		).toHaveCount(2, { timeout: 90_000 });

		// ── 7. UPGRADE ────────────────────────────────────────────────
		// Driven through the extension detail page's real Modify UI — the
		// same affordance a user clicks, and the same shared
		// `reopenInstalledAsDraft` implementation the in-chat
		// `modify_extension` tool calls.
		//
		// Navigate by ROW ID, which is what the Extensions library links to
		// (`/extensions/{ext.id}`). The detail route resolves its param via
		// `getExtension(id)` — a UUID lookup — so it is the id, not the
		// manifest name, that reaches this page.
		await page.goto(`/extensions/${row!.id}`);

		// (a) An admin flips `modifiable`; a creator cannot self-enable
		//     editing, so the Modify button does not exist until this
		//     lands. Asserting it is HIDDEN first is what proves the
		//     checkbox is load-bearing rather than decorative.
		const modifyButton = page.getByTestId("modify-extension-button");
		await expect(modifyButton).toHaveCount(0);
		const flagResp = page.waitForResponse(
			(r) =>
				r.url().includes(`/api/extensions/${row!.id}/modifiable`) &&
				r.request().method() === "POST",
			{ timeout: 30_000 },
		);
		await page.getByTestId("modifiable-toggle").check();
		expect((await flagResp).ok()).toBe(true);

		// (b) Re-open as an editable draft. The button navigates to the
		//     author preview with the newly minted draft id in the URL.
		await expect(modifyButton).toBeVisible({ timeout: 15_000 });
		const reopenNav = page.waitForURL(/\/extensions\/author\?prefill=/, { timeout: 30_000 });
		await modifyButton.click();
		await reopenNav;
		const modifyDraftId = new URL(page.url()).searchParams.get("prefill");
		expect(modifyDraftId, "Modify did not carry a prefill draft id").toBeTruthy();
		draftId = modifyDraftId;

		// (c) Change the tool's ACTUAL response string, and the manifest's
		//     acceptance expectation with it. Both edits are required:
		//     install re-runs `verifyExtension`, so changing only the
		//     handler would 422 and changing only the manifest would fail
		//     the round-trip. That mutual dependency is itself the proof
		//     that the acceptance gate really runs on an in-place upgrade.
		await editDraftFile(page, modifyDraftId!, "index.ts", (src) =>
			src.replace("Received: ", "Upgraded: "),
		);
		await editDraftFile(page, modifyDraftId!, "ezcorp.config.ts", (src) =>
			src.replace(CONTRACT_TEXT, UPGRADED_TEXT),
		);

		// (d) Re-install in place (same name — the reopen draft carries
		//     `payload.modifyOf`, so this is the sanctioned upgrade, not a
		//     NAME_COLLISION).
		await installFromAuthorPage(page, extensionName);
		draftId = null;

		// (e) Invoke again on a FRESH page load and assert the NEW string
		//     comes back. This is the assertion that fails on a stale
		//     module cache or a reused pre-upgrade subprocess: the old
		//     process answers `Received: smoke` forever.
		await page.goto(`/project/${projectId}/chat/${conversationId}`);
		await invokeToolFromComposer(page, extensionName);
		await expect(
			page.getByText(UPGRADED_TEXT, { exact: false }).first(),
			"the upgraded code never ran — the pre-upgrade response came back",
		).toBeVisible({ timeout: 90_000 });
		// The reload cleared the client-side inline-tool store, so the only
		// cards on screen are from this post-upgrade invocation. A stale
		// subprocess would surface the OLD string here.
		await expect(page.getByText(CONTRACT_TEXT, { exact: false })).toHaveCount(0);
	});
});
