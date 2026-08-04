/**
 * The C3 delegation surface: the consent dialog and "jobs running as me".
 *
 * Until this landed, C3 was unreachable from the UI — there was nowhere to
 * grant a delegation, nowhere to see what one had done, and nowhere to take
 * one back. So this spec is about REACHABILITY as much as about rendering.
 *
 * What it pins that unit tests cannot:
 *
 *   1. The owner-kind picker offers BOTH kinds (Ruling 1) and switching to
 *      `service` surfaces the server's reach warning, VERBATIM.
 *   2. All three token-bound exclusions render in the dialog. This is the
 *      feature's honesty requirement: a token cap reads as a bound on the
 *      whole job, and it is not one.
 *   3. The consent-time refusal (§6.1) reaches the human as the SERVER's
 *      sentence — the one naming the remedy — and disables approve, while
 *      the picker is still on screen to act on it.
 *   4. The approve button is disabled with a VISIBLE reason until both
 *      bounds are set, and no cents field exists anywhere (Ruling 3).
 *
 * The `@evidence`-tagged test satisfies the Visual evidence CI gate.
 * `captureEvidence` is a hard no-op unless `EZCORP_E2E_EVIDENCE=1`, so the
 * normal mock run stays byte-identical.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeWorkflow } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });

const REACH_MESSAGE =
	"A service account has no user identity, so it can only be delegated workflows whose visibility is one of: system. " +
	"Forking a workflow stamps it `project`-visible, so a service account cannot run a forked workflow — " +
	'delegate those with "run as me" instead, or ask an admin to make the workflow system-visible.';

/** §6.1's refusal — the sentence Phase 4's consent route mints, which names
 *  the reason AND both remedies. */
const REFUSAL =
	"This workflow is project-visible, and a service account can only run system-visible workflows. " +
	'Choose "run as me", or ask an admin to make the workflow system-visible.';

const PREVIEW = {
	material: {
		v: 1,
		extensionName: "nightly",
		workflowName: "ship-it",
		projectId: null,
		runAs: { kind: "user", id: "u1" },
		trigger: { kind: "cron", spec: null },
		graph: [
			{
				name: "ship-it",
				identity: "version:v1@3",
				defaultModel: "null",
				steps: [
					{ name: "draft", kind: "agent", when: "null", skipDependents: true, model: "null" },
					{
						name: "publish",
						kind: "tool",
						when: JSON.stringify("inputs.confirm == true"),
						skipDependents: true,
						model: "null",
					},
				],
				capabilities: ["agent::writer", "shell::"],
			},
			{
				name: "notify",
				identity: "version:v2@1",
				defaultModel: "null",
				steps: [],
				capabilities: ["net::https://hooks.example"],
			},
		],
		unresolved: [],
		cycles: [],
		tooDeep: [],
	},
	capabilitySet: [{ kind: "agent", value: "writer" }],
	consentHash: "hash-1",
	definitionVersionId: "v1",
	effortNoops: [
		{
			workflowName: "ship-it",
			stepName: "draft",
			provider: "ollama",
			model: "llama3",
			effort: "high",
		},
	],
	maxToolCallsPerRun: 100,
	maxNestingDepth: 3,
	reach: {
		code: "SERVICE_ACCOUNT_SYSTEM_ONLY",
		runnableVisibilities: ["system"],
		message: REACH_MESSAGE,
	},
};

const DELEGATION = {
	id: "del-1",
	extensionId: "ext-nightly",
	jobRef: "nightly-ship",
	ownerKind: "user",
	ownerId: "u1",
	workflowName: "ship-it",
	definitionVersionId: "v1",
	projectId: null,
	triggerKind: "cron",
	triggerSpec: null,
	capabilitySet: [],
	maxTokensPerRun: 200000,
	maxRunsPerDay: 24,
	enabled: true,
	disabledReason: null,
	consentedAt: "2026-08-01T00:00:00.000Z",
	consentedByUserId: "u1",
};

const RUNS = [
	{
		id: "run-1",
		workflowName: "ship-it",
		status: "success",
		runAsKind: "user",
		runAs: "u1",
		delegationId: "del-1",
		startedAt: "2026-08-03T09:00:00.000Z",
		finishedAt: "2026-08-03T09:02:00.000Z",
		error: null,
		suspendedReason: null,
	},
	// A PARKED run, in the shape the server actually emits.
	//
	// This fixture used to read `error: "denied:
	// DELEGATION_DAILY_TOKENS_EXCEEDED"`, which no code path can produce: the
	// D10 rung is a dispatch-time `denyAs(...)` return that creates no
	// `workflow_runs` row at all, so a run carrying that string cannot exist.
	// The spec passed against it for eight phases and certified nothing —
	// a mock pinning a non-existent wire shape is worse than no test.
	//
	// The two rows below are the two parks that DO leave a row, and they are
	// the pair whose remedies differ: `budget-exceeded` is fixed by the
	// number on this page, `consent-stale` only by re-consenting.
	{
		id: "run-2",
		workflowName: "ship-it",
		status: "suspended",
		runAsKind: "service",
		runAs: "svc-1",
		delegationId: "del-1",
		startedAt: "2026-08-03T08:00:00.000Z",
		finishedAt: null,
		error: null,
		suspendedReason: "budget-exceeded",
	},
	{
		id: "run-3",
		workflowName: "ship-it",
		status: "suspended",
		runAsKind: "user",
		runAs: "u1",
		delegationId: "del-1",
		startedAt: "2026-08-03T07:00:00.000Z",
		finishedAt: null,
		error: null,
		suspendedReason: "consent-stale",
	},
];

interface Options {
	delegations?: unknown[];
	runs?: unknown[];
	/** When set, the preview refuses with this message instead of answering. */
	refuseWith?: string;
	extensions?: unknown[];
	/** When set, `PATCH /api/workflows/delegations/:id` refuses with this
	 *  status and message instead of echoing the updated row. */
	patchRefusal?: { status: number; error: string };
}

/** Stub the C3 surface. Installed AFTER `mockApi` so these win over its
 *  `**\/api\/**` catch-all (Playwright matches most-recent-first). */
async function stubDelegationApi(
	page: import("@playwright/test").Page,
	opts: Options = {},
): Promise<{
	posted: () => Array<Record<string, unknown>>;
	patched: () => Array<Record<string, unknown>>;
}> {
	const posted: Array<Record<string, unknown>> = [];
	const patched: Array<Record<string, unknown>> = [];

	await page.route("**/api/extensions", (route) =>
		route.fulfill({
			json: {
				extensions: opts.extensions ?? [
					{
						id: "ext-nightly",
						name: "nightly",
						enabled: true,
						grantedPermissions: { workflows: { names: [], allowDelegated: true } },
					},
					// Declines the bit — must NOT be offerable.
					{
						id: "ext-plain",
						name: "plain",
						enabled: true,
						grantedPermissions: { workflows: { names: ["own"] } },
					},
				],
			},
		}),
	);

	await page.route("**/api/workflows/delegations", async (route) => {
		if (route.request().method() === "POST") {
			posted.push(route.request().postDataJSON() as Record<string, unknown>);
			return route.fulfill({
				status: 201,
				json: { delegation: DELEGATION, supersededId: null, material: PREVIEW.material },
			});
		}
		return route.fulfill({ json: { delegations: opts.delegations ?? [] } });
	});

	// `PATCH /api/workflows/delegations/:id` — phase 8a's in-place cap
	// adjustment. Registered BEFORE the preview route on purpose: Playwright
	// matches most-recent-first, so `/preview` (registered below) still wins
	// for its own URL while this one takes every other `:id` path.
	await page.route("**/api/workflows/delegations/*", async (route) => {
		if (route.request().method() !== "PATCH") return route.fallback();
		patched.push(route.request().postDataJSON() as Record<string, unknown>);
		if (opts.patchRefusal) {
			return route.fulfill({
				status: opts.patchRefusal.status,
				json: { error: opts.patchRefusal.error },
			});
		}
		const body = route.request().postDataJSON() as { maxTokensPerRun: number };
		return route.fulfill({
			json: { delegation: { ...DELEGATION, maxTokensPerRun: body.maxTokensPerRun } },
		});
	});

	await page.route("**/api/workflows/delegations/preview", (route) =>
		opts.refuseWith
			? route.fulfill({ status: 403, json: { error: opts.refuseWith } })
			: route.fulfill({ json: PREVIEW }),
	);

	await page.route("**/api/workflows/delegated-runs", (route) =>
		route.fulfill({ json: { runs: opts.runs ?? [] } }),
	);

	// Admin-only in production; an ordinary user gets a 403 here and the
	// dialog must degrade to a sentence rather than a broken picker.
	await page.route("**/api/service-accounts", (route) =>
		route.fulfill({ status: 403, json: { error: "Admin only" } }),
	);

	return { posted: () => posted, patched: () => patched };
}

async function openConsentDialog(page: import("@playwright/test").Page) {
	await page.goto("/workflows/delegations");
	await expect(page.getByTestId("delegations-page")).toBeVisible();
	await page.getByTestId("delegations-grant").click();
	await page.getByTestId("grant-extension").selectOption("ext-nightly");
	await page.getByTestId("grant-workflow").selectOption("ship-it");
	await page.getByTestId("grant-job-ref").fill("nightly-ship");
	await page.getByTestId("grant-review").click();
	await expect(page.getByTestId("delegation-consent")).toBeVisible();
}

test.describe("Delegations page", () => {
	test("lists what has been granted, and what it has run", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], workflows: [makeWorkflow({ name: "ship-it" })] });
		await stubDelegationApi(page, { delegations: [DELEGATION], runs: RUNS });

		await page.goto("/workflows/delegations");
		await expect(page.getByTestId("delegation-card")).toHaveCount(1);
		await expect(page.getByTestId("delegation-workflow")).toHaveText("ship-it");
		await expect(page.getByTestId("delegation-state")).toHaveText("Live");

		// "Jobs running as me" — the read that the SDK's `runs()` cannot
		// answer, because it scopes to granted names AND an acting user.
		await expect(page.getByTestId("delegated-run-row")).toHaveCount(3);
		await expect(page.getByTestId("delegated-run-principal").first()).toHaveText("as you");
		// A service-account run appears here too: the account owns the run,
		// the human who consented answers for it.
		await expect(page.getByTestId("delegated-run-principal").nth(1)).toHaveText(
			"as a service account",
		);

		// The two parks that leave a row, rendered as sentences with remedies
		// rather than as the raw `suspended_reason` slug the page used to show.
		const parked = page.getByTestId("delegated-run-suspended");
		await expect(parked).toHaveCount(2);
		await expect(parked.nth(0)).toContainText("per-run token limit");
		await expect(parked.nth(0)).toContainText("raise that limit");
		await expect(parked.nth(1)).toContainText("Approve it again");
		// The raw slug must NOT survive to the page — that was the visible
		// symptom of the classifier being keyed on the wrong field.
		await expect(parked.nth(0)).not.toContainText("budget-exceeded");
		await expect(parked.nth(1)).not.toContainText("consent-stale");

		// A fire blocked before dispatch leaves no row, so the list cannot
		// show it. The page has to SAY that, or a job blocked every night
		// reads as a job that was never triggered.
		await expect(page.getByTestId("delegated-runs-blocked-note")).toContainText(
			"blocked before it starts is not listed here",
		);
	});

	test("an empty state says so on both lists", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await stubDelegationApi(page);

		await page.goto("/workflows/delegations");
		await expect(page.getByTestId("delegations-empty")).toBeVisible();
		await expect(page.getByTestId("delegated-runs-empty")).toBeVisible();
	});

	test("only an extension GRANTED the delegated bit is offerable", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], workflows: [makeWorkflow({ name: "ship-it" })] });
		await stubDelegationApi(page);

		await page.goto("/workflows/delegations");
		await page.getByTestId("delegations-grant").click();
		// `plain` declares names but not `allowDelegated`, so it is absent —
		// the gate is the GRANT, not the manifest declaration.
		const options = await page.getByTestId("grant-extension").locator("option").allTextContents();
		expect(options).toContain("nightly");
		expect(options).not.toContain("plain");
	});

	// ── The UI ↔ PATCH binding ────────────────────────────────────────────
	//
	// Phase 8b's mock spec had no PATCH test (the route did not exist on its
	// branch) and phase 8a's PATCH coverage is REAL-TIER only, so this
	// binding was unproven in the blocking lane. These three cover it.

	test("saving a limit sends a SINGLE-KEY body — the schema is strict", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], workflows: [makeWorkflow({ name: "ship-it" })] });
		const { patched } = await stubDelegationApi(page, { delegations: [DELEGATION] });

		await page.goto("/workflows/delegations");
		await page.getByTestId("delegation-tokens-input").fill("500000");
		await page.getByTestId("delegation-save-tokens").click();

		await expect.poll(() => patched().length).toBe(1);
		// EXACTLY one key. The route's body schema is `.strict()`, so a UI
		// that helpfully echoed `maxRunsPerDay` or `consentHash` alongside it
		// would turn every save into a 400 — and the failure would surface
		// only in production, since nothing else asserts the request shape.
		expect(Object.keys(patched()[0] as object)).toEqual(["maxTokensPerRun"]);
		expect(patched()[0]).toEqual({ maxTokensPerRun: 500000 });
		await expect(page.getByTestId("delegation-message")).toHaveText("Token limit updated.");
	});

	test("a limit can be LOWERED, not only raised", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], workflows: [makeWorkflow({ name: "ship-it" })] });
		const { patched } = await stubDelegationApi(page, { delegations: [DELEGATION] });

		await page.goto("/workflows/delegations");
		// The route exists to unblock a run parked at `budget-exceeded`, which
		// makes RAISING the obvious case — and is exactly why lowering needs
		// its own assertion. Tightening a standing authority must never be
		// harder than widening it.
		await page.getByTestId("delegation-tokens-input").fill("1000");
		await page.getByTestId("delegation-save-tokens").click();

		await expect.poll(() => patched().length).toBe(1);
		expect(patched()[0]).toEqual({ maxTokensPerRun: 1000 });
		await expect(page.getByTestId("delegation-message")).toHaveText("Token limit updated.");
		// And the row re-renders at the lower number rather than the old one.
		await expect(page.getByTestId("delegation-tokens-input")).toHaveValue("1000");
	});

	test("a 409 renders the server's disabled_reason VERBATIM", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], workflows: [makeWorkflow({ name: "ship-it" })] });
		// Rung D7's sentence, which is the only thing a user ever reads about
		// why their job was switched off. The page must not replace it with a
		// status line — the remedy is IN the sentence.
		const REASON =
			"This delegation is disabled and its budget cannot be adjusted: " +
			"This job stopped: the workflow is no longer visible to its owner. " +
			"It ran before, so nothing you did is wrong — the workflow's access changed. " +
			"Consent again to restart it. Consent again to restore it.";
		await stubDelegationApi(page, {
			delegations: [DELEGATION],
			patchRefusal: { status: 409, error: REASON },
		});

		await page.goto("/workflows/delegations");
		await page.getByTestId("delegation-tokens-input").fill("500000");
		await page.getByTestId("delegation-save-tokens").click();

		// Byte-for-byte, not a paraphrase and not "Request failed (409)".
		await expect(page.getByTestId("delegation-message")).toHaveText(REASON);
	});
});

test.describe("Delegation consent dialog", () => {
	test("offers BOTH owner kinds, and warns about a service account's reach", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], workflows: [makeWorkflow({ name: "ship-it" })] });
		await stubDelegationApi(page);
		await openConsentDialog(page);

		// Ruling 1 — both kinds, selectable per delegation.
		await expect(page.getByTestId("owner-kind-user")).toBeVisible();
		await expect(page.getByTestId("owner-kind-service")).toBeVisible();
		await expect(page.getByTestId("owner-kind-user")).toBeChecked();

		// Nothing to warn about while running as yourself.
		await expect(page.getByTestId("reach-warning")).toHaveCount(0);

		await page.getByTestId("owner-kind-service").check();
		// The server's sentence, VERBATIM — not a paraphrase composed here.
		await expect(page.getByTestId("reach-warning")).toHaveText(REACH_MESSAGE);
		// A non-admin cannot list service accounts, so the picker says why
		// rather than rendering an empty dropdown.
		await expect(page.getByTestId("no-service-accounts")).toBeVisible();
	});

	test("discloses all THREE things the token limit does not cover", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], workflows: [makeWorkflow({ name: "ship-it" })] });
		await stubDelegationApi(page);
		await openConsentDialog(page);

		const block = page.getByTestId("token-bound-exclusions");
		await expect(block).toBeVisible();

		// 1 — tool steps are outside the cap, and are separately bounded.
		await expect(page.getByTestId("exclusion-tool-steps")).toContainText(
			"counts language-model tokens",
		);
		await expect(page.getByTestId("exclusion-tool-steps")).toContainText(
			"100 tool calls per run",
		);
		// 2 — a nested child run is outside it too, bounded only by depth.
		await expect(page.getByTestId("exclusion-nested-runs")).toContainText(
			"starts another workflow is not counted",
		);
		// 3 — a per-step effort that the bound model will drop.
		await expect(page.getByTestId("exclusion-effort-noop")).toContainText("ship-it.draft");
		await expect(page.getByTestId("exclusion-effort-noop")).toContainText("will be ignored");

		// Ruling 3 — tokens are enforced, cost is advisory. No cents cap is
		// shown or collected ANYWHERE in this dialog.
		await expect(page.getByTestId("delegation-consent")).not.toContainText("$");
		await expect(page.getByTestId("delegation-consent")).not.toContainText("cents");
	});

	test("shows the capability diff, attributed, with when-guarded steps", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], workflows: [makeWorkflow({ name: "ship-it" })] });
		await stubDelegationApi(page);
		await openConsentDialog(page);

		const diff = page.getByTestId("capability-diff");
		await expect(diff).toContainText("shell");
		// Attribution: a capability contributed by a NESTED definition names
		// that definition, so "a workflow you never opened can reach the
		// network" is visible as such.
		await expect(diff).toContainText("via notify");

		// The old caveat said `when`-suppressed steps could not be shown.
		// They can, and are: the guard is what makes the capability list
		// above honest rather than alarming.
		await expect(page.getByTestId("conditional-step")).toHaveCount(1);
		await expect(page.getByTestId("conditional-step")).toContainText("ship-it.publish");
		await expect(page.getByTestId("conditional-step")).toContainText("inputs.confirm == true");
	});

	test("approve stays disabled, with a visible reason, until both bounds are set", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], workflows: [makeWorkflow({ name: "ship-it" })] });
		const { posted } = await stubDelegationApi(page);
		await openConsentDialog(page);

		const approve = page.getByTestId("consent-approve");
		await expect(approve).toBeDisabled();
		// The reason is next to the button, not in a tooltip.
		await expect(page.getByTestId("consent-blocked-reason")).toContainText("token limit");

		await page.getByTestId("max-tokens-per-run").fill("200000");
		await expect(approve).toBeDisabled();
		await expect(page.getByTestId("consent-blocked-reason")).toContainText("runs per day");

		await page.getByTestId("max-runs-per-day").fill("24");
		await expect(approve).toBeEnabled();
		await expect(page.getByTestId("consent-blocked-reason")).toHaveText("");

		await approve.click();
		await expect.poll(() => posted().length).toBe(1);
		expect(posted()[0]).toMatchObject({
			extensionId: "ext-nightly",
			jobRef: "nightly-ship",
			workflowName: "ship-it",
			ownerKind: "user",
			maxTokensPerRun: 200000,
			maxRunsPerDay: 24,
		});
		// The user arm never sends an account id — the route refuses a body
		// naming both arms rather than trimming it.
		expect(posted()[0]).not.toHaveProperty("ownerServiceAccountId");

		// The approved delegation lands in the list without a refetch race.
		await expect(page.getByTestId("delegation-card")).toHaveCount(1);
	});

	test("a consent-time refusal reaches the human as the SERVER's sentence", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], workflows: [makeWorkflow({ name: "ship-it" })] });
		await stubDelegationApi(page, { refuseWith: REFUSAL });
		await openConsentDialog(page);

		// Not a bare 403: §6.1's message names the reason AND both remedies.
		await expect(page.getByTestId("consent-refused")).toHaveText(REFUSAL);
		await expect(page.getByTestId("consent-approve")).toBeDisabled();
		// The picker is still on screen, so the remedy the sentence names is
		// one click away rather than behind a re-open.
		await expect(page.getByTestId("owner-kind-picker")).toBeVisible();
	});

	test("the dialog's primary action and picker are keyboard reachable", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], workflows: [makeWorkflow({ name: "ship-it" })] });
		await stubDelegationApi(page);
		await openConsentDialog(page);

		// The owner-kind radios take focus and switch by keyboard, so the
		// choice is not mouse-only.
		await page.getByTestId("owner-kind-user").focus();
		await expect(page.getByTestId("owner-kind-user")).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(page.getByTestId("owner-kind-service")).toBeChecked();

		// Escape closes — the dialog is not a trap.
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("delegation-consent")).toHaveCount(0);
	});

	test("renders the consent dialog and captures evidence @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj], workflows: [makeWorkflow({ name: "ship-it" })] });
		await stubDelegationApi(page, { delegations: [DELEGATION], runs: RUNS });

		await page.goto("/workflows/delegations");
		await expect(page.getByTestId("delegations-page")).toBeVisible();
		await expect(page.getByTestId("delegation-card")).toHaveCount(1);
		await captureEvidence(page, testInfo, "delegations-page");

		await page.getByTestId("delegations-grant").click();
		await page.getByTestId("grant-extension").selectOption("ext-nightly");
		await page.getByTestId("grant-workflow").selectOption("ship-it");
		await page.getByTestId("grant-job-ref").fill("nightly-ship");
		await page.getByTestId("grant-review").click();
		await expect(page.getByTestId("token-bound-exclusions")).toBeVisible();
		await captureEvidence(page, testInfo, "delegation-consent-dialog");

		// The dialog body scrolls INSIDE a fixed-height modal, so `fullPage`
		// does not reach past its fold — the first capture stops above the
		// disclosure block. Scroll it into view and take a second shot, because
		// "what the token limit does not cover" is the single thing a reviewer
		// of this feature most needs to see.
		await page.getByTestId("token-bound-exclusions").scrollIntoViewIfNeeded();
		await expect(page.getByTestId("exclusion-nested-runs")).toBeVisible();
		await captureEvidence(page, testInfo, "delegation-consent-exclusions");

		await page.getByTestId("owner-kind-service").check();
		await expect(page.getByTestId("reach-warning")).toBeVisible();
		await captureEvidence(page, testInfo, "delegation-consent-service-reach", { fullPage: true });

		// Assert the capture contract in BOTH modes (mirrors extensions-sort)
		// so the test is meaningful without the flag, not a bare screenshot.
		const labels = [
			"delegations-page",
			"delegation-consent-dialog",
			"delegation-consent-exclusions",
			"delegation-consent-service-reach",
		];
		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			for (const label of labels) {
				expect(
					testInfo.attachments.some(
						(a) => a.name === label && a.contentType === "image/png",
					),
				).toBe(true);
			}
		} else {
			expect(testInfo.attachments.some((a) => labels.includes(a.name))).toBe(false);
		}
	});
});
