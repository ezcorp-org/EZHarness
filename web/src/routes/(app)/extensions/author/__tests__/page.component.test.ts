import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, expect, test, vi } from "vitest";
import type { ComponentProps } from "svelte";
import type { InstallationState } from "$server/extensions/v4/types";
import AuthorPage from "../+page.svelte";

vi.mock("$app/navigation", () => ({ goto: vi.fn() }));

const installation = { id: "installation", ownerId: "owner", scope: "global", activeReleaseId: null, generation: 0, enabled: false, uninstalled: false, status: "disabled" as const, grants: [], acknowledgedGeneration: 0 };
const workspace = { id: "workspace", installationId: installation.id, revision: 1, sourceDigest: "source", createdAt: "2026-09-04" };

function pageData(approval = false, canApprove = true): ComponentProps<typeof AuthorPage>["data"] {
  const state: InstallationState = { installation, workspaces: { workspace }, revisions: {}, operations: {}, releases: {}, approvals: approval ? { approval: { id: "approval", installationId: installation.id, releaseId: "release", releaseDigest: "exact-release-digest", principalId: "owner", scope: "global", grants: ['["storage",true]'], runnerProfile: "podman", expectedActiveReleaseId: null, expectedGeneration: 0, status: "pending", createdAt: "2026-09-04" } } : {} };
  return { state, workspace, files: { "extension.ts": "original", "src/helper.ts": "helper" }, installations: [installation], canApprove } as ComponentProps<typeof AuthorPage>["data"];
}

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
  const fetcher = vi.fn(async () => Response.json({ message: "Revision conflict. Reload before editing." }, { status: 409 }));
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
