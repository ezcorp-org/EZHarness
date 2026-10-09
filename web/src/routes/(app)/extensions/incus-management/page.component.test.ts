import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import Page from "./+page.svelte";

afterEach(cleanup);

const environment = {
	installationId: "install-1", releaseId: "release-1", releaseGeneration: 1,
	connectionId: "connection-1", connectionRevision: 2, presetId: "persistent-web-compose.v1",
	label: "Local Incus", profile: "persistent-web-compose.v1", qualified: false,
	qualificationState: "not_qualified", qualificationRunId: null, qualificationValidUntil: null,
	blockedReason: "Qualification is required", setupId: null,
	limits: { memoryBytes: 4 * 1024 ** 3, cpuMillis: 2000, diskBytes: 20 * 1024 ** 3, pids: 256 },
};
const project = { id: "project-1", name: "Sample project" };
const bindingId = "binding-1";
const planDigest = "a".repeat(64);

test("shows connection identity in cards and environment choices with the same label", async () => {
	vi.stubGlobal("fetch", vi.fn(async () => response({
		environments: [{ ...environment, connectionId: "12345678-first" }, { ...environment, connectionId: "87654321-second" }],
		projects: [project], features: [],
	})));
	const view = render(Page, { props: { data: { operatorId: "admin-1" } } });
	await waitFor(() => expect(view.getByText("Connection 12345678")).toBeVisible());
	expect(view.getByText("Connection 87654321")).toBeVisible();
	const choices = view.getAllByRole("option");
	expect(choices[0]).toHaveTextContent("Connection 12345678");
	expect(choices[1]).toHaveTextContent("Connection 87654321");
});

function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function feature(state: string, operation: Record<string, unknown> | null = null) {
	return { projectId: project.id, projectName: project.name, bindingId, installationId: environment.installationId,
		releaseId: environment.releaseId, connectionId: environment.connectionId, connectionRevision: 2, generation: 1,
		presetId: environment.presetId, desiredState: state === "RUNNING" ? "RUNNING" : "STOPPED",
		observedState: state, operation, tombstonedAt: null as string | null, cleanupConfirmedAt: null as string | null };
}

function setup(options: { feature?: ReturnType<typeof feature> | null; features?: ReturnType<typeof feature>[]; failManagement?: boolean; loseApply?: boolean } = {}) {
	let currentFeature = options.feature ?? null;
	let qualified = false;
	let runId: string | null = null;
	const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
	vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
		if (body) calls.push({ url, body });
		if (url.endsWith("/management")) {
			if (options.failManagement) return response({ error: "Management service unavailable" }, 503);
			return response({ environments: [{ ...environment, qualified, qualificationState: qualified ? "qualified" : environment.qualificationState,
				qualificationRunId: runId, qualificationValidUntil: qualified ? "2027-01-01T00:00:00Z" : null, blockedReason: qualified ? null : environment.blockedReason }], projects: [project], features: options.features ?? (currentFeature ? [currentFeature] : []) });
		}
		if (url.endsWith("/probe-fixtures")) {
			if (body?.action === "plan") return response({ plan: { digest: planDigest, directory: "/srv/fixtures", profile: environment.profile,
				connectionRevision: 2, providerGeneration: 1, scope: { installationId: environment.installationId },
				config: { unqualifiedPresetId: "unqualified-preset", cases: { unsupported: { projectId: "project-unsupported", bindingId: "binding-unsupported", canaryPath: "/work/canary" } } } } });
			if (body?.action === "apply") {
				if (options.loseApply) { options.loseApply = false; throw new TypeError("reply lost"); }
				return response({ receipt: { state: "ready", planDigest } });
			}
			if (body?.action === "status") return response({ state: "ready", receipt: { state: "ready", planDigest } });
			return response({ receipt: { state: "cleaned", planDigest } });
		}
		if (url.endsWith("/qualification")) {
			qualified = true;
			runId = String(body?.operationId);
			return response({ run: { state: "AWAITING_RESTART" } }, 202);
		}
		if (url.endsWith("/features")) {
			if (body?.action === "prepareProject") return response({ project, binding: { id: bindingId } });
			if (body?.action === "create") currentFeature = feature("STOPPED", { id: "create-1", kind: "CREATE", state: "SUCCEEDED" });
			if (body?.action === "start") currentFeature = feature("RUNNING", { id: "start-1", kind: "START", state: "SUCCEEDED" });
			if (body?.action === "stop") currentFeature = feature("STOPPED", { id: "stop-1", kind: "STOP", state: "SUCCEEDED" });
			if (body?.action === "destroy") currentFeature = { ...feature("ABSENT", { id: "destroy-1", kind: "DESTROY", state: "SUCCEEDED" }), tombstonedAt: "2026-09-25T00:00:00Z", cleanupConfirmedAt: "2026-09-25T00:00:01Z" };
			if (body?.action === "reconcile") return response({ reconciled: 1 });
			return response({ state: "DISPATCHED" }, 202);
		}
		return response({});
	}));
	return { calls };
}

beforeEach(() => {
	localStorage.clear();
	vi.restoreAllMocks();
});

describe("Incus management page", () => {
	test("guides qualification and manages a named sandbox lifecycle", async () => {
		const { calls } = setup();
		const view = render(Page, { props: { data: { operatorId: "admin-1" } } });
		await waitFor(() => expect(view.getByText("Local Incus")).toBeInTheDocument());
		await fireEvent.click(view.getByRole("button", { name: "Prepare qualification…" }));
		await waitFor(() => expect(view.getByTestId("qualification-workflow")).toContainHTML("project-unsupported"));
		expect(view.getByTestId("qualification-workflow")).toHaveTextContent("/work/canary");
		await fireEvent.click(view.getByRole("checkbox", { name: /I reviewed this plan/ }));
		await fireEvent.click(view.getByRole("button", { name: "Apply reviewed fixture plan" }));
		await waitFor(() => expect(view.getByText("Operator fixtures are ready")).toBeInTheDocument());
		await fireEvent.click(view.getByRole("checkbox", { name: /host is ready/ }));
		await fireEvent.click(view.getByRole("button", { name: "Run live qualification" }));
		await waitFor(() => expect(view.getByText("Qualified", { exact: true })).toBeInTheDocument());
		await fireEvent.change(view.getByRole("textbox", { name: "New project name" }), { target: { value: project.name } });
		await fireEvent.click(view.getByRole("button", { name: "Create project sandbox" }));
		await waitFor(() => expect(view.getByRole("heading", { name: project.name })).toBeInTheDocument());
		await fireEvent.click(view.getByRole("button", { name: "Start" }));
		await waitFor(() => expect(view.getByRole("link", { name: "Open chat" })).toBeInTheDocument());
		await fireEvent.click(view.getByRole("button", { name: "Stop" }));
		await waitFor(() => expect(view.queryByRole("link", { name: "Open chat" })).not.toBeInTheDocument());
		await fireEvent.click(view.getByRole("button", { name: "Dispose…" }));
		await fireEvent.click(view.getByRole("button", { name: "Dispose sandbox" }));
		await waitFor(() => expect(view.getByText("Disposed")).toBeInTheDocument());
		await fireEvent.click(view.getByRole("button", { name: "Remove qualification fixtures" }));
		await waitFor(() => expect(view.getByRole("status")).toHaveTextContent("Temporary operator fixtures were removed"));
		expect(calls.map(call => call.body?.action)).toContain("cleanup");
	});

	test("shows load errors and blocks execution for unknown state", async () => {
		setup({ failManagement: true });
		const errorView = render(Page, { props: { data: { operatorId: "admin-1" } } });
		await waitFor(() => expect(errorView.getByRole("alert")).toHaveTextContent("Management service unavailable"));
		cleanup();
		setup({ feature: feature("UNKNOWN", { id: "op-1", kind: "START", state: "OUTCOME_UNKNOWN" }) });
		const view = render(Page, { props: { data: { operatorId: "admin-1" } } });
		await waitFor(() => expect(view.getByText("Needs reconciliation")).toBeInTheDocument());
		expect(view.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
		expect(view.queryByRole("link", { name: "Open chat" })).not.toBeInTheDocument();
	});

	for (const state of ["UNKNOWN", "ERROR"]) {
		test(`failed CREATE ${state} requires operator recovery but permits saved status refresh`, async () => {
			const { calls } = setup({ feature: feature(state, { id: "failed-create", kind: "CREATE", state: "FAILED" }) });
			const view = render(Page, { props: { data: { operatorId: "admin-1" } } });
			await waitFor(() => expect(view.getByText("Operator recovery required")).toBeVisible());
			expect(view.getByText("This CREATE failed. Contact an operator for recovery before another lifecycle action.")).toBeVisible();
			expect(view.queryByRole("button", { name: "Reconcile pending work" })).not.toBeInTheDocument();
			expect(view.queryByRole("button", { name: "Create guest" })).not.toBeInTheDocument();
			await fireEvent.click(view.getByRole("button", { name: "Refresh status" }));
			await waitFor(() => expect(calls.map(call => call.body?.action)).toEqual(["status"]));
			expect(view.getByText("Operator recovery required")).toBeVisible();
		});
	}

	for (const operationState of ["PROVIDER_PENDING", "OUTCOME_UNKNOWN"]) {
		test(`mixed failed CREATE and ${operationState} retain reconciliation`, async () => {
			const { calls } = setup({ features: [feature("UNKNOWN", { id: "failed-create", kind: "CREATE", state: "FAILED" }),
				{ ...feature("UNKNOWN", { id: "pending-start", kind: "START", state: operationState }), bindingId: "pending-binding", projectId: "pending-project", projectName: "Pending sandbox" }] });
			const view = render(Page, { props: { data: { operatorId: "admin-1" } } });
			await waitFor(() => expect(view.getByText("Operator recovery required")).toBeVisible());
			expect(view.getByText("Refresh or reconcile the saved operation before another lifecycle action.")).toBeVisible();
			await fireEvent.click(view.getByRole("button", { name: "Reconcile pending work" }));
			await waitFor(() => expect(calls.map(call => call.body?.action)).toEqual(["reconcile"]));
		});
	}

	test("a settled failed CREATE no longer asks for operator recovery", async () => {
		setup({ feature: { ...feature("ABSENT", { id: "failed-create", kind: "CREATE", state: "FAILED" }), tombstonedAt: "2026-10-09T00:00:00Z", cleanupConfirmedAt: "2026-10-09T00:00:01Z" } });
		const view = render(Page, { props: { data: { operatorId: "admin-1" } } });
		await waitFor(() => expect(view.getByText("Disposed")).toBeVisible());
		expect(view.queryByText("Operator recovery required")).not.toBeInTheDocument();
		expect(view.queryByRole("button", { name: "Reconcile pending work" })).not.toBeInTheDocument();
	});

	test("resumes an unrecorded qualification with its saved operation ID", async () => {
		const operationId = "11111111-1111-4111-8111-111111111111";
		const environmentKey = `${environment.installationId}:${environment.releaseId}:${environment.releaseGeneration}:${environment.connectionId}:${environment.connectionRevision}:${environment.presetId}`;
		localStorage.setItem("ezharness-incus:admin-1:qualification-draft", JSON.stringify({
			environmentKey, operationId, planDigest, phase: "running", planSteps: 1, startedAt: 1,
			scope: { installationId: environment.installationId, releaseId: environment.releaseId, connectionId: environment.connectionId, presetId: environment.presetId },
		}));
		const { calls } = setup();
		const view = render(Page, { props: { data: { operatorId: "admin-1" } } });
		await waitFor(() => expect(view.getByText("Operator fixtures are ready")).toBeInTheDocument());
		await fireEvent.click(view.getByRole("checkbox", { name: /host is ready/ }));
		await fireEvent.click(view.getByRole("button", { name: "Run live qualification" }));
		await waitFor(() => expect(calls.some(call => call.url.endsWith("/qualification"))).toBe(true));
		expect(calls.find(call => call.url.endsWith("/qualification"))?.body?.operationId).toBe(operationId);
	});

	test("checks saved fixture status after an apply reply is lost", async () => {
		const { calls } = setup({ loseApply: true });
		const view = render(Page, { props: { data: { operatorId: "admin-1" } } });
		await waitFor(() => expect(view.getByText("Local Incus")).toBeInTheDocument());
		await fireEvent.click(view.getByRole("button", { name: "Prepare qualification…" }));
		await waitFor(() => expect(view.getByTestId("qualification-workflow")).toContainHTML("project-unsupported"));
		await fireEvent.click(view.getByRole("checkbox", { name: /I reviewed this plan/ }));
		await fireEvent.click(view.getByRole("button", { name: "Apply reviewed fixture plan" }));
		await waitFor(() => expect(view.getByText("Operator fixtures are ready")).toBeInTheDocument());
		expect(calls.map(call => call.body?.action)).toEqual(["plan", "apply", "status"]);
		expect(view.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
	});
});


test("expires idle admission locally and reloads; clears timers on unmount", async () => {
	const now = new Date("2026-10-08T14:00:00Z");
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	vi.setSystemTime(now);
	let reads = 0;
	vi.stubGlobal("fetch", vi.fn(async () => {
		reads += 1;
		if (reads > 1) throw new Error("Readiness unavailable");
		return response({ environments: [{ ...environment, qualified: true, qualificationState: "qualified",
			qualificationValidUntil: "2026-10-08T14:00:10Z" }], projects: [project], features: [] });
	}));
	try {
		const view = render(Page, { props: { data: { operatorId: "admin-1" } } });
		await vi.advanceTimersByTimeAsync(0);
		expect(view.getByText("Qualified", { exact: true })).toBeVisible();
		await vi.advanceTimersByTimeAsync(9_999);
		expect(reads).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(view.getByText("Not qualified", { exact: true })).toBeVisible();
		expect(reads).toBe(2);
		expect(view.getByRole("button", { name: "Create project sandbox" })).toBeDisabled();
		view.unmount();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(reads).toBe(2);
	} finally { vi.useRealTimers(); }
});

test.each(["readiness_unavailable", "capacity_full"])("offers readonly retry for %s", async admissionReason => {
	vi.stubGlobal("fetch", vi.fn(async () => response({ environments: [{ ...environment, admissionReason }], projects: [], features: [] })));
	const view = render(Page, { props: { data: { operatorId: "admin-1" } } });
	await waitFor(() => expect(view.getByRole("button", { name: "Retry readiness" })).toBeVisible());
	expect(view.queryByRole("button", { name: "Prepare qualification…" })).not.toBeInTheDocument();
});


test("rejects an expired server deadline and refreshes on focus", async () => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	vi.setSystemTime(new Date("2026-10-08T14:00:00Z"));
	let reads = 0;
	vi.stubGlobal("fetch", vi.fn(async () => {
		reads += 1;
		return response({ environments: [{ ...environment, qualified: true, qualificationState: "qualified",
			qualificationValidUntil: "2026-10-08T13:59:00Z" }], projects: [], features: [] });
	}));
	try {
		const view = render(Page, { props: { data: { operatorId: "admin-1" } } });
		await vi.advanceTimersByTimeAsync(0);
		expect(view.getByText("Not qualified", { exact: true })).toBeVisible();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(reads).toBe(1);
		await fireEvent.focus(window);
		await vi.advanceTimersByTimeAsync(0);
		expect(reads).toBe(2);
		view.unmount();
		await fireEvent.focus(window);
		expect(reads).toBe(2);
	} finally { vi.useRealTimers(); }
});


test.each([null, "invalid", "2026-10-08T13:59:00Z"])("denies incomplete or expired admission deadline %s", async qualificationValidUntil => {
	vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-08T14:00:00Z"));
	vi.stubGlobal("fetch", vi.fn(async () => response({ environments: [{ ...environment, qualified: true,
		qualificationState: "qualified", qualificationValidUntil }], projects: [], features: [] })));
	const view = render(Page, { props: { data: { operatorId: "admin-1" } } });
	await waitFor(() => expect(view.container.querySelector(".environment-card .pill")).toHaveTextContent("Not qualified"));
	expect(view.getByRole("button", { name: "Retry readiness" })).toBeVisible();
	expect(view.getByRole("button", { name: "Create project sandbox" })).toBeDisabled();
});
