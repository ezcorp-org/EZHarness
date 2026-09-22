import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { FactoryRunInspection, FactoryRunSummary } from "@ezcorp/factory-sdk/types";
import FactoryRunInspector from "./FactoryRunInspector.svelte";
import { FACTORY_STREAM_LABELS, appendUnique, formatBytes, formatMicros, shortDigest, streamSummary } from "./run-format";
import { FactoryApiClientError, type FactoryRunControlApi, type FactoryRunInspectorApi } from "./client";

const digest = `sha256:${"a".repeat(64)}`;
const summary = (runId: string, status: FactoryRunSummary["status"] = "running"): FactoryRunSummary => ({ runId, factoryId: `factory-${runId}`, factoryVersion: "1.0.0", definitionDigest: digest, grantRevision: 1, revision: 3, status, createdAtMs: 1, updatedAtMs: 2 });
const encoder = new TextEncoder();

function inspection(runId: string, overrides: Partial<FactoryRunInspection> = {}): FactoryRunInspection {
	return {
		run: { ...summary(runId), parameters: {} },
		cursor: { token: `cursor-${runId}`, sequence: 5, expiresAtMs: 9 },
		projectionLag: 0,
		children: { items: [{ runId: "child-1", factoryId: "child-factory", factoryVersion: "2.0.0", state: "open", status: "running", deadlineMs: 9 }], nextCursor: "children-2" },
		attempts: { items: [{ attemptId: "a-1", nodeInstanceId: "node-one", attemptNumber: 1, candidateGeneration: 0, status: "completed", startedAtMs: 1, updatedAtMs: 2, resultDigest: `sha256:${"b".repeat(64)}` }, { attemptId: "a-2", nodeInstanceId: "node-two", attemptNumber: 2, candidateGeneration: 1, status: "failed", startedAtMs: 1, updatedAtMs: 2 }], nextCursor: "attempts-2" },
		artifacts: { items: [{ artifactId: "artifact-1", kind: "candidate_output", digest, encodedBytes: 2048, nodeInstanceId: "node-one", createdAtMs: 1 }, { artifactId: "artifact-2", kind: "material", digest, encodedBytes: 12, createdAtMs: 2 }], nextCursor: "artifacts-2" },
		blockers: [
			{ kind: "approval", id: "approval-1", nodeInstanceId: "review", reason: "Waiting for an approval decision", sinceMs: 1 },
			{ kind: "release", id: "operation-1", reason: "Release outcome is uncertain and needs reconciliation", sinceMs: 1 },
			{ kind: "budget", id: "envelope-1", reason: "Budget admission is blocked", sinceMs: 0 },
		],
		costs: { limitMicros: "2500000", allocatedMicros: "1000000", spentMicros: "1234567", knownCostMicros: "1234567", unknownCostMicros: "10", admissionBlocked: true, uncertain: true },
		acceptance: [
			{ commandId: "c-1", decision: "rejected", candidateDigest: digest, reasons: [{ claimId: "tests-pass", validatorId: "v-tests", verdict: "FAIL", reasonCode: "TESTS_FAILED" }], groupFailures: [{ groupId: "quality", passes: 1, minimumPasses: 2 }], decidedAtMs: 1 },
			{ commandId: "c-2", decision: "accepted", candidateDigest: digest, reasons: [], groupFailures: [], decidedAtMs: 2 },
		],
		releases: [
			{ operationId: "operation-1", nodeInstanceId: "publish", state: "uncertain", action: "factory.release.publish", dispatchGeneration: 2, outcomeCode: "provider_timeout" },
			{ operationId: "operation-2", nodeInstanceId: "publish", state: "succeeded", action: "factory.release.publish", dispatchGeneration: 1 },
			{ operationId: "operation-3", nodeInstanceId: "publish", state: "failed", action: "factory.release.publish", dispatchGeneration: 1 },
			{ operationId: "operation-4", nodeInstanceId: "publish", state: "pending", action: "factory.release.publish", dispatchGeneration: 0 },
		],
		...overrides,
	};
}

const frames = (...text: string[]) => new ReadableStream<Uint8Array>({ start(controller) { for (const item of text) controller.enqueue(encoder.encode(item)); controller.close(); } });
const event = (sequence: number, payload = true) => `id: t-${sequence}\nevent: factory:run-event\ndata: ${JSON.stringify({ schemaVersion: "factory.run-event.v1", runId: "r", sequence, eventId: "e".repeat(64), payloadBytes: 1500, ...(payload ? { payload: {} } : {}) })}\n\n`;
const drained = (sequence: number) => `id: t-${sequence}\nevent: factory:run-status\ndata: {"status":"succeeded","sequence":${sequence},"drained":true}\n\nevent: factory:stream-closed\ndata: {"reason":"drained"}\n\n`;

function api(overrides: Partial<FactoryRunInspectorApi & FactoryRunControlApi> = {}): FactoryRunInspectorApi & FactoryRunControlApi {
	return {
		listRuns: vi.fn(async () => ({ items: [summary("run-1"), summary("run-2", "succeeded")], nextCursor: "runs-2" })),
		inspectRun: vi.fn(async (_project: string, runId: string) => inspection(runId)),
		inspectRunSection: vi.fn(async (_project: string, _run: string, query) => {
			if (query.section === "attempts") return { section: "attempts" as const, page: { items: [{ attemptId: "a-3", nodeInstanceId: query.search ?? "node-three", attemptNumber: 1, candidateGeneration: 0, status: "stopped", startedAtMs: 1, updatedAtMs: 2 }] } };
			if (query.section === "children") return { section: "children" as const, page: { items: [{ runId: "child-2", factoryId: "child-factory", factoryVersion: "2.0.0", state: "settled", deadlineMs: 9 }] } };
			return { section: "artifacts" as const, page: { items: [{ artifactId: "artifact-3", kind: "partition", digest, encodedBytes: 3 * 1024 * 1024, createdAtMs: 3 }] } };
		}),
		openRunEvents: vi.fn(async () => frames(event(6), event(7, false), drained(7))),
		artifactTicket: vi.fn(async () => ({ url: "/download?ticket=x", expiresAtMs: 1, mediaType: "application/octet-stream", encodedBytes: 4 })),
		artifactBytes: vi.fn(async () => encoder.encode("text")),
		getRun: vi.fn(async (_project: string, runId: string) => ({ ...summary(runId), parameters: {} })),
		controlRun: vi.fn(),
		...overrides,
	};
}

afterEach(() => { vi.restoreAllMocks(); });

describe("stream helpers", () => {
	test("labels and summaries say what the stream has seen, in plain words", () => {
		expect(Object.keys(FACTORY_STREAM_LABELS).sort()).toEqual(["catching-up", "connecting", "ended", "lagging", "live", "offline", "reconnecting", "revoked"]);
		expect(streamSummary({ state: "live", applied: 4, duplicates: 0, gaps: 0, reconnects: 0, lag: 0 })).toBe("sequence 4");
		expect(streamSummary({ state: "lagging", applied: 4, duplicates: 1, gaps: 1, reconnects: 1, lag: 1 })).toBe("sequence 4 · 1 event not yet in status · 1 duplicate ignored · 1 gap recovered · 1 reconnect");
		expect(streamSummary({ state: "lagging", applied: 4, duplicates: 2, gaps: 3, reconnects: 4, lag: 5 })).toBe("sequence 4 · 5 events not yet in status · 2 duplicates ignored · 3 gaps recovered · 4 reconnects");
		expect(formatMicros("0")).toBe("0.0000");
		expect(formatMicros("1234567")).toBe("1.2345");
		expect(formatMicros("123456789012345")).toBe("123,456,789.0123");
		expect(shortDigest(digest)).toBe("aaaaaaaaaaaa");
		expect(shortDigest("b".repeat(64))).toBe("bbbbbbbbbbbb");
		expect(appendUnique([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }], item => item.id)).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
		expect([formatBytes(0), formatBytes(1023), formatBytes(1024), formatBytes(1536), formatBytes(1024 * 1024 - 1), formatBytes(1024 * 1024), formatBytes(5 * 1024 * 1024)]).toEqual(["0 B", "1023 B", "1.0 KiB", "1.5 KiB", "1024.0 KiB", "1.0 MiB", "5.0 MiB"]);
	});
});

describe("FactoryRunInspector", () => {
	test("lists runs by status, then shows one run's snapshot and follows its events to the end", async () => {
		const service = api();
		const onOpenInbox = vi.fn();
		render(FactoryRunInspector, { projectId: "project-1", onOpenInbox, api: service });
		await screen.findByRole("button", { name: /run-1/ });
		expect(service.listRuns).toHaveBeenCalledWith("project-1", { limit: 50 });
		await fireEvent.change(screen.getByLabelText("Filter runs by status"), { target: { value: "succeeded" } });
		await waitFor(() => expect(service.listRuns).toHaveBeenLastCalledWith("project-1", { limit: 50, status: "succeeded" }));
		await fireEvent.click(await screen.findByRole("button", { name: "Load more runs" }));
		await waitFor(() => expect(service.listRuns).toHaveBeenLastCalledWith("project-1", { limit: 50, status: "succeeded", cursor: "runs-2" }));
		await fireEvent.click(screen.getAllByRole("button", { name: /run-1/ })[0]!);

		const badge = await screen.findByTestId("factory-stream-state");
		await waitFor(() => expect(badge).toHaveTextContent("Finished"));
		expect(badge).toHaveTextContent("sequence 7");
		expect(service.openRunEvents).toHaveBeenCalledWith("project-1", "run-1", "cursor-run-1", expect.any(AbortSignal));
		expect(screen.getByRole("heading", { level: 2, name: "factory-run-1" })).toBeVisible();
		expect(screen.getByText("version 1.0.0 · revision 3 · grant 1")).toBeVisible();
		const blockers = screen.getByRole("region", { name: "What holds this run" });
		expect(within(blockers).getByText("budget")).toBeVisible();
		await fireEvent.click(within(blockers).getByRole("button", { name: "Decide in inbox" }));
		await fireEvent.click(within(blockers).getByRole("button", { name: "Reconcile in inbox" }));
		await fireEvent.click(screen.getByRole("button", { name: "Reconcile" }));
		expect(onOpenInbox).toHaveBeenCalledTimes(3);
		expect(screen.getByText("1.2345")).toBeVisible();
		expect(screen.getByText("Some provider usage is not settled yet.", { exact: false })).toHaveTextContent("New work is held by the budget.");
		expect(screen.getByRole("table", { name: "Why candidates were rejected" })).toHaveTextContent("TESTS_FAILED");
		expect(screen.getByRole("table", { name: "Why candidates were rejected" })).toHaveTextContent("1 of 2");
		expect(screen.getByText("#7")).toBeVisible();
		expect(screen.getByText("1.5 KiB · summarised")).toBeVisible();
	});

	test("pages every section in place and filters attempts on the server", async () => {
		const service = api({ openRunEvents: vi.fn(async () => frames(drained(5))) });
		render(FactoryRunInspector, { projectId: "project-1", onOpenInbox: vi.fn(), api: service });
		await fireEvent.click(await screen.findByRole("button", { name: /run-1/ }));
		await fireEvent.click(await screen.findByRole("button", { name: "Load more attempts" }));
		expect(await screen.findByText("node-three")).toBeVisible();
		await fireEvent.click(screen.getByRole("button", { name: "Load more nested runs" }));
		expect(await screen.findByText("settled")).toBeVisible();
		await fireEvent.click(screen.getByRole("button", { name: "Load more artifacts" }));
		expect(await screen.findByText(/3.0 MiB/)).toBeVisible();
		expect(service.inspectRunSection).toHaveBeenCalledWith("project-1", "run-1", { section: "attempts", cursor: "attempts-2", limit: 50 });
		expect(service.inspectRunSection).toHaveBeenCalledWith("project-1", "run-1", { section: "children", cursor: "children-2", limit: 50 });
		await fireEvent.input(screen.getByLabelText("Filter attempts by node"), { target: { value: "  node-x " } });
		await fireEvent.submit(screen.getByRole("search"));
		await waitFor(() => expect(service.inspectRunSection).toHaveBeenLastCalledWith("project-1", "run-1", { section: "attempts", limit: 50, search: "node-x" }));
		expect(await screen.findByText("node-x")).toBeVisible();
		service.inspectRunSection = vi.fn(async () => ({ section: "attempts" as const, page: { items: [] } }));
		await fireEvent.input(screen.getByLabelText("Filter attempts by node"), { target: { value: "" } });
		await fireEvent.submit(screen.getByRole("search"));
		expect(await screen.findByText("No attempt has started.")).toBeVisible();
		await fireEvent.input(screen.getByLabelText("Filter attempts by node"), { target: { value: "nothing" } });
		await fireEvent.submit(screen.getByRole("search"));
		expect(await screen.findByText("No attempt matches “nothing”.")).toBeVisible();
	});

	test("walks into a nested run, back to its parent, and to a parent it names", async () => {
		const service = api({
			inspectRun: vi.fn(async (_project: string, runId: string) => runId === "child-1" ? inspection(runId, { parentRunId: "run-1", children: { items: [] } }) : inspection(runId)),
			openRunEvents: vi.fn(async () => frames(drained(5))),
		});
		render(FactoryRunInspector, { projectId: "project-1", onOpenInbox: vi.fn(), api: service });
		await fireEvent.click(await screen.findByRole("button", { name: /run-1/ }));
		await fireEvent.click(await screen.findByRole("button", { name: "Open" }));
		const trail = await screen.findByRole("navigation", { name: "Parent runs" });
		expect(trail).toHaveTextContent("Root run");
		expect(await screen.findByText("This run started no nested runs.")).toBeVisible();
		await fireEvent.click(screen.getByRole("button", { name: /Open parent run/ }));
		await waitFor(() => expect(service.inspectRun).toHaveBeenLastCalledWith("project-1", "run-1", undefined));
		await fireEvent.click(await screen.findByRole("button", { name: "Open" }));
		await fireEvent.click(await screen.findByRole("button", { name: "Root run" }));
		await waitFor(() => expect(screen.queryByRole("navigation", { name: "Parent runs" })).toBeNull());
	});

	test("revocation clears the snapshot instead of leaving stale status on screen", async () => {
		const service = api({ openRunEvents: vi.fn(async () => { throw new FactoryApiClientError(403, "factory_forbidden", "no"); }) });
		render(FactoryRunInspector, { projectId: "project-1", onOpenInbox: vi.fn(), api: service });
		await fireEvent.click(await screen.findByRole("button", { name: /run-1/ }));
		expect(await screen.findByText("Access to this run ended. The view stopped instead of showing stale status.")).toBeVisible();
		expect(screen.getByRole("heading", { level: 2, name: "Run unavailable" })).toBeVisible();
		expect(screen.queryByText("Waiting for an approval decision")).toBeNull();
	});

	test("errors are named, empty states are honest, and artifacts download or preview on request", async () => {
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		const service = api({
			listRuns: vi.fn().mockRejectedValueOnce(new FactoryApiClientError(404, "x", "gone")).mockResolvedValue({ items: [summary("run-1")], nextCursor: null }),
			inspectRun: vi.fn(async (_project: string, runId: string) => inspection(runId, { blockers: [], acceptance: [], releases: [], children: { items: [] }, attempts: { items: [] }, artifacts: { items: [{ artifactId: "artifact-1", kind: "candidate_output", digest, encodedBytes: 4, createdAtMs: 1 }] }, costs: { limitMicros: "0", allocatedMicros: "0", spentMicros: "0", knownCostMicros: "0", unknownCostMicros: "0", admissionBlocked: false, uncertain: false }, run: { ...summary(runId, "failed"), parameters: {}, error: { code: "factory_failed", message: "It failed." } } })),
			openRunEvents: vi.fn(async () => frames(drained(5))),
		});
		render(FactoryRunInspector, { projectId: "project-1", onOpenInbox: vi.fn(), api: service });
		expect(await screen.findByText("This run is not in the selected project.")).toBeVisible();
		await fireEvent.click(screen.getByRole("button", { name: "Refresh factory runs" }));
		await fireEvent.click(await screen.findByRole("button", { name: /run-1/ }));
		expect(await screen.findByText("It failed.")).toBeVisible();
		// The list said running; the snapshot says failed, and the row follows it.
		expect(within(screen.getByRole("button", { name: /run-1/ })).getByText("failed")).toBeVisible();
		expect(screen.getByText("The run finished with no acceptance decision.")).toBeVisible();
		expect(screen.getByText("No release requested.")).toBeVisible();
		expect(screen.getByText("All reported usage is settled.")).toBeVisible();
		expect(screen.getByText("No new event since the snapshot at sequence 5.")).toBeVisible();
		expect(screen.queryByTestId("factory-run-controls")).toBeNull();
		await fireEvent.click(screen.getByRole("button", { name: "Download artifact-1" }));
		await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
		expect(service.artifactTicket).toHaveBeenCalledWith("project-1", "run-1", "artifact-1");
		service.artifactTicket = vi.fn(async () => { throw new Error("ticket service down"); });
		await fireEvent.click(screen.getByRole("button", { name: "Download artifact-1" }));
		expect(await screen.findByText("ticket service down")).toBeVisible();
		await fireEvent.click(screen.getByRole("button", { name: "Preview artifact-1" }));
		expect(await screen.findByTestId("factory-artifact-preview")).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "Close artifact preview" }));
		await waitFor(() => expect(screen.queryByTestId("factory-artifact-preview")).toBeNull());
	});

	test("a failed page request is shown, and a live run embeds its controls", async () => {
		const service = api({
			inspectRunSection: vi.fn(async () => { throw new FactoryApiClientError(403, "factory_forbidden", "no"); }),
			openRunEvents: vi.fn(async () => frames(drained(5))),
		});
		render(FactoryRunInspector, { projectId: "project-1", onOpenInbox: vi.fn(), api: service });
		await fireEvent.click(await screen.findByRole("button", { name: /run-1/ }));
		expect(await screen.findByTestId("factory-run-controls")).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "Load more attempts" }));
		expect(await screen.findByText("You no longer hold read access to this run.")).toBeVisible();
		service.inspectRunSection = vi.fn(async () => { throw new FactoryApiClientError(500, "factory_storage", "Run storage is unavailable."); });
		await fireEvent.click(screen.getByRole("button", { name: "Load more attempts" }));
		expect(await screen.findByText("Run storage is unavailable.")).toBeVisible();
		service.inspectRunSection = vi.fn(async () => { throw new FactoryApiClientError(403, "factory_forbidden", "no"); });
		await fireEvent.submit(screen.getByRole("search"));
		await waitFor(() => expect(service.inspectRunSection).toHaveBeenCalledTimes(1));
	});

	test("a run named by the URL opens once the list has loaded, and only once", async () => {
		const service = api({ openRunEvents: vi.fn(async () => frames(drained(5))) });
		render(FactoryRunInspector, { projectId: "project-1", onOpenInbox: vi.fn(), initialRunId: "run-from-url", api: service });
		await waitFor(() => expect(service.inspectRun).toHaveBeenCalledWith("project-1", "run-from-url", undefined));
		// The drained stream takes one closing snapshot; after that the open is settled.
		await waitFor(() => expect(service.inspectRun).toHaveBeenCalledTimes(2));
		expect(service.openRunEvents).toHaveBeenCalledTimes(1);
		await fireEvent.change(await screen.findByLabelText("Filter runs by status"), { target: { value: "failed" } });
		await waitFor(() => expect(service.listRuns).toHaveBeenCalledTimes(2));
		expect(service.openRunEvents).toHaveBeenCalledTimes(1);
		expect(service.inspectRun).toHaveBeenCalledTimes(2);
	});

	test("an older snapshot never rolls a newer list row back, and a live run with no decision says so", async () => {
		const service = api({
			listRuns: vi.fn(async () => ({ items: [{ ...summary("run-1", "succeeded"), revision: 9 }], nextCursor: null })),
			inspectRun: vi.fn(async (_project: string, runId: string) => inspection(runId, { acceptance: [] })),
			openRunEvents: vi.fn(async () => frames()),
		});
		render(FactoryRunInspector, { projectId: "project-1", onOpenInbox: vi.fn(), api: service });
		await fireEvent.click(await screen.findByRole("button", { name: /run-1/ }));
		expect(await screen.findByText("No acceptance decision yet.")).toBeVisible();
		expect(within(screen.getByRole("button", { name: /run-1/ })).getByText("succeeded")).toBeVisible();
	});

	test("no project reads nothing", async () => {
		const service = api();
		render(FactoryRunInspector, { projectId: "", onOpenInbox: vi.fn(), api: service });
		expect(await screen.findByText("No runs match this view.")).toBeVisible();
		expect(service.listRuns).not.toHaveBeenCalled();
	});
});
