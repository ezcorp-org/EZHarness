import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, expect, test, vi } from "vitest";
import type { ComponentProps } from "svelte";
import type { InstallationState } from "$server/extensions/v4/types";
import AuthorPage from "../routes/(app)/extensions/author/+page.svelte";
import { goto } from "$app/navigation";

vi.mock("$app/navigation", () => ({ goto: vi.fn() }));

const installation = { id: "installation", ownerId: "owner", scope: "global", activeReleaseId: null, generation: 0, enabled: false, uninstalled: false, status: "disabled" as const, grants: [], acknowledgedGeneration: 0 };
const workspace = { id: "workspace", installationId: installation.id, revision: 1, sourceDigest: "source", createdAt: "2026-09-04" };

function pageData(approval = false, canApprove = true): ComponentProps<typeof AuthorPage>["data"] {
  const state: InstallationState = { installation, workspaces: { workspace }, revisions: {}, operations: {}, releases: {}, approvals: approval ? { approval: { id: "approval", installationId: installation.id, releaseId: "release", releaseDigest: "exact-release-digest", principalId: "owner", scope: "global", grants: ['["storage",true]'], runnerProfile: "podman", expectedActiveReleaseId: null, expectedGeneration: 0, status: "pending", createdAt: "2026-09-04" } } : {} };
  return { state, workspace, files: { "extension.ts": "original", "src/helper.ts": "helper" }, installations: [installation], canApprove, canBindProject: false, projects: [], projectBinding: null } as ComponentProps<typeof AuthorPage>["data"];
}

test("human project binding uses exact active generation and explicit write scope", async () => {
  const data = pageData();
  data.state!.installation = { ...installation, activeReleaseId: "release", enabled: true, generation: 4, status: "active" };
  data.canBindProject = true;
  data.projects = [{ id: "project", name: "Documentation" }];
  const fetcher = vi.fn(async (_url, init) => { const input = JSON.parse(String(init.body)); return Response.json(input.projectId ? { id: "binding", ownerId: "owner", approvedAt: "now", ...input } : null); });
  vi.stubGlobal("fetch", fetcher);
  const view = render(AuthorPage, { data });
  const approve = view.getByRole("button", { name: "Approve project access" });
  expect(approve).toBeDisabled();
  await fireEvent.change(view.getByLabelText("Project", { exact: true }), { target: { value: "project" } });
  await fireEvent.input(view.getByLabelText("Approved write paths"), { target: { value: "README.md, docs/" } });
  await fireEvent.click(view.getByRole("checkbox", { name: "I reviewed this project's access and exact release." }));
  await fireEvent.click(approve);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(fetcher.mock.calls[0]?.[0]).toBe("/api/extensions/releases/installation/project");
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toEqual({ projectId: "project", releaseId: "release", generation: 4, writePaths: ["README.md", "docs/"] });
  await waitFor(() => expect(view.getByRole("button", { name: "Revoke project access" })).toBeEnabled());
  await fireEvent.click(view.getByRole("button", { name: "Revoke project access" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1].body))).toEqual({ projectId: null, releaseId: "release", generation: 4, writePaths: [] });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

test("saves all changes as one revision before queuing a build", async () => {
  const data = pageData();
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    if (body.tool === "extensions_workspace") return Response.json({ ...workspace, revision: 2 });
    if (body.tool === "extensions_build") return Response.json({ id: "operation", state: "queued" });
    return Response.json(data.state);
  }));
  const view = render(AuthorPage, { data });
  await fireEvent.input(view.getByRole("textbox", { name: "Source: extension.ts" }), { target: { value: "edited" } });
  await fireEvent.click(view.getByRole("button", { name: "Save and build" }));
  await waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[0]).toMatchObject({ tool: "extensions_workspace", input: { expectedRevision: 1, writes: { "extension.ts": "edited", "src/helper.ts": "helper" } } });
  expect(calls[1]).toMatchObject({ tool: "extensions_build", input: { expectedRevision: 2 } });
});

test("a conflicting save retains local source and does not build", async () => {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ message: "Revision conflict. Reload before editing." }, { status: 409 }));
  vi.stubGlobal("fetch", fetcher);
  const view = render(AuthorPage, { data: pageData() });
  const editor = view.getByRole("textbox", { name: "Source: extension.ts" });
  await fireEvent.input(editor, { target: { value: "keep this edit" } });
  await fireEvent.click(view.getByRole("button", { name: "Save and build" }));
  await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Revision conflict"));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(editor).toHaveValue("keep this edit");
});

test("nested additions and deletions are saved atomically", async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ ...workspace, revision: 2 }));
  vi.stubGlobal("fetch", fetcher);
  const view = render(AuthorPage, { data: pageData() });
  await fireEvent.click(view.getByRole("button", { name: "Remove selected file" }));
  await fireEvent.input(view.getByRole("textbox", { name: "Add a file" }), { target: { value: "src/nested/new.ts" } });
  await fireEvent.click(view.getByRole("button", { name: "Add file" }));
  await fireEvent.click(view.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const input = JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).input;
  expect(input.deletes).toEqual(["extension.ts"]);
  expect(input.writes).toEqual({ "src/helper.ts": "helper", "src/nested/new.ts": "" });
});

test("approval requires explicit review and sends only the exact approval ID", async () => {
  const data = pageData(true);
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => Response.json(url.endsWith("/approve") ? {} : data.state));
  vi.stubGlobal("fetch", fetcher);
  const view = render(AuthorPage, { data });
  const approve = view.getByRole("button", { name: "Approve exact release" });
  expect(approve).toBeDisabled();
  expect(view.getByText("exact-release-digest")).toBeVisible();
  await fireEvent.click(view.getByRole("checkbox"));
  await fireEvent.click(approve);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(fetcher.mock.calls[0]![0]).toBe("/api/extensions/releases/installation/approve");
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ approvalId: "approval", decision: true });
});

test("non-session visitors cannot approve", () => {
  const view = render(AuthorPage, { data: pageData(true, false) });
  expect(view.getByRole("checkbox")).toBeDisabled();
  expect(view.getByRole("button", { name: "Approve exact release" })).toBeDisabled();
  expect(view.getByRole("button", { name: "Reject" })).toBeDisabled();
});

test("empty workspace list offers an isolated scaffold, not an install shortcut", async () => {
  const data = { ...pageData(), state: null, workspace: null, files: {}, installations: [], projects: [], projectBinding: null, canBindProject: false };
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ openUrl: "/extensions/author?installation=new" }));
  vi.stubGlobal("fetch", fetcher);
  const view = render(AuthorPage, { data });
  expect(view.getByText("No workspaces yet.")).toBeVisible();
  await fireEvent.input(view.getByLabelText("Extension name"), { target: { value: "new-extension" } });
  await fireEvent.click(view.getByRole("button", { name: "Create workspace" }));
  await waitFor(() => expect(goto).toHaveBeenCalledWith("/extensions/author?installation=new", { invalidateAll: true }));
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ tool: "extensions_workspace", input: { action: "create", name: "new-extension" } });
});

test("create failures show the error and do not navigate", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 503 })));
  const view = render(AuthorPage, { data: { ...pageData(), state: null, workspace: null, files: {}, installations: [], projects: [], projectBinding: null, canBindProject: false } });
  await fireEvent.click(view.getByRole("button", { name: "Create workspace" }));
  await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Request failed (503)"));
  expect(goto).not.toHaveBeenCalled();
});

test("file switching changes the editor without saving or losing content", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const view = render(AuthorPage, { data: pageData() });
  await fireEvent.input(view.getByRole("textbox", { name: "Source: extension.ts" }), { target: { value: "kept" } });
  await fireEvent.click(view.getByRole("button", { name: "src/helper.ts" }));
  expect(view.getByRole("textbox", { name: "Source: src/helper.ts" })).toHaveValue("helper");
  await fireEvent.click(view.getByRole("button", { name: "extension.ts" }));
  expect(view.getByRole("textbox", { name: "Source: extension.ts" })).toHaveValue("kept");
  expect(fetcher).not.toHaveBeenCalled();
});

test("traversal, empty and duplicate file names cannot alter the workspace", async () => {
  const view = render(AuthorPage, { data: pageData() });
  for (const path of ["", "extension.ts", "../escape.ts", "/absolute.ts", "bad\\\\file.ts", "empty//file.ts"]) {
    await fireEvent.input(view.getByLabelText("Add a file"), { target: { value: path } });
    await fireEvent.click(view.getByRole("button", { name: "Add file" }));
    expect(view.getByRole("alert")).toBeVisible();
  }
  expect(view.getByRole("textbox", { name: "Source: extension.ts" })).toHaveValue("original");
  expect(view.getByRole("button", { name: "Save revision" })).toBeDisabled();
});

test("removing every file leaves a recoverable empty editor", async () => {
  const view = render(AuthorPage, { data: pageData() });
  await fireEvent.click(view.getByRole("button", { name: "Remove selected file" }));
  await fireEvent.click(view.getByRole("button", { name: "Remove selected file" }));
  expect(view.getByText("Add a file to begin.")).toBeVisible();
  expect(view.getByRole("button", { name: "Remove selected file" })).toBeDisabled();
});

test("an in-flight build blocks concurrent actions and preserves unsaved edits on failure", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
  vi.stubGlobal("fetch", fetcher);
  const view = render(AuthorPage, { data: pageData() });
  await fireEvent.click(view.getByRole("button", { name: "Save and build" }));
  expect(view.getByRole("button", { name: "Building…" })).toBeDisabled();
  expect(view.getByRole("button", { name: "Refresh status" })).toBeDisabled();
  expect(view.getByRole("textbox", { name: "Source: extension.ts" })).toBeDisabled();
  finish(Response.json({ message: "Runner unavailable" }, { status: 503 }));
  await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Runner unavailable"));
  expect(view.getByRole("textbox", { name: "Source: extension.ts" })).toHaveValue("original");
});

test("manual refresh leaves edited source untouched", async () => {
  const data = pageData();
  vi.stubGlobal("fetch", vi.fn(async (_url: string, _init?: RequestInit) => Response.json(data.state)));
  const view = render(AuthorPage, { data });
  await fireEvent.input(view.getByRole("textbox", { name: "Source: extension.ts" }), { target: { value: "unsaved" } });
  await fireEvent.click(view.getByRole("button", { name: "Refresh status" }));
  await waitFor(() => expect(view.getByRole("button", { name: "Refresh status" })).toBeEnabled());
  expect(view.getByRole("textbox", { name: "Source: extension.ts" })).toHaveValue("unsaved");
});

test("dirty source warns on browser exit, saved source does not", async () => {
  const view = render(AuthorPage, { data: pageData() });
  const savedEvent = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(savedEvent); expect(savedEvent.defaultPrevented).toBe(false);
  await fireEvent.input(view.getByRole("textbox", { name: "Source: extension.ts" }), { target: { value: "unsaved" } });
  const dirtyEvent = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(dirtyEvent); expect(dirtyEvent.defaultPrevented).toBe(true);
});

test("human rejection targets one approval without activating code", async () => {
  const data = pageData(true);
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(data.state)); vi.stubGlobal("fetch", fetcher);
  const view = render(AuthorPage, { data });
  await fireEvent.click(view.getByRole("button", { name: "Reject" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ approvalId: "approval", decision: false });
  expect(fetcher.mock.calls.every((call) => !String(call[1]?.body).includes('"activate"'))).toBe(true);
});

test("approved activation and disable send explicit lifecycle actions", async () => {
  const data = pageData(true); data.state!.approvals.approval!.status = "approved";
  data.state!.installation = { ...installation, enabled: true };
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(data.state)); vi.stubGlobal("fetch", fetcher);
  const view = render(AuthorPage, { data });
  await fireEvent.click(view.getByRole("button", { name: "Activate approved release" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ tool: "extensions_release", input: { action: "activate", approvalId: "approval" } });
  await fireEvent.click(view.getByRole("button", { name: "Disable installation" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
  expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body))).toMatchObject({ tool: "extensions_release", input: { action: "disable" } });
});
