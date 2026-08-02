import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeWorkflow, makeAgent } from "./fixtures/data.js";

// Drives the two deterministic demo workflows (demo-deterministic and
// demo-loop-counter) through the real UI. The definitions mirror the shipped
// src/agents/*.workflow.yaml; the run itself is served via the mocked run
// endpoint + SSE (the same transport the app uses), so this asserts the
// browser-only surface: per-step status rendering and the loop iteration
// count. The UI rename + new step-form fields are a frontend-visual change,
// so the final test is `@evidence`-tagged and captures screenshots.

const demoDeterministic = makeWorkflow({
	name: "demo-deterministic",
	description: "Zero-LLM reshape + gate + publish; identical input ⇒ identical output.",
	steps: [
		{ name: "compose", kind: "transform", output: { headline: "Report on {{$input.topic}}" } },
		{ name: "assert-composed", kind: "gate", dependsOn: ["compose"], condition: { ref: "$steps.compose.output.headline", op: "contains", value: "Report on" } },
		{ name: "publish", kind: "transform", dependsOn: ["assert-composed"], output: { headline: "$steps.compose.output.headline" } },
	] as any,
});

const demoLoopCounter = makeWorkflow({
	name: "demo-loop-counter",
	description: "A transform loop that counts to 3 via $loop.iteration / $loop.last.",
	steps: [
		{
			name: "count",
			kind: "transform",
			output: { n: "$loop.iteration", previous: "$loop.last.output.n" },
			loop: { maxIterations: 5, onExhausted: "fail" },
		},
	] as any,
});

// A mixed-model workflow: a cheap extractor, an expensive verifier, and a
// step that inherits the definition-level default. Exercises the per-step
// model bindings the detail page now renders.
const tieredFactory = makeWorkflow({
	name: "tiered-factory",
	description: "A cheap extract, a default-tier draft, and an expensive verify.",
	defaultModel: { provider: "anthropic", model: "claude-sonnet-5" },
	steps: [
		{ name: "extract", agent: "summarizer", model: { provider: "anthropic", model: "claude-haiku-4-5-20251001" } },
		{ name: "draft", agent: "summarizer", dependsOn: ["extract"] },
		{
			name: "verify",
			agent: "summarizer",
			dependsOn: ["draft"],
			model: { provider: "anthropic", model: "claude-opus-5", maxTokens: 8000, effort: "high" },
		},
	] as any,
});

test.describe("Workflow demos — run through the UI", () => {
	test("demo-deterministic reports per-step success in Run History", async ({ page, mockApi, emitSse }) => {
		await mockApi({ workflows: [demoDeterministic] });
		await page.route("**/api/workflows/demo-deterministic/run", (route) =>
			route.fulfill({
				json: { id: "wr-det", workflowName: "demo-deterministic", status: "running", startedAt: Date.now(), steps: [] },
			}),
		);

		await page.goto("/workflows/demo-deterministic");
		await page.getByLabel("JSON Input").fill('{"topic": "workflows"}');
		await page.getByRole("button", { name: "Run Workflow" }).click();

		// Real executor emits start (registers the run) before the terminal
		// event updates it — mirror that order so the run is in the store.
		await emitSse({
			type: "workflow:start",
			data: {
				workflowRun: {
					id: "wr-det-9999",
					workflowName: "demo-deterministic",
					status: "running",
					startedAt: Date.now(),
					steps: [],
				},
			},
		});
		await emitSse({
			type: "workflow:complete",
			data: {
				workflowRun: {
					id: "wr-det-9999",
					workflowName: "demo-deterministic",
					status: "success",
					startedAt: Date.now() - 20,
					finishedAt: Date.now(),
					steps: [
						{ stepName: "compose", runId: "", status: "success" },
						{ stepName: "assert-composed", runId: "", status: "success" },
						{ stepName: "publish", runId: "", status: "success" },
					],
				},
			},
		});

		await expect(page.getByRole("heading", { name: "Run History" })).toBeVisible();
		// All three steps plus the run itself render "success".
		await expect(page.getByText("success", { exact: true })).toHaveCount(4);
	});

	test("demo-loop-counter reports iterations: 3 for its looped step", async ({ page, mockApi, emitSse }) => {
		await mockApi({ workflows: [demoLoopCounter] });
		await page.route("**/api/workflows/demo-loop-counter/run", (route) =>
			route.fulfill({
				json: { id: "wr-loop", workflowName: "demo-loop-counter", status: "running", startedAt: Date.now(), steps: [] },
			}),
		);

		await page.goto("/workflows/demo-loop-counter");
		await page.getByLabel("JSON Input").fill("{}");
		await page.getByRole("button", { name: "Run Workflow" }).click();

		await emitSse({
			type: "workflow:start",
			data: {
				workflowRun: {
					id: "wr-loop-777",
					workflowName: "demo-loop-counter",
					status: "running",
					startedAt: Date.now(),
					steps: [],
				},
			},
		});
		await emitSse({
			type: "workflow:complete",
			data: {
				workflowRun: {
					id: "wr-loop-777",
					workflowName: "demo-loop-counter",
					status: "success",
					startedAt: Date.now() - 30,
					finishedAt: Date.now(),
					steps: [{ stepName: "count", runId: "", status: "success", iterations: 3 }],
				},
			},
		});

		await expect(page.getByRole("heading", { name: "Run History" })).toBeVisible();
		await expect(page.getByText("(3 iterations)")).toBeVisible();
		await expect(page.getByText("count", { exact: false }).first()).toBeVisible();
	});

	test("workflows list, builder, and a completed loop run render correctly @evidence", async ({ page, mockApi, emitSse }, testInfo) => {
		// 1) List view with both demos.
		await mockApi({
			workflows: [demoDeterministic, demoLoopCounter],
			agents: [makeAgent({ name: "summarizer" })],
		});
		await page.goto("/workflows");
		await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
		await expect(page.getByText("demo-loop-counter")).toBeVisible();
		await captureEvidence(page, testInfo, "workflows-list");

		// 2) Builder (New Workflow) with the new step-kind fields. Assert we
		//    actually landed on the builder (rather than silently skipping the
		//    evidence capture when the route redirects elsewhere).
		const newResp = await page.goto("/workflows/new");
		expect(newResp ? new URL(newResp.url()).pathname : "").toBe("/workflows/new");
		await expect(page.getByRole("heading", { name: "New Workflow" })).toBeVisible();
		await expect(page.getByLabel("Kind")).toBeVisible();
		await captureEvidence(page, testInfo, "workflows-new-builder");

		// 3) Run-detail view with a completed loop run (per-step status + iterations).
		await page.route("**/api/workflows/demo-loop-counter/run", (route) =>
			route.fulfill({
				json: { id: "wr-ev", workflowName: "demo-loop-counter", status: "running", startedAt: Date.now(), steps: [] },
			}),
		);
		await page.goto("/workflows/demo-loop-counter");
		await page.getByLabel("JSON Input").fill("{}");
		await page.getByRole("button", { name: "Run Workflow" }).click();
		await emitSse({
			type: "workflow:start",
			data: {
				workflowRun: {
					id: "wr-ev-42",
					workflowName: "demo-loop-counter",
					status: "running",
					startedAt: Date.now(),
					steps: [],
				},
			},
		});
		await emitSse({
			type: "workflow:complete",
			data: {
				workflowRun: {
					id: "wr-ev-42",
					workflowName: "demo-loop-counter",
					status: "success",
					startedAt: Date.now() - 30,
					finishedAt: Date.now(),
					steps: [{ stepName: "count", runId: "", status: "success", iterations: 3 }],
				},
			},
		});
		await expect(page.getByText("(3 iterations)")).toBeVisible();
		await captureEvidence(page, testInfo, "workflows-run-detail");

		// 4) Failed run: the loud error MESSAGE (until-exhaustion) renders on
		//    the detail page — the loud-failure pillar's visible end.
		//    (workflow:error only updates runs already registered via start.)
		await emitSse({
			type: "workflow:start",
			data: {
				workflowRun: {
					id: "wr-ev-43",
					workflowName: "demo-loop-counter",
					status: "running",
					startedAt: Date.now() - 30,
					steps: [],
				},
			},
		});
		await emitSse({
			type: "workflow:error",
			data: {
				workflowRun: {
					id: "wr-ev-43",
					workflowName: "demo-loop-counter",
					status: "error",
					startedAt: Date.now() - 30,
					finishedAt: Date.now(),
					steps: [{ stepName: "count", runId: "", status: "error", iterations: 5 }],
					result: {
						success: false,
						output: null,
						error: 'Step "count" exhausted 5 iterations without meeting its until-condition',
					},
				},
			},
		});
		await expect(
			page.getByText('Step "count" exhausted 5 iterations without meeting its until-condition'),
		).toBeVisible();
		await captureEvidence(page, testInfo, "workflows-run-failure-detail");

		// 5) Approval-blocked run: `awaiting_approval` is neither success
		//    nor error. Regression — the detail page's message renderer used
		//    to test `status !== "error" && status !== "cancelled"`, so this
		//    status fell into the "nothing to show" branch and the operator
		//    saw a bare status chip with no hint of WHICH step needed
		//    approving. That message is the only actionable text on the page.
		await emitSse({
			type: "workflow:start",
			data: {
				workflowRun: {
					id: "wr-ev-44",
					workflowName: "demo-loop-counter",
					status: "running",
					startedAt: Date.now() - 20,
					steps: [],
				},
			},
		});
		await emitSse({
			type: "workflow:error",
			data: {
				workflowRun: {
					id: "wr-ev-44",
					workflowName: "demo-loop-counter",
					status: "awaiting_approval",
					startedAt: Date.now() - 20,
					finishedAt: Date.now(),
					steps: [
						{ stepName: "prep", runId: "", status: "success" },
						{ stepName: "install", runId: "", status: "awaiting_approval" },
					],
					result: {
						success: false,
						output: null,
						error: {
							code: "awaiting_approval",
							message:
								'Step "install" requires interactive approval for capability fs.write and cannot run in a workflow',
						},
					},
				},
			},
		});
		await expect(
			page.getByText(
				'Step "install" requires interactive approval for capability fs.write and cannot run in a workflow',
			),
		).toBeVisible();
		// The run must never read as a success on this surface.
		await expect(page.getByText("awaiting_approval").first()).toBeVisible();
		await captureEvidence(page, testInfo, "workflows-run-awaiting-approval-detail");
	});

	test("per-step model bindings render on the definition and on the finished run @evidence", async ({ page, mockApi, emitSse }, testInfo) => {
		// C1 per-step model overrides, end to end on the surface a user sees:
		// the DEFINITION card shows what each step is bound to (including the
		// step that merely inherits `defaultModel`), and the run history shows
		// what each step actually RESOLVED to. Without the second half a user
		// has no way to confirm the cheap step really ran cheap.
		await mockApi({
			workflows: [tieredFactory],
			agents: [makeAgent({ name: "summarizer" })],
		});
		await page.route("**/api/workflows/tiered-factory/run", (route) =>
			route.fulfill({
				json: { id: "wr-tier", workflowName: "tiered-factory", status: "running", startedAt: Date.now(), steps: [] },
			}),
		);

		await page.goto("/workflows/tiered-factory");

		// Declared bindings, one chip per agent step.
		const chips = page.getByTestId("step-model");
		await expect(chips).toHaveCount(3);
		await expect(chips.nth(0)).toHaveText("anthropic/claude-haiku-4-5-20251001");
		// The middle step declares nothing and inherits the workflow default.
		await expect(chips.nth(1)).toHaveText("anthropic/claude-sonnet-5");
		await expect(chips.nth(2)).toHaveText("anthropic/claude-opus-5 · 8000 tok · high");
		await captureEvidence(page, testInfo, "workflow-step-model-bindings");

		// A finished run reports the model each step actually resolved to.
		await page.getByLabel("JSON Input").fill('{"topic": "release notes"}');
		await page.getByRole("button", { name: "Run Workflow" }).click();
		await emitSse({
			type: "workflow:start",
			data: {
				workflowRun: {
					id: "wr-tier-1",
					workflowName: "tiered-factory",
					status: "running",
					startedAt: Date.now(),
					steps: [],
				},
			},
		});
		await emitSse({
			type: "workflow:complete",
			data: {
				workflowRun: {
					id: "wr-tier-1",
					workflowName: "tiered-factory",
					status: "success",
					startedAt: Date.now() - 40,
					finishedAt: Date.now(),
					steps: [
						{ stepName: "extract", runId: "r1", status: "success", provider: "anthropic", model: "claude-haiku-4-5-20251001" },
						{ stepName: "draft", runId: "r2", status: "success", provider: "anthropic", model: "claude-sonnet-5" },
						{ stepName: "verify", runId: "r3", status: "success", provider: "anthropic", model: "claude-opus-5" },
					],
				},
			},
		});

		const ranOn = page.getByTestId("step-ran-on");
		await expect(ranOn).toHaveCount(3);
		await expect(ranOn.nth(0)).toHaveText("on anthropic/claude-haiku-4-5-20251001");
		await expect(ranOn.nth(2)).toHaveText("on anthropic/claude-opus-5");
		await captureEvidence(page, testInfo, "workflow-run-resolved-models");
	});

	test("builder submit with no name renders the validation error (no silent no-op) @evidence", async ({ page, mockApi }, testInfo) => {
		// Pins WorkflowBuilder's handleSubmit error branch — the
		// `result.error !== null` union discrimination (svelte-check fix at
		// the origin/main merge): an invalid form renders
		// buildWorkflowPayload's first failure instead of calling onsubmit.
		// Mirrors workflows-new.spec.ts's (unwired-lane) coverage of the same
		// path; lives HERE because this spec is the covers-map entry credited
		// for WorkflowBuilder.svelte edits.
		await mockApi({ agents: [makeAgent({ name: "summarizer" })], workflows: [] });

		const response = await page.goto("/workflows/new");
		const finalUrl = response ? new URL(response.url()).pathname : "";
		test.skip(finalUrl !== "/workflows/new", "auth gate redirected away from /workflows/new in this environment");

		await page.getByLabel("Agent").selectOption("summarizer");
		await page.getByRole("button", { name: "Save Workflow" }).click();
		await expect(page.getByText("Workflow name is required")).toBeVisible({ timeout: 3000 });

		await captureEvidence(page, testInfo, "workflow-builder-validation-error");
	});
});

test.describe("Workflow editing — visual", () => {
	// The inline editor, the tool step picker and the manage-gated header
	// actions are all new visual surface on `/workflows/**` and the two
	// builder components, which this spec already covers in
	// e2e/evidence-covers.json.
	const editable = makeWorkflow({
		name: "report-flow",
		description: "Compose a headline, gate it, then publish.",
		steps: [
			{ name: "compose", kind: "transform", output: { headline: "Report on {{$input.topic}}" } },
			{ name: "gate-it", kind: "gate", dependsOn: ["compose"], condition: { ref: "$steps.compose.output.headline", op: "contains", value: "Report on" } },
			{ name: "summarize", agent: "summarizer", dependsOn: ["gate-it"], input: { text: "$prev.output.headline" } },
		] as any,
	});

	test("detail actions, the inline editor and a tool step render correctly @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ workflows: [editable], agents: [makeAgent({ name: "summarizer" })] });
		// Registered AFTER mockApi: Playwright matches routes in reverse
		// registration order, so an earlier handler would lose to mockApi's
		// own /api/extensions response and the picker would render empty.
		await page.route("**/api/extensions", (route) =>
			route.request().method() === "GET"
				? route.fulfill({
						json: [
							{ id: "notes", name: "Notes", manifest: { tools: [{ name: "add_note", description: "Append a note" }] } },
							{ id: "publisher", name: "Publisher", manifest: { tools: [{ name: "publish" }] } },
						],
					})
				: route.fallback(),
		);

		// 1) Read-only detail with the manage-gated Edit / Duplicate / Delete row.
		const resp = await page.goto("/workflows/report-flow");
		expect(resp ? new URL(resp.url()).pathname : "").toBe("/workflows/report-flow");
		await expect(page.getByTestId("workflow-steps-view")).toBeVisible();
		await expect(page.getByTestId("workflow-edit")).toBeVisible();
		await captureEvidence(page, testInfo, "workflow-detail-actions");

		// 2) The inline editor, prefilled from the stored definition. The Run
		//    panel is deliberately gone while editing.
		await page.getByTestId("workflow-edit").click();
		await expect(page.getByRole("heading", { name: "Editing report-flow" })).toBeVisible();
		await expect(page.getByLabel("Workflow Name")).toHaveValue("report-flow");
		await expect(page.getByRole("heading", { name: "Run Workflow" })).toBeHidden();
		await captureEvidence(page, testInfo, "workflow-inline-editor");

		// 3) A tool step: the kind picker's new option and the grouped
		//    extension-tool select it reveals.
		await page.getByRole("button", { name: "+ Add Step" }).click();
		await page.getByLabel("Kind").last().selectOption("tool");
		const toolSelect = page.getByTestId("step-tool-select");
		await expect(toolSelect).toBeVisible();
		await toolSelect.selectOption("notes__add_note");
		await captureEvidence(page, testInfo, "workflow-tool-step");
	});

	test("a read-only YAML workflow offers Duplicate only @evidence", async ({ page, mockApi }, testInfo) => {
		// The four shipped demos are files on disk — Edit/Delete would 404,
		// so the header must offer the one action that does work.
		await mockApi({
			workflows: [makeWorkflow({ ...demoDeterministic, source: "yaml", canManage: false })],
			agents: [makeAgent({ name: "summarizer" })],
		});
		const resp = await page.goto("/workflows/demo-deterministic");
		expect(resp ? new URL(resp.url()).pathname : "").toBe("/workflows/demo-deterministic");

		await expect(page.getByTestId("workflow-duplicate")).toBeVisible();
		await expect(page.getByTestId("workflow-edit")).toHaveCount(0);
		await expect(page.getByTestId("workflow-delete")).toHaveCount(0);
		await captureEvidence(page, testInfo, "workflow-readonly-detail");
	});
});
