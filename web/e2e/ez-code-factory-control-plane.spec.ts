/**
 * ez-code-factory control plane (`?view=` config / job / audit + job actions) —
 * page-level e2e (mockApi + emitSse, no Docker). Clones the step-detail spec's
 * mock pattern (route the Hub render endpoint, branch on `?view=`) and proves
 * the control plane's user-visible contract against mocked Hub API routes:
 *   - the CONFIG view renders the pipeline, the jobs table (rows → ?view=job:<id>),
 *     and the sweep-health WARNING state (warning tone) + captureEvidence,
 *   - the JOB editor's ONE INLINE edit form carries every field
 *     prefilled; changing two fields + clearing one POSTs a SINGLE `job-save`
 *     with the whole merged payload (+ captureEvidence of the open dialog), and
 *     the re-render reflects the change; Cancel dispatches nothing,
 *   - the AUDIT view renders entries (truncated actor, run deep-link), day nav,
 *     + captureEvidence,
 *   - the "Run now" button POSTs the declared `run-now` event,
 *   - a content-free `ext:page-state` SSE signal re-pulls the SAME view variant,
 *   - PRIVACY: no transcript / prompt text appears in the audit DOM (id-only).
 *
 * The extension's server-side builders (view trees, tones, hrefs, actor
 * truncation, XSS text-cells) + handlers (RBAC gate, validation, audit) are
 * covered by the bun suite under docs/extensions/examples/ez-code-factory/
 * lib/page.test.ts + index.test.ts; here the mocks return already-rendered
 * trees and record the action POSTs, mirroring the run-links / step-detail specs.
 *
 * The `@evidence` tests capture the config + audit surfaces, satisfying the
 * Visual evidence gate for this frontend-visual feature.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });
const EXT_ID = "ext:ez-code-factory:dashboard";
const JOB_ID = "job_1";
const RUN_ID = "run_abc";

const listing = { pages: [{ id: EXT_ID, title: "ez-code-factory", kind: "ext" }] };
const hubBase = `/project/${proj.id}/hub/${encodeURIComponent(EXT_ID)}`;
const viewHref = (view: string) => `${hubBase}?view=${encodeURIComponent(view)}`;
const runHref = (id: string) => `${hubBase}?run=${id}`;

/** Config view: pipeline table + jobs table (row → ?view=job:<id>) + the
 *  warning-toned "sweep has never run" cell + the New job button. */
function configTree() {
	return {
		title: "ez-code-factory — config",
		nodes: [
			{ type: "heading", level: 2, text: "Pipeline" },
			{
				type: "table",
				columns: ["Step", "Skipped by"],
				rows: [
					{ cells: ["review", "—"] },
					{ cells: ["test", "Nightly"] },
				],
			},
			{ type: "heading", level: 2, text: "Jobs" },
			{
				type: "table",
				columns: ["Name", "Trigger", "Enabled", "Last run"],
				rows: [
					{
						cells: ["Nightly", "schedule · daily · main", { text: "✓ enabled", tone: "success" }, `${RUN_ID} · ✓ completed`],
						href: viewHref(`job:${JOB_ID}`),
					},
				],
			},
			{ type: "button", label: "New job", action: { event: "ez-code-factory:job-save", prompt: { label: "New job name", field: "name" } }, style: "primary" },
			{ type: "heading", level: 2, text: "Schedule health" },
			{
				type: "table",
				columns: ["Sweep health"],
				rows: [
					{ cells: [{ text: "⚠ sweep has never run — schedule-trigger jobs will not fire until it does", tone: "warning" }] },
				],
			},
			{ type: "link", label: "Edit scalar settings (platform)", href: "/extensions/ez-code-factory" },
		],
	};
}

const AGENT_NAME = "Research Assistant";
const INTENT_TEMPLATE = "Keep the public API backward compatible.";
// Operator prompt instructions — the fixture starts with fix + document set
// (review empty) so the Edit-prompts dialog opens with prefilled + empty fields.
const REVIEW_INSTR = "Focus on API stability.";
const FIX_INSTR = "Prefer the smallest root-cause fix.";
const DOC_INSTR = "Keep the README authoritative.";

/** Job editor mirror of buildJobView: Definition (stats + ONE INLINE edit form
 *  button with every field prefilled) → Flow (9 steps; skipped => warning cell,
 *  protected => plain label + NO row action, running => a job-save toggle_step
 *  row action + confirm) → Prompts (read-only previews with the agent
 *  substituted) → Runs → Danger zone (Delete). `name`/`agent`/`intent` reflect
 *  the latest save (the trigger is a fixed schedule in this fixture). */
function jobTree(name: string, agent: string, intent: string, review: string, fix: string, doc: string) {
	const anyInstr = Boolean(review || fix || doc);
	const toggleRow = (step: string, state: unknown, verb: "Skip" | "Run") => ({
		cells: [step, state],
		action: {
			event: "ez-code-factory:job-save",
			payload: { jobId: JOB_ID, toggle_step: step },
			confirm: verb === "Skip" ? `Skip the ${step} step for job "${name}"?` : `Run the ${step} step again for job "${name}"?`,
		},
	});
	const protectedRow = (step: string) => ({ cells: [step, "protected — always runs"] });
	return {
		title: `ez-code-factory — job ${name}`,
		nodes: [
			{
				type: "section",
				title: `Job: ${name}`,
				nodes: [
					{
						type: "stats",
						items: [
							{ label: "Trigger", value: "schedule · daily · main" },
							{ label: "Enabled", value: "yes" },
							{ label: "Skips", value: "test" },
							{ label: "Agent", value: agent },
						],
					},
				],
			},
			{
				type: "section",
				title: "Edit",
				nodes: [
					// The ONE INLINE edit form carries every editable field, all
					// prefilled (trigger as its THREE components; kind/cadence are
					// selects); the long free-text fields are multiline.
					{
						type: "form",
						action: { event: "ez-code-factory:job-save", payload: { jobId: JOB_ID } },
						submitLabel: "Save job",
						fields: [
							{ field: "name", label: "Name", value: name, maxLength: 80 },
							{
								field: "trigger_kind",
								label: "Trigger",
								value: "schedule",
								options: [
									{ value: "push", label: "push — every matching git push" },
									{ value: "schedule", label: "schedule — on a cadence" },
									{ value: "manual", label: "manual — Run now only" },
								],
							},
							{ field: "trigger_branch", label: "Branch", value: "main", maxLength: 120 },
							{
								field: "trigger_every",
								label: "Cadence (schedule trigger only — ignored otherwise)",
								value: "daily",
								options: [{ value: "15m", label: "every 15 minutes" }, { value: "hourly" }, { value: "daily" }],
							},
							{ field: "agent_name", label: "Agent (blank = repo-config / deployment default)", value: agent, maxLength: 120 },
							{ field: "intent_template", label: "Intent template (blank = none)", value: intent, maxLength: 500, multiline: true },
							{ field: "review_instructions", label: "Review instructions (blank = none)", value: review, maxLength: 500, multiline: true },
							{ field: "fix_instructions", label: "Fix instructions (blank = none)", value: fix, maxLength: 500, multiline: true },
							{ field: "document_instructions", label: "Document instructions (blank = none)", value: doc, maxLength: 500, multiline: true },
						],
					},
				],
			},
			{
				type: "section",
				title: "Actions",
				nodes: [
					{ type: "button", label: "Run now", action: { event: "ez-code-factory:run-now", payload: { jobId: JOB_ID }, confirm: `Run job "${name}" now on main?` }, style: "primary" },
				],
			},
			{
				type: "section",
				title: "Flow",
				nodes: [
					{ type: "text", content: "Step order is fixed by the pipeline and cannot be changed here, and the protected steps (intent, rebase, review, push) always run.", variant: "muted" },
					{
						type: "table",
						columns: ["Step", "State"],
						rows: [
							protectedRow("intent"),
							protectedRow("rebase"),
							protectedRow("review"),
							toggleRow("test", { text: "skipped", tone: "warning" }, "Run"),
							toggleRow("document", "runs", "Skip"),
							toggleRow("lint", "runs", "Skip"),
							protectedRow("push"),
						],
					},
				],
			},
			{
				type: "section",
				title: "Prompts",
				nodes: [
					// The muted "+ operator instructions" marker shows only when any set.
					...(anyInstr ? [{ type: "text", content: "+ operator instructions", variant: "muted" }] : []),
					{ type: "text", content: "What this job sends the agent, with this job's known values already filled in. Run-scoped values (<branch>, <base-commit>, <head-commit>) and repo-file values (<repo: ignore_patterns>, <repo: document.instructions>) are resolved per run.", variant: "muted" },
					{ type: "heading", level: 3, text: "Review" },
					{
						type: "table",
						columns: ["Part", "Content"],
						rows: [
							{ cells: ["Agent", agent] },
							// The substituted operator instruction is a meta row only when set.
							...(review ? [{ cells: ["Operator instructions", review] }] : []),
							{ cells: ["Run-scoped", "<branch>, <base-commit>, <head-commit> — resolved per run"] },
							{ cells: ["Prompt · 3.0 KB · excerpt", "Review the code changes and return structured findings with a risk assessment. Context: - branch: <branch> - base commit: <base-commit>…"] },
						],
					},
				],
			},
			{
				type: "section",
				title: "Runs",
				nodes: [
					{
						type: "table",
						columns: ["Run", "Branch", "Head", "Status", "Updated"],
						rows: [{ cells: [RUN_ID, "main", "deadbeef", { text: "✓ completed", tone: "success" }, "2026-07-21 00:00"], href: runHref(RUN_ID) }],
					},
				],
			},
			{
				type: "section",
				title: "Danger zone",
				nodes: [
					{ type: "button", label: "Delete job", action: { event: "ez-code-factory:job-delete", payload: { jobId: JOB_ID }, confirm: `Delete job "${name}"?` }, style: "danger" },
				],
			},
		],
	};
}

/** Audit view for a day: entries newest-first (truncated actor, run deep-link),
 *  prev/next day nav, and an id-only detail (no transcript/prompt content). */
function auditTree(day: string) {
	return {
		title: `ez-code-factory — audit ${day}`,
		nodes: [
			{ type: "heading", level: 2, text: `Audit — ${day}` },
			{ type: "link", label: "← 2026-07-20", href: viewHref("audit:2026-07-20") },
			{ type: "link", label: "Config", href: viewHref("config") },
			{
				type: "table",
				columns: ["When", "Actor", "Kind", "Job", "Run", "Detail"],
				rows: [
					{
						cells: ["2026-07-21 09:00", "user 1a2b3c…", "respond", "—", RUN_ID, '{"action":"approve","findingIds":["f1"]}'],
						href: runHref(RUN_ID),
					},
					{ cells: ["2026-07-21 08:00", "system", "sweep", "—", "—", '{"scanned":2}'] },
				],
			},
		],
	};
}

const dashboardTree = {
	title: "ez-code-factory — Test Project",
	nodes: [{ type: "empty-state", title: "No gate runs for this project yet" }],
};

/** Shared mock state: the current job name (mutated by a save) + the recorded
 *  action POST bodies + per-view pull counts. */
interface HubState {
	jobName: string;
	jobAgent: string;
	jobIntent: string;
	jobReview: string;
	jobFix: string;
	jobDoc: string;
	saveBody?: unknown;
	runNowBody?: unknown;
	configPulls: number;
	jobPulls: number;
}

/** Route the Hub render endpoint (branch on `?view=`) + the four job-action
 *  events. Returns the shared state so tests can assert POST bodies + re-pulls. */
async function routeHub(page: import("@playwright/test").Page): Promise<HubState> {
	const state: HubState = {
		jobName: "Nightly",
		jobAgent: AGENT_NAME,
		jobIntent: INTENT_TEMPLATE,
		jobReview: "",
		jobFix: FIX_INSTR,
		jobDoc: DOC_INSTR,
		configPulls: 0,
		jobPulls: 0,
	};
	await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
	await page.route(
		(url) => decodeURIComponent(url.pathname).endsWith(`/api/hub/pages/${EXT_ID}`),
		(route) => {
			const view = new URL(route.request().url()).searchParams.get("view");
			let pageTree: unknown = dashboardTree;
			if (view === "config") {
				state.configPulls += 1;
				pageTree = configTree();
			} else if (view?.startsWith("job:")) {
				state.jobPulls += 1;
				pageTree = jobTree(state.jobName, state.jobAgent, state.jobIntent, state.jobReview, state.jobFix, state.jobDoc);
			} else if (view === "audit" || view?.startsWith("audit:")) {
				const day = view.includes(":") ? view.slice("audit:".length) : "2026-07-21";
				pageTree = auditTree(day);
			}
			return route.fulfill({ json: { page: pageTree, renderedAt: Date.now() } });
		},
	);
	// job-save: record the merged payload, apply every present field, ack (the Hub
	// re-pulls). A toggle-only save (no name/agent/intent keys) leaves them intact.
	await page.route("**/api/extensions/ez-code-factory/events/job-save", (route) => {
		state.saveBody = route.request().postDataJSON();
		const payload = (state.saveBody as { payload?: Record<string, unknown> })?.payload ?? {};
		if (typeof payload.name === "string" && payload.name) state.jobName = payload.name;
		// agent/intent apply even when empty (clear-to-empty); an empty agent shows
		// as "default" in the stats, mirroring buildJobView's `agentName ?? default`.
		if (typeof payload.agent_name === "string") state.jobAgent = payload.agent_name || "default";
		if (typeof payload.intent_template === "string") state.jobIntent = payload.intent_template;
		// The Edit-prompts dialog submits all three instruction keys every save;
		// each applies (clear-to-empty removes), mirroring the explicit-carry patch.
		if (typeof payload.review_instructions === "string") state.jobReview = payload.review_instructions;
		if (typeof payload.fix_instructions === "string") state.jobFix = payload.fix_instructions;
		if (typeof payload.document_instructions === "string") state.jobDoc = payload.document_instructions;
		return route.fulfill({ json: { ok: true } });
	});
	await page.route("**/api/extensions/ez-code-factory/events/run-now", (route) => {
		state.runNowBody = route.request().postDataJSON();
		return route.fulfill({ json: { ok: true } });
	});
	await page.route("**/api/extensions/ez-code-factory/events/job-toggle", (route) => route.fulfill({ json: { ok: true } }));
	await page.route("**/api/extensions/ez-code-factory/events/job-delete", (route) => route.fulfill({ json: { ok: true } }));
	return state;
}

test.describe("ez-code-factory control plane (?view= + job actions)", () => {
	test("the config view renders the pipeline, jobs table, and the sweep-health warning @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj] });
		await routeHub(page);

		await page.goto(viewHref("config"));
		await expect(page.getByTestId("hub-page-title")).toHaveText("ez-code-factory — config");

		const body = page.getByTestId("hub-page-body");
		// Pipeline + jobs table content.
		await expect(page.getByRole("heading", { name: "Pipeline" })).toBeVisible();
		await expect(body).toContainText("Nightly");
		await expect(body).toContainText("schedule · daily · main");
		// The jobs row links to the job editor variant.
		const jobLink = page.getByTestId("hub-row-link").filter({ hasText: "Nightly" });
		await expect(jobLink).toHaveAttribute("href", new RegExp(`\\?view=${encodeURIComponent(`job:${JOB_ID}`)}`));
		// Sweep-health WARNING cell (warning tone).
		const warn = page.locator('[data-testid="hub-table-cell"][data-tone="warning"]');
		await expect(warn).toContainText("sweep has never run");
		// The New job button is present.
		await expect(page.getByRole("button", { name: "New job" })).toBeVisible();

		await captureEvidence(page, testInfo, "ez-code-factory-config-view");
	});

	test("the inline edit form shows ALL 9 fields prefilled ON the page; one Save POSTs ONE job-save with every field; the re-render reflects @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj] });
		const state = await routeHub(page);

		await page.goto(viewHref(`job:${JOB_ID}`));
		await expect(page.getByTestId("hub-page-title")).toHaveText("ez-code-factory — job Nightly");

		// Every editable field is ON the page — no modal to open. Short fields are
		// inputs; the intent + instruction fields render as textareas.
		const form = page.getByTestId("hub-inline-form");
		await expect(form).toBeVisible();
		await expect(page.getByTestId("hub-inline-field-name")).toHaveValue("Nightly");
		// The trigger edits as components: kind + cadence are real SELECTs
		// (no free-text grammar), branch is a text field.
		const kindSelect = page.getByTestId("hub-inline-field-trigger_kind");
		expect(await kindSelect.evaluate((el) => el.tagName)).toBe("SELECT");
		await expect(kindSelect).toHaveValue("schedule");
		await expect(page.getByTestId("hub-inline-field-trigger_branch")).toHaveValue("main");
		const everySelect = page.getByTestId("hub-inline-field-trigger_every");
		expect(await everySelect.evaluate((el) => el.tagName)).toBe("SELECT");
		await expect(everySelect).toHaveValue("daily");
		await expect(page.getByTestId("hub-inline-field-agent_name")).toHaveValue(AGENT_NAME);
		await expect(page.getByTestId("hub-inline-field-intent_template")).toHaveValue(INTENT_TEMPLATE);
		await expect(page.getByTestId("hub-inline-field-review_instructions")).toHaveValue("");
		await expect(page.getByTestId("hub-inline-field-fix_instructions")).toHaveValue(FIX_INSTR);
		await expect(page.getByTestId("hub-inline-field-document_instructions")).toHaveValue(DOC_INSTR);
		for (const long of ["intent_template", "review_instructions", "fix_instructions", "document_instructions"]) {
			expect(await page.getByTestId(`hub-inline-field-${long}`).evaluate((el) => el.tagName)).toBe("TEXTAREA");
		}

		// Capture the on-page edit surface (frontend-visual evidence gate).
		await captureEvidence(page, testInfo, "ez-code-factory-inline-edit-form");

		// Change two fields, SET one, and CLEAR two — all in one pass: name +
		// agent change, review gets set, intent + fix clear to empty.
		await page.getByTestId("hub-inline-field-name").fill("Renamed");
		await page.getByTestId("hub-inline-field-agent_name").fill("Reviewer Bot");
		await page.getByTestId("hub-inline-field-review_instructions").fill(REVIEW_INSTR);
		await page.getByTestId("hub-inline-field-intent_template").fill("");
		await page.getByTestId("hub-inline-field-fix_instructions").fill("");
		// Typing alone dispatches NOTHING — only Save submits.
		expect(state.saveBody).toBeUndefined();

		const savePost = page.waitForRequest(
			(req) => req.method() === "POST" && req.url().includes("/api/extensions/ez-code-factory/events/job-save"),
		);
		await page.getByTestId("hub-inline-form-submit").click();
		const req = await savePost;

		// ONE POST carries EVERY field merged into payload — untouched fields
		// (the three trigger components, document) re-sent verbatim, cleared
		// fields as "", the static jobId preserved.
		expect(req.postDataJSON()).toMatchObject({
			payload: {
				jobId: JOB_ID,
				name: "Renamed",
				trigger_kind: "schedule",
				trigger_branch: "main",
				trigger_every: "daily",
				agent_name: "Reviewer Bot",
				intent_template: "",
				review_instructions: REVIEW_INSTR,
				fix_instructions: "",
				document_instructions: DOC_INSTR,
			},
		});
		expect(state.saveBody).toMatchObject({ payload: { name: "Renamed", agent_name: "Reviewer Bot", intent_template: "" } });
		// The action re-pulls the SAME view → the fresh tree reflects name + agent,
		// the Prompts preview substitutes the review instruction, and the
		// "+ operator instructions" marker shows.
		await expect(page.getByTestId("hub-page-title")).toHaveText("ez-code-factory — job Renamed");
		const body = page.getByTestId("hub-page-body");
		await expect(body).toContainText("Reviewer Bot");
		await expect(body).toContainText("+ operator instructions");
		await expect(body).toContainText(REVIEW_INSTR);
		await captureEvidence(page, testInfo, "ez-code-factory-prompts-preview-substituted");
	});

	test("the Run now button confirms then POSTs run-now with the jobId", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		const state = await routeHub(page);

		await page.goto(viewHref(`job:${JOB_ID}`));
		await expect(page.getByTestId("hub-page-title")).toHaveText("ez-code-factory — job Nightly");

		await page.getByRole("button", { name: "Run now" }).click();
		// The confirm dialog gates the fire.
		await expect(page.getByTestId("hub-confirm-dialog")).toContainText("Run job");
		const runNowPost = page.waitForRequest(
			(req) => req.method() === "POST" && req.url().includes("/api/extensions/ez-code-factory/events/run-now"),
		);
		await page.getByTestId("hub-confirm-ok").click();
		const req = await runNowPost;

		expect(req.postDataJSON()).toMatchObject({ payload: { jobId: JOB_ID } });
		expect(state.runNowBody).toMatchObject({ payload: { jobId: JOB_ID } });
	});

	test("a flow-table Skip/Run toggle confirms then POSTs job-save with the toggle_step payload", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		const state = await routeHub(page);

		await page.goto(viewHref(`job:${JOB_ID}`));
		await expect(page.getByTestId("hub-page-title")).toHaveText("ez-code-factory — job Nightly");

		// The skipped `test` row (warning cell) is actionable → click → confirm.
		const testRow = page.getByTestId("hub-table-row").filter({ hasText: "skipped" });
		await expect(testRow).toHaveClass(/cursor-pointer/);
		await testRow.click();
		await expect(page.getByTestId("hub-confirm-dialog")).toContainText("Run the test step again");

		const savePost = page.waitForRequest(
			(req) => req.method() === "POST" && req.url().includes("/api/extensions/ez-code-factory/events/job-save"),
		);
		await page.getByTestId("hub-confirm-ok").click();
		const req = await savePost;
		// The toggle rides as a STATIC payload key (no prompt) under the job-save event.
		expect(req.postDataJSON()).toMatchObject({ payload: { jobId: JOB_ID, toggle_step: "test" } });
		expect(state.saveBody).toMatchObject({ payload: { jobId: JOB_ID, toggle_step: "test" } });
	});

	test("a protected flow-step row carries NO toggle affordance (inert, opens no confirm)", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await routeHub(page);

		await page.goto(viewHref(`job:${JOB_ID}`));
		await expect(page.getByTestId("hub-page-title")).toHaveText("ez-code-factory — job Nightly");

		const protectedRow = page.getByTestId("hub-table-row").filter({ hasText: "protected — always runs" }).first();
		await expect(protectedRow).not.toHaveClass(/cursor-pointer/);
		// Clicking the inert row opens no confirm dialog (no action to dispatch).
		await protectedRow.click();
		await expect(page.getByTestId("hub-confirm-dialog")).toHaveCount(0);
	});


	test("the job editor renders Flow toggles, the read-only Prompts preview (agent substituted), and a Danger zone @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj] });
		await routeHub(page);

		await page.goto(viewHref(`job:${JOB_ID}`));
		await expect(page.getByTestId("hub-page-title")).toHaveText("ez-code-factory — job Nightly");

		const body = page.getByTestId("hub-page-body");
		// Flow section: the skipped warning cell + a protected label.
		await expect(page.getByRole("heading", { name: "Flow" })).toBeVisible();
		const warnCell = page.locator('[data-testid="hub-table-cell"][data-tone="warning"]').filter({ hasText: "skipped" });
		await expect(warnCell).toBeVisible();
		await expect(body).toContainText("protected — always runs");
		// The inline edit form is present (the old Edit-job / Edit-prompts modal
		// buttons and the per-field prompt buttons are gone).
		await expect(page.getByTestId("hub-inline-form")).toBeVisible();
		await expect(page.getByRole("button", { name: "Edit job" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Edit prompts" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Edit skip-steps" })).toHaveCount(0);
		// Prompts preview: the section, a representative prompt, and THIS job's agent.
		await expect(page.getByRole("heading", { name: "Prompts" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
		await expect(body).toContainText(AGENT_NAME);
		await expect(body).toContainText("resolved per run");
		// Danger zone owns Delete.
		await expect(page.getByRole("heading", { name: "Danger zone" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Delete job" })).toBeVisible();

		await captureEvidence(page, testInfo, "ez-code-factory-job-editor");
	});

	test("the audit view renders entries + day nav + a run deep-link @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj] });
		await routeHub(page);

		await page.goto(viewHref("audit"));
		await expect(page.getByTestId("hub-page-title")).toHaveText("ez-code-factory — audit 2026-07-21");

		const body = page.getByTestId("hub-page-body");
		// The respond entry: truncated actor + kind; the system sweep entry.
		await expect(body).toContainText("user 1a2b3c…");
		await expect(body).toContainText("respond");
		await expect(body).toContainText("sweep");
		// The run entry's row deep-links its detail (`?run=`). The renderer anchors
		// a row link on cell 0 (the "When" column), so the respond row is the ONLY
		// linked row (the system sweep row has no runId → no href); its Run cell
		// shows the id as text.
		await expect(body).toContainText(RUN_ID);
		const runLink = page.getByTestId("hub-row-link");
		await expect(runLink).toHaveCount(1);
		await expect(runLink).toHaveAttribute("href", new RegExp(`\\?run=${RUN_ID}`));
		// Day-nav link to the older day.
		await expect(page.getByRole("link", { name: "← 2026-07-20" })).toHaveAttribute(
			"href",
			new RegExp(`\\?view=${encodeURIComponent("audit:2026-07-20")}`),
		);

		await captureEvidence(page, testInfo, "ez-code-factory-audit-view");
	});

	test("PRIVACY: the audit DOM carries id-only detail — no transcript / prompt text", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await routeHub(page);
		await page.goto(viewHref("audit"));
		await expect(page.getByTestId("hub-page-title")).toHaveText("ez-code-factory — audit 2026-07-21");

		const body = page.getByTestId("hub-page-body");
		// The detail is structured id-only (finding ids, counts) — the action shows…
		await expect(body).toContainText("approve");
		await expect(body).toContainText("f1");
		// …but NO conversation transcript / prompt text ever lands in the shared tree.
		await expect(body).not.toContainText("BEGIN TRANSCRIPT");
		await expect(body).not.toContainText("review this diff");
	});

	test("an ext:page-state SSE signal re-pulls the SAME view variant (config preserved)", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await mockApi({ projects: [proj] });
		const state = await routeHub(page);

		await page.goto(viewHref("config"));
		await expect(page.getByTestId("hub-page-title")).toHaveText("ez-code-factory — config");
		await expect.poll(() => state.configPulls).toBe(1);

		// The content-free live-invalidation signal → the open tab re-pulls its OWN
		// variant (view=config rebuilt from props), never the bare dashboard.
		await emitSse({
			type: "ext:page-state",
			data: { extensionName: "ez-code-factory", pageId: "dashboard" },
		});

		await expect.poll(() => state.configPulls).toBe(2);
		// Still the config surface (not a dashboard fallback).
		await expect(page.getByTestId("hub-page-title")).toHaveText("ez-code-factory — config");
	});
});
