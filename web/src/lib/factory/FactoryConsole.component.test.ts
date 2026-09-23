import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
	FactoryDefinition,
	FactoryDraftDetails,
	FactoryDraftSummary,
	FactoryVersionDetails,
	FactoryVersionSummary,
} from "@ezcorp/factory-sdk/types";
import FactoryConsole from "./FactoryConsole.svelte";
import { blankFactory, FactoryApiClientError, type FactoryAuthoringApi } from "./client";

const digest = "a".repeat(64);
const definitionDigest = "sha256:" + digest;

function source(version = "0.1.0"): FactoryDefinition {
	return {
		...blankFactory("catalog-long-running-factory-definition"),
		version,
		presentation: { title: "Catalog enrichment with a deliberately long label" },
	};
}

function summary(revision = 1): FactoryDraftSummary {
	return {
		factoryId: source().id,
		revision,
		archived: false,
		availability: "available",
		sourceDigest: digest,
		updatedAtMs: 1_789_000_000_000,
	};
}

function details(revision = 1, value = source()): FactoryDraftDetails {
	return { ...summary(revision), sourceDigest: digest, source: value };
}

function version(value = source("0.0.9")): FactoryVersionDetails {
	return {
		factoryId: value.id,
		version: value.version,
		draftRevision: 1,
		definitionDigest,
		compiledBlobDigest: digest,
		compiledBytes: 128,
		publishedAtMs: 1_788_000_000_000,
		source: value,
	};
}

function api(overrides: Partial<FactoryAuthoringApi> = {}): FactoryAuthoringApi {
	const current = details();
	const prior = version();
	return {
		listDrafts: vi.fn(async () => [summary()]),
		getDraft: vi.fn(async () => current),
		createDraft: vi.fn(async (_projectId, value) => ({ ...summary(), factoryId: value.id })),
		importDraft: vi.fn(async () => summary()),
		saveDraft: vi.fn(async (_projectId, _factoryId, revision) => summary(revision + 1)),
		archiveDraft: vi.fn(async () => ({ ...summary(2), archived: true })),
		exportDraft: vi.fn(async () => ({ format: "json" as const, source: JSON.stringify(current.source) })),
		validateDraft: vi.fn(async () => ({
			schemaVersion: "factory.api.response.v1" as const,
			kind: "draft.validation" as const,
			valid: false,
			diagnostics: [{ code: "missing-output", message: "Connect the result port.", path: ["graph", "outputs"], nodeId: "collect" }],
		})),
		listVersions: vi.fn(async () => [prior]),
		getVersion: vi.fn(async () => prior),
		publishVersion: vi.fn(async (_projectId, factoryId, revision, releaseVersion): Promise<FactoryVersionSummary> => ({
			...prior,
			factoryId,
			version: releaseVersion,
			draftRevision: revision,
		})),
		listGrants: vi.fn(async () => ({ items: [
			{ principalKind: "user" as const, principalId: "someone-else", action: "factory.run" as const, revision: 9, expiresAtMs: null, revoked: false },
			{ principalKind: "user" as const, principalId: "member-1", action: "factory.run" as const, revision: 4, expiresAtMs: null, revoked: false },
		], nextCursor: null })),
		startRun: vi.fn(async () => ({ resourceId: "run-new", commandId: "start-1", statusUrl: "/api/factories/projects/project-a/runs/run-new/commands/start-1" })),
		...overrides,
	};
}

async function openDraft(): Promise<void> {
	await fireEvent.click(await screen.findByRole("button", { name: /catalog-long-running-factory-definition/ }));
	await screen.findByRole("heading", { name: source().id });
}

function renderConsole(authoring: FactoryAuthoringApi): ReturnType<typeof render> {
	return render(FactoryConsole, { projectId: "project-a", api: authoring });
}

async function makeDirty(): Promise<void> {
	await fireEvent.click(screen.getByRole("button", { name: "Definition" }));
	await fireEvent.input(screen.getByLabelText("Factory definition JSON"), { target: { value: JSON.stringify({ ...source(), version: "0.2.0" }) } });
	await fireEvent.click(screen.getByRole("button", { name: "Apply source" }));
}

describe("FactoryConsole read-only drafts", () => {
	beforeEach(() => {
		vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
	});

	test("a draft a newer server wrote is shown exactly as stored, cannot be edited, and still exports", async () => {
		const stored = JSON.stringify({ schemaVersion: "factory.v9", id: source().id, futureExecutionField: { mode: "new" } });
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		const authoring = api({
			getDraft: vi.fn(async () => { throw new FactoryApiClientError(409, "factory_definition_version_unsupported", "The definition uses a schema version this server cannot edit."); }),
			exportDraft: vi.fn(async (_project: string, _factory: string, format: "json" | "yaml") => ({ format, source: stored })),
		});
		renderConsole(authoring);
		await fireEvent.click(await screen.findByRole("button", { name: /catalog-long-running-factory-definition/ }));
		expect(await screen.findByRole("heading", { name: source().id })).toBeVisible();
		expect(screen.getByRole("note")).toHaveTextContent("A newer factory server wrote this definition with a schema version this console cannot edit.");
		const stored_ = screen.getByLabelText("Stored definition source") as HTMLTextAreaElement;
		expect(stored_.value).toContain('"factory.v9"');
		expect(stored_.readOnly).toBe(true);
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
		expect(screen.queryByLabelText("Factory definition JSON")).toBeNull();
		await fireEvent.click(screen.getByRole("button", { name: "Export YAML" }));
		await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
		expect(authoring.exportDraft).toHaveBeenLastCalledWith("project-a", source().id, "yaml");
		expect(screen.queryByRole("alert")).toBeNull();
		vi.restoreAllMocks();
	});

	test("when even the export is refused, the refusal is shown and nothing is edited", async () => {
		const authoring = api({
			getDraft: vi.fn(async () => { throw new FactoryApiClientError(409, "factory_definition_version_unsupported", "unsupported"); }),
			exportDraft: vi.fn(async () => { throw new FactoryApiClientError(403, "factory_forbidden", "Factory authority is required."); }),
		});
		renderConsole(authoring);
		await fireEvent.click(await screen.findByRole("button", { name: /catalog-long-running-factory-definition/ }));
		expect(await screen.findByRole("alert")).toBeVisible();
		expect(screen.queryByLabelText("Stored definition source")).toBeNull();
		expect(screen.getByText("No draft selected")).toBeVisible();
	});
});

describe("FactoryConsole start run", () => {
	beforeEach(() => {
		vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
	});

	async function openStart(authoring: FactoryAuthoringApi, onOpenRun = vi.fn(), currentUserId: string | null = "member-1") {
		render(FactoryConsole, { projectId: "project-a", currentUserId, onOpenRun, api: authoring });
		await openDraft();
		await fireEvent.click(screen.getByRole("button", { name: /^Versions/ }));
		await fireEvent.click(await screen.findByRole("button", { name: "Start a run of 0.0.9" }));
		return { dialog: await screen.findByRole("dialog", { name: /Start .* 0\.0\.9/ }), onOpenRun };
	}

	test("queues the exact version with the caller's current run grant, then opens it in Runs", async () => {
		const authoring = api();
		const { dialog, onOpenRun } = await openStart(authoring);
		expect(dialog).toHaveTextContent("The run pins version 0.0.9");
		await fireEvent.input(within(dialog).getByLabelText(/Run input/), { target: { value: '{"message":{"kind":"inline","value":"hi"}}' } });
		await fireEvent.click(within(dialog).getByRole("button", { name: "Start run" }));
		expect(await within(dialog).findByRole("status")).toHaveTextContent("Run run-new is queued. Acceptance is not the same as a started run.");
		expect(authoring.listGrants).toHaveBeenCalledWith("project-a", { principalKind: "user", action: "factory.run", limit: 200 });
		expect(authoring.startRun).toHaveBeenCalledWith("project-a", version().factoryId, { factoryVersion: "0.0.9", definitionDigest: version().definitionDigest, grantRevision: 4, parameters: { message: { kind: "inline", value: "hi" } } });
		await fireEvent.click(within(dialog).getByRole("button", { name: "Watch in Runs" }));
		expect(onOpenRun).toHaveBeenCalledWith("run-new");
		expect(screen.queryByRole("dialog", { name: /Start / })).toBeNull();
	});

	test("refuses bad input, a missing grant, and a failed request, and closes without starting", async () => {
		const authoring = api({ startRun: vi.fn(async () => { throw new FactoryApiClientError(409, "factory_definition_conflict", "The definition moved."); }) });
		const { dialog } = await openStart(authoring, vi.fn(), "nobody");
		const input = within(dialog).getByLabelText(/Run input/);
		const start = within(dialog).getByRole("button", { name: "Start run" });
		for (const [text, error] of [["{", "Run input is not valid JSON."], ["[]", "Run input must be a JSON object of port names."], ["null", "Run input must be a JSON object of port names."], ["", "You hold no current factory.run grant in this project."]] as const) {
			await fireEvent.input(input, { target: { value: text } });
			await fireEvent.click(start);
			expect(await within(dialog).findByRole("alert")).toHaveTextContent(error);
		}
		expect(authoring.startRun).not.toHaveBeenCalled();
		cleanup();
		const failing = await openStart(authoring);
		await fireEvent.click(within(failing.dialog).getByRole("button", { name: "Start run" }));
		expect(await within(failing.dialog).findByRole("alert")).toHaveTextContent("The definition moved.");
		await fireEvent.click(within(failing.dialog).getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("dialog", { name: /Start / })).toBeNull();
		await fireEvent.click(screen.getByRole("button", { name: "Start a run of 0.0.9" }));
		await fireEvent.click(await screen.findByRole("button", { name: "Close start run" }));
		await fireEvent.click(screen.getByRole("button", { name: "Start a run of 0.0.9" }));
		await fireEvent.click(await screen.findByRole("presentation"));
		expect(screen.queryByRole("dialog", { name: /Start / })).toBeNull();
	});
});

describe("FactoryConsole", () => {
	beforeEach(() => {
		vi.stubGlobal("ResizeObserver", class {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		});
	});

	test("loads the selected membership project and creates a blank SDK draft", async () => {
		const authoring = api();
		render(FactoryConsole, { projectId: "project-a", api: authoring });

		await screen.findByText(source().id);
		expect(authoring.listDrafts).toHaveBeenCalledWith("project-a", { archived: false, limit: 200 });

		await fireEvent.input(screen.getByLabelText("New factory ID"), { target: { value: "new-pipeline" } });
		await fireEvent.click(screen.getByRole("button", { name: "Create factory" }));
		await waitFor(() => expect(authoring.createDraft).toHaveBeenCalledWith("project-a", expect.objectContaining({ id: "new-pipeline", schemaVersion: "factory.v1" })));
	});

	test("edits, validates, resolves a revision conflict, and reviews the exact historical source", async () => {
		const server = details(4);
		const saveDraft = vi.fn()
			.mockRejectedValueOnce(new FactoryApiClientError(412, "factory_precondition_failed", "revision changed", 4))
			.mockResolvedValueOnce(summary(5));
		const authoring = api({ saveDraft, getDraft: vi.fn(async () => server) });
		render(FactoryConsole, { projectId: "project-a", api: authoring });
		await openDraft();

		await fireEvent.input(screen.getByLabelText("New node ID"), { target: { value: "collect" } });
		await fireEvent.click(screen.getByRole("button", { name: "Add node" }));
		await fireEvent.click(screen.getByRole("button", { name: /Validate/ }));
		await screen.findByText("Connect the result port.");
		expect(screen.getByRole("alert")).toHaveTextContent("1 validation diagnostic found.");
		expect(screen.queryByRole("status")).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
		await screen.findByText("Revision conflict");
		await fireEvent.click(screen.getByRole("button", { name: "Keep my changes" }));
		await fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
		await screen.findByText("Draft revision 5 saved.");

		await fireEvent.click(screen.getByRole("button", { name: /^Publish/ }));
		const dialog = await screen.findByRole("dialog", { name: "Review version 0.1.0" });
		expect(dialog).toHaveTextContent("Pinned published source 0.0.9");
		expect(dialog).toHaveTextContent("Acceptance contract unchanged.");
		expect(dialog).toHaveTextContent("It does not activate a runner or package.");
	});

	test("shows failed requests and supports source editing without losing the draft", async () => {
		const authoring = api({ validateDraft: vi.fn(async () => { throw new Error("validation service unavailable"); }) });
		render(FactoryConsole, { projectId: "project-a", api: authoring });
		await openDraft();
		await fireEvent.click(screen.getByRole("button", { name: "Definition" }));
		const editor = screen.getByLabelText("Factory definition JSON");
		const changed = { ...source(), version: "0.2.0" };
		await fireEvent.input(editor, { target: { value: JSON.stringify(changed) } });
		await fireEvent.click(screen.getByRole("button", { name: "Apply source" }));
		expect(screen.getByText(/0.2.0 · 0 nodes/)).toBeInTheDocument();
		await fireEvent.click(screen.getByRole("button", { name: /Validate/ }));
		await screen.findByText("validation service unavailable");
	});

	test("surfaces list, create, and import failures", async () => {
		const listFailure = api({ listDrafts: vi.fn(async () => { throw new Error("draft list unavailable"); }) });
		let view = renderConsole(listFailure);
		expect(await screen.findByText("draft list unavailable")).toBeVisible();
		view.unmount();

		const createFailure = api({ createDraft: vi.fn(async () => { throw new Error("create refused"); }) });
		view = renderConsole(createFailure);
		await screen.findByText(source().id);
		await fireEvent.input(screen.getByLabelText("New factory ID"), { target: { value: "new-one" } });
		await fireEvent.click(screen.getByRole("button", { name: "Create factory" }));
		expect(await screen.findByText("create refused")).toBeVisible();
		view.unmount();

		const importFailure = api({ importDraft: vi.fn(async () => { throw new Error("import refused"); }) });
		renderConsole(importFailure);
		await screen.findByText(source().id);
		const file = new File(["schemaVersion: factory.v1"], "definition.json", { type: "application/json" });
		Object.defineProperty(file, "text", { value: async () => "schemaVersion: factory.v1" });
		const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
		await fireEvent.change(fileInput, { target: { files: [file] } });
		expect(await screen.findByText("import refused")).toBeVisible();
	});

	test("surfaces save, export, archive, and duplicate-node failures", async () => {
		const saveFailure = api({
			saveDraft: vi.fn(async () => { throw new Error("save refused"); }),
			exportDraft: vi.fn(async () => { throw new Error("export refused"); }),
			archiveDraft: vi.fn(async () => { throw new Error("archive refused"); }),
		});
		renderConsole(saveFailure);
		await openDraft();
		await makeDirty();
		await fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByText("save refused")).toBeVisible();
		await fireEvent.click(screen.getByRole("button", { name: "JSON" }));
		expect(await screen.findByText("export refused")).toBeVisible();
		await fireEvent.click(screen.getByRole("button", { name: "Archive draft" }));
		expect(await screen.findByText("archive refused")).toBeVisible();

		await fireEvent.click(screen.getByRole("button", { name: "Graph" }));
		await fireEvent.input(screen.getByLabelText("New node ID"), { target: { value: "collect" } });
		await fireEvent.click(screen.getByRole("button", { name: "Add node" }));
		await fireEvent.input(screen.getByLabelText("New node ID"), { target: { value: "collect" } });
		await fireEvent.click(screen.getByRole("button", { name: "Add node" }));
		expect(await screen.findByText("Node IDs must be unique in this graph.")).toBeVisible();
	});

	test("loads the server side of a conflict and handles first-publication review", async () => {
		const server = details(6);
		const conflictApi = api({
			saveDraft: vi.fn(async () => { throw new FactoryApiClientError(412, "factory_precondition_failed", "stale", 6); }),
			getDraft: vi.fn(async () => server),
			listVersions: vi.fn(async () => []),
		});
		renderConsole(conflictApi);
		await openDraft();
		await makeDirty();
		await fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await fireEvent.click(await screen.findByRole("button", { name: "Load server" }));
		await screen.findByText("Loaded the current server revision.");
		await fireEvent.click(screen.getByRole("button", { name: "Publish" }));
		const dialog = await screen.findByRole("dialog", { name: "Review version 0.1.0" });
		expect(dialog).toHaveTextContent("First publication");
		expect(dialog).toHaveTextContent("No prior immutable version.");
	});

	test("surfaces publication review and publication failures", async () => {
		const listVersions = vi.fn()
			.mockResolvedValueOnce([version()])
			.mockRejectedValueOnce(new Error("version list unavailable"));
		const reviewFailure = api({ listVersions });
		const view = renderConsole(reviewFailure);
		await openDraft();
		await fireEvent.click(screen.getByRole("button", { name: "Publish" }));
		expect(await screen.findByText("version list unavailable")).toBeVisible();
		view.unmount();

		const publishFailure = api({ publishVersion: vi.fn(async () => { throw new Error("publication refused"); }) });
		renderConsole(publishFailure);
		await screen.findByText(source().id);
		await fireEvent.click(screen.getByRole("button", { name: new RegExp(source().id) }));
		await fireEvent.click(screen.getByRole("button", { name: "Publish" }));
		const dialog = await screen.findByRole("dialog", { name: "Review version 0.1.0" });
		await fireEvent.click(within(dialog).getByRole("button", { name: "Publish 0.1.0" }));
		expect(await screen.findByText("publication refused")).toBeVisible();
	});
});
