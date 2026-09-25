import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import Page from "./+page.svelte";

const operatorId = "operator-1";
const environment = {
	installationId: "installation-1", releaseId: "release-1", releaseGeneration: 1,
	connectionId: "connection-1", connectionRevision: 1, presetId: "persistent-web-compose.v1",
	label: "Incus host", profile: "persistent-web-compose.v1", qualified: true,
	qualificationState: "qualified", qualificationRunId: null, qualificationValidUntil: "2026-10-01T00:00:00Z",
	blockedReason: null, setupId: null,
};
const project = { id: "project-1", name: "Project one" };
const bindingId = "binding-1";
const feature = (operation: { kind: string; state: string } | null = null) => ({
	projectId: project.id, projectName: project.name, bindingId,
	installationId: environment.installationId, releaseId: environment.releaseId,
	connectionId: environment.connectionId, connectionRevision: 1, generation: 1,
	presetId: environment.presetId, desiredState: "STOPPED", observedState: "STOPPED",
	operation, tombstonedAt: null, cleanupConfirmedAt: null,
});
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
	status, headers: { "content-type": "application/json" },
});
const storageKey = (name: string) => `ezharness-incus:${operatorId}:${name}`;

function serve(options: {
	feature?: ReturnType<typeof feature> | null;
	qualified?: boolean;
	onFeature?: (body: Record<string, unknown>, call: number) => Response;
} = {}) {
	let current = options.feature ?? null;
	let featureCalls = 0;
	const calls: Record<string, unknown>[] = [];
	vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
		if (url.endsWith("/management")) return reply({ environments: [{ ...environment, qualified: options.qualified ?? true,
			qualificationState: options.qualified === false ? "not_qualified" : "qualified" }], projects: [project], features: current ? [current] : [] });
		if (url.endsWith("/features") && body) {
			calls.push(body);
			featureCalls++;
			const result = options.onFeature?.(body, featureCalls);
			if (result) return result;
			if (body.action === "prepareProject") return reply({ project, binding: { id: bindingId } });
			return reply({ state: "DISPATCHED" }, 202);
		}
		return reply({});
	}));
	return { calls, setFeature: (value: ReturnType<typeof feature>) => { current = value; } };
}

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Incus management recovery", () => {
	test.each([
		["qualification-draft", "qualification draft", false, "{not-json", "could not be read"],
		["project-draft", "project sandbox request", true, "{not-json", "could not be read"],
		["qualification-draft", "qualification draft", false, "{}", "is damaged"],
		["project-draft", "project sandbox request", true, "{}", "is damaged"],
	] as const)("preserves a damaged %s record %s and warns the operator", async (name, warning, qualified, damaged, outcome) => {
		localStorage.setItem(storageKey(name), damaged);
		serve({ qualified });
		const view = render(Page, { props: { data: { operatorId } } });
		await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent(`A saved ${warning} ${outcome}`));
		expect(localStorage.getItem(storageKey(name))).toBe(damaged);
		await waitFor(() => expect(view.getByRole("heading", { name: "Incus host" })).toBeInTheDocument());
		expect(view.getByRole("button", { name: qualified ? "Create project sandbox" : "Prepare qualification…" })).toBeDisabled();
	});

	test("storage read failures warn without stopping the management view", async () => {
		const original = Storage.prototype.getItem;
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
			if (key === storageKey("qualification-draft")) throw new Error("Storage blocked");
			return original.call(this, key);
		});
		serve({ qualified: false });
		const view = render(Page, { props: { data: { operatorId } } });
		await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("saved qualification draft could not be read"));
		await waitFor(() => expect(view.getByRole("heading", { name: "Incus host" })).toBeInTheDocument());
		expect(view.getByRole("button", { name: "Prepare qualification…" })).toBeDisabled();
	});

	test("a damaged mutation-key record is removed before any new action", async () => {
		localStorage.setItem(storageKey("mutation-keys"), "{not-json");
		serve({ feature: feature() });
		const view = render(Page, { props: { data: { operatorId } } });
		await waitFor(() => expect(view.getByRole("button", { name: "Start" })).toBeEnabled());
		expect(localStorage.getItem(storageKey("mutation-keys"))).toBeNull();
	});

	test("a storage write failure keeps the mutation key in page memory for retry", async () => {
		const original = Storage.prototype.setItem;
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
			if (key === storageKey("mutation-keys")) throw new Error("Storage full");
			return original.call(this, key, value);
		});
		let attempts = 0;
		const { calls } = serve({ feature: feature(), onFeature: body => {
			if (body.action !== "start") return reply({});
			attempts++;
			return attempts === 1 ? reply({ message: "Connection interrupted" }, 503) : reply({ state: "DISPATCHED" }, 202);
		} });
		const view = render(Page, { props: { data: { operatorId } } });
		await waitFor(() => expect(view.getByRole("button", { name: "Start" })).toBeEnabled());
		await fireEvent.click(view.getByRole("button", { name: "Start" }));
		await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Connection interrupted"));
		await fireEvent.click(view.getByRole("button", { name: "Start" }));
		await waitFor(() => expect(attempts).toBe(2));
		const starts = calls.filter(body => body.action === "start");
		expect(starts[0]?.idempotencyKey).toBe(starts[1]?.idempotencyKey);
		expect(localStorage.getItem(storageKey("mutation-keys"))).toBeNull();
	});

	test("start failure keeps its request key for a safe retry", async () => {
		let attempts = 0;
		serve({ feature: feature(), onFeature: (body) => {
			if (body.action !== "start") return reply({});
			attempts++;
			return attempts === 1 ? reply({ message: "Incus control unavailable" }, 503) : reply({ state: "DISPATCHED" }, 202);
		} });
		const view = render(Page, { props: { data: { operatorId } } });
		await waitFor(() => expect(view.getByRole("button", { name: "Start" })).toBeEnabled());
		await fireEvent.click(view.getByRole("button", { name: "Start" }));
		await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Incus control unavailable"));
		const saved = JSON.parse(localStorage.getItem(storageKey("mutation-keys")) ?? "{}") as Record<string, string>;
		expect(Object.values(saved)).toHaveLength(1);
		await fireEvent.click(view.getByRole("button", { name: "Start" }));
		await waitFor(() => expect(attempts).toBe(2));
		const bodies = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.body)
			.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
			.filter(body => body.action === "start");
		expect(bodies.map(body => body.idempotencyKey)).toEqual([Object.values(saved)[0], Object.values(saved)[0]]);
	});

	test("a rejected create keeps the project but rotates only its operation key", async () => {
		let createCalls = 0;
		const { calls } = serve({ onFeature: body => {
			if (body.action === "prepareProject") return reply({ project, binding: { id: bindingId } });
			if (body.action === "create") {
				createCalls++;
				return createCalls === 1 ? reply({ state: "REJECTED", message: "Capacity rejected" }, 409)
					: reply({ state: "DISPATCHED" }, 202);
			}
			return reply({});
		} });
		const view = render(Page, { props: { data: { operatorId } } });
		await waitFor(() => expect(view.getByRole("button", { name: "Create project sandbox" })).toBeEnabled());
		await fireEvent.click(view.getByRole("button", { name: "Create project sandbox" }));
		await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Capacity rejected"));
		await waitFor(() => expect(view.getByRole("button", { name: "Create project sandbox" })).toBeEnabled());
		await fireEvent.click(view.getByRole("button", { name: "Create project sandbox" }));
		await waitFor(() => expect(createCalls).toBe(2));
		const prepares = calls.filter(body => body.action === "prepareProject");
		const creates = calls.filter(body => body.action === "create");
		expect(prepares.map(body => body.idempotencyKey)).toEqual([prepares[0]?.idempotencyKey, prepares[0]?.idempotencyKey]);
		expect(creates.map(body => body.projectId)).toEqual([project.id, project.id]);
		expect(creates[0]?.idempotencyKey).not.toBe(creates[1]?.idempotencyKey);
	});

	test("a terminally rejected start gets a new key on retry", async () => {
		let attempts = 0;
		const server = serve({ feature: feature(), onFeature: body => {
			if (body.action !== "start") return reply({});
			attempts++;
			if (attempts === 1) server.setFeature(feature({ kind: "START", state: "REJECTED" }));
			return reply({ state: attempts === 1 ? "REJECTED" : "DISPATCHED" }, 202);
		} });
		const view = render(Page, { props: { data: { operatorId } } });
		await waitFor(() => expect(view.getByRole("button", { name: "Start" })).toBeEnabled());
		await fireEvent.click(view.getByRole("button", { name: "Start" }));
		await waitFor(() => expect(view.getByText(/Last operation: START · REJECTED/)).toBeInTheDocument());
		await fireEvent.click(view.getByRole("button", { name: "Start" }));
		await waitFor(() => expect(attempts).toBe(2));
		const starts = server.calls.filter(body => body.action === "start");
		expect(starts[0]?.idempotencyKey).not.toBe(starts[1]?.idempotencyKey);
	});

	test("a failed project preparation retries the same prepare key", async () => {
		let attempts = 0;
		const { calls } = serve({ onFeature: body => {
			if (body.action !== "prepareProject") return reply({});
			attempts++;
			return attempts === 1 ? reply({ message: "Preparation unavailable" }, 503)
				: reply({ project, binding: { id: bindingId } });
		} });
		const view = render(Page, { props: { data: { operatorId } } });
		await waitFor(() => expect(view.getByRole("button", { name: "Create project sandbox" })).toBeEnabled());
		await fireEvent.click(view.getByRole("button", { name: "Create project sandbox" }));
		await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Preparation unavailable"));
		await waitFor(() => expect(view.getByRole("button", { name: "Create project sandbox" })).toBeEnabled());
		await fireEvent.click(view.getByRole("button", { name: "Create project sandbox" }));
		await waitFor(() => expect(attempts).toBe(2));
		const prepares = calls.filter(body => body.action === "prepareProject");
		expect(prepares[0]?.idempotencyKey).toBe(prepares[1]?.idempotencyKey);
	});

	test("failed disposal preserves its key and requires a fresh confirmation for retry", async () => {
		let attempts = 0;
		const { calls } = serve({ feature: feature(), onFeature: body => {
			if (body.action !== "destroy") return reply({});
			attempts++;
			return attempts === 1 ? reply({ message: "Disposal uncertain" }, 503) : reply({ state: "DISPATCHED" }, 202);
		} });
		const view = render(Page, { props: { data: { operatorId } } });
		await waitFor(() => expect(view.getByRole("button", { name: "Dispose…" })).toBeEnabled());
		await fireEvent.click(view.getByRole("button", { name: "Dispose…" }));
		await fireEvent.click(view.getByRole("button", { name: "Dispose sandbox" }));
		await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Disposal uncertain"));
		expect(view.queryByRole("group", { name: "Confirm disposal of Project one" })).not.toBeInTheDocument();
		await fireEvent.click(view.getByRole("button", { name: "Dispose…" }));
		await fireEvent.click(view.getByRole("button", { name: "Dispose sandbox" }));
		await waitFor(() => expect(attempts).toBe(2));
		const destroys = calls.filter(body => body.action === "destroy");
		expect(destroys[0]?.idempotencyKey).toBe(destroys[1]?.idempotencyKey);
	});
});
