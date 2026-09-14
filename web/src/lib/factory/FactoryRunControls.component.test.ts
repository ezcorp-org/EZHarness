import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";
import type { FactoryRunDetails, FactoryRunSummary } from "@ezcorp/factory-sdk/types";
import FactoryRunControls from "./FactoryRunControls.svelte";
import { FactoryApiClientError, type FactoryRunControlApi } from "./client";

const waiting: FactoryRunSummary = { runId: "run-waiting", factoryId: "reference.code.v1", factoryVersion: "1.0.0", definitionDigest: `sha256:${"a".repeat(64)}`, grantRevision: 1, revision: 4, status: "waiting", createdAtMs: 1, updatedAtMs: 2 };
const finished: FactoryRunSummary = { ...waiting, runId: "run-done", revision: 9, status: "succeeded" };
const details: FactoryRunDetails = { ...waiting, parameters: {}, error: { code: "factory_assurance_claim_failed", message: "A required claim failed." } };
const receipt = { resourceId: waiting.runId, commandId: "repair/one", statusUrl: "/api/factories/projects/p/runs/run-waiting/commands/repair%2Fone" };

function api(overrides: Partial<FactoryRunControlApi> = {}): FactoryRunControlApi {
	return {
		listRuns: vi.fn(async () => ({ items: [waiting, finished], nextCursor: null })),
		getRun: vi.fn(async () => details),
		controlRun: vi.fn(async () => receipt),
		...overrides,
	};
}

async function selectWaitingRun(service: FactoryRunControlApi) {
	render(FactoryRunControls, { projectId: "project-1", api: service });
	const run = await screen.findByRole("button", { name: /run-waiting/ });
	await fireEvent.click(run);
	return await screen.findByText(/Controlling/);
}

describe("FactoryRunControls", () => {
	test("lists runs, refuses a terminal one, and sends an exact repair at the current revision", async () => {
		const service = api();
		await selectWaitingRun(service);
		expect(service.listRuns).toHaveBeenCalledWith("project-1", { limit: 50 });
		expect(screen.getByRole("button", { name: /run-done/ })).toBeDisabled();
		expect(screen.getByText(/factory_assurance_claim_failed/)).toBeVisible();

		await fireEvent.input(screen.getByLabelText("Node"), { target: { value: " generate-private-candidate " } });
		await fireEvent.input(screen.getByLabelText("Reason"), { target: { value: " add the missing protected test " } });
		await fireEvent.input(screen.getByLabelText("Input override"), { target: { value: '{"remediation":{"kind":"inline","value":"add the missing protected test"}}' } });
		await fireEvent.submit(screen.getByRole("form", { name: "Run control" }));

		await waitFor(() => expect(service.controlRun).toHaveBeenCalledWith("project-1", "run-waiting", 4, {
			action: "repair",
			nodeId: "generate-private-candidate",
			reason: "add the missing protected test",
			parameters: { remediation: { kind: "inline", value: "add the missing protected test" } },
		}));
		expect(await screen.findByText("Queued repair as repair/one.")).toBeVisible();
	});

	test("sends a replan only with the exact pinned child revision", async () => {
		const service = api();
		await selectWaitingRun(service);
		await fireEvent.click(screen.getByRole("button", { name: "Replan" }));
		await fireEvent.input(screen.getByLabelText("Node"), { target: { value: "child" } });
		await fireEvent.submit(screen.getByRole("form", { name: "Run control" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("A replan needs the exact published child id, version, and digest.");
		expect(service.controlRun).not.toHaveBeenCalled();

		await fireEvent.input(screen.getByLabelText("Child factory"), { target: { value: "reference.code.v1" } });
		await fireEvent.input(screen.getByLabelText("Child version"), { target: { value: "1.1.0" } });
		await fireEvent.input(screen.getByLabelText("Child digest"), { target: { value: `sha256:${"b".repeat(64)}` } });
		await fireEvent.submit(screen.getByRole("form", { name: "Run control" }));
		await waitFor(() => expect(service.controlRun).toHaveBeenCalledWith("project-1", "run-waiting", 4, {
			action: "replan",
			nodeId: "child",
			parameters: {},
			replacement: { id: "reference.code.v1", version: "1.1.0", digest: `sha256:${"b".repeat(64)}` },
		}));
	});

	test("refuses to send a control it cannot build", async () => {
		const service = api();
		await selectWaitingRun(service);
		for (const [node, override, message] of [
			["", "{}", "Name the node this control replaces."],
			["node", "{", "The input override is not valid JSON."],
			["node", "[]", "The input override must be a JSON object of port names."],
			["node", "null", "The input override must be a JSON object of port names."],
		] as const) {
			await fireEvent.input(screen.getByLabelText("Node"), { target: { value: node } });
			await fireEvent.input(screen.getByLabelText("Input override"), { target: { value: override } });
			await fireEvent.submit(screen.getByRole("form", { name: "Run control" }));
			expect(await screen.findByRole("alert")).toHaveTextContent(message);
		}
		expect(service.controlRun).not.toHaveBeenCalled();
	});

	test("reloads the current revision when a control arrives stale", async () => {
		const moved: FactoryRunDetails = { ...details, revision: 5 };
		let reads = 0;
		const service = api({
			getRun: vi.fn(async () => (reads++ === 0 ? details : moved)),
			controlRun: vi.fn(async () => { throw new FactoryApiClientError(412, "factory_control_stale", "stale", 5); }),
		});
		await selectWaitingRun(service);
		await fireEvent.input(screen.getByLabelText("Node"), { target: { value: "node" } });
		await fireEvent.submit(screen.getByRole("form", { name: "Run control" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("The run moved on while you were editing.");
		await waitFor(() => expect(screen.getByText(/at revision 5/)).toBeVisible());
	});

	test("names each refusal the server can return", async () => {
		for (const [code, message] of [
			["factory_control_widening", "That replacement widens the run's authority."],
			["factory_control_invalid", "That control cannot apply to this node right now."],
			["factory_forbidden", "not allowed"],
		] as const) {
			cleanup();
			const failing = api({ controlRun: vi.fn(async () => { throw new FactoryApiClientError(403, code, "not allowed"); }) });
			await selectWaitingRun(failing);
			await fireEvent.input(screen.getByLabelText("Node"), { target: { value: "node" } });
			await fireEvent.submit(screen.getByRole("form", { name: "Run control" }));
			expect(await screen.findByRole("alert")).toHaveTextContent(message);
		}
	});

	test("reports an unreachable list, an unreadable run, and an empty project", async () => {
		const failing = api({ listRuns: vi.fn(async () => { throw new Error("gateway down"); }) });
		render(FactoryRunControls, { projectId: "project-1", api: failing });
		expect(await screen.findByRole("alert")).toHaveTextContent("gateway down");

		cleanup();
		const unreadable = api({ getRun: vi.fn(async () => { throw "not an error"; }) });
		render(FactoryRunControls, { projectId: "project-1", api: unreadable });
		await fireEvent.click(await screen.findByRole("button", { name: /run-waiting/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent("The run control service is unavailable.");
		expect(screen.queryByText(/Controlling/)).toBeNull();

		cleanup();
		const empty = api({ listRuns: vi.fn(async () => ({ items: [], nextCursor: null })) });
		render(FactoryRunControls, { projectId: "project-1", api: empty });
		expect(await screen.findByText("This project has no factory runs yet.")).toBeVisible();
		await fireEvent.click(screen.getByRole("button", { name: "Refresh factory runs" }));
		await waitFor(() => expect(empty.listRuns).toHaveBeenCalledTimes(2));

		cleanup();
		const idle = api();
		render(FactoryRunControls, { projectId: "", api: idle });
		expect(idle.listRuns).not.toHaveBeenCalled();
		expect(within(screen.getByTestId("factory-run-controls")).getByRole("button", { name: "Refresh factory runs" })).toBeDisabled();
	});
});
