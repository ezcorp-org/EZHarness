import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, expect, test, vi } from "vitest";
import type { ComponentProps } from "svelte";
import Page from "../routes/(app)/extensions/import-source/+page.svelte";
import { goto } from "$app/navigation";
vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
const data: ComponentProps<typeof Page>["data"] = { canCreate: true, targets: [{ id: "owned", name: "Existing extension" }], projects: [{ id: "project", name: "Private repository" }], selectedTarget: "" };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function transport(response = Response.json({ installation: { id: "installation" }, workspace: { id: "workspace" } })) {
  const fetcher = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
test("GitHub import carries explicit target and project references but never approval or credentials", async () => {
  const fetcher = transport();
  const view = render(Page, { data });
  const submit = view.getByRole("button", { name: "Import and build candidate" });
  expect(submit).toBeDisabled();
  await fireEvent.change(view.getByLabelText("Installation"), { target: { value: "owned" } });
  await fireEvent.input(view.getByLabelText("GitHub repository"), { target: { value: " owner/repository " } });
  await fireEvent.input(view.getByLabelText(/Branch, tag, or commit/), { target: { value: "main" } });
  await fireEvent.input(view.getByLabelText(/Subdirectory/), { target: { value: "extensions/example" } });
  await fireEvent.change(view.getByLabelText("Private repository access"), { target: { value: "project" } });
  await fireEvent.click(submit);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const [path, options] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
  expect(path).toBe("/api/extensions/import-source");
  expect(JSON.parse(String(options.body))).toEqual({ kind: "github", repository: "owner/repository", ref: "main", directory: "extensions/example", projectId: "project", targetInstallationId: "owned" });
  await waitFor(() => expect(goto).toHaveBeenCalledWith("/extensions/author?installation=installation&workspace=workspace"));
  expect(view.getByText("Import does not approve, activate, or replace an active release.")).toBeVisible();
});
test("member view offers only owned targets and no host-local or create controls", async () => {
  transport();
  const view = render(Page, { data: { ...data, canCreate: false, selectedTarget: "owned" } });
  expect(view.queryByRole("option", { name: "Create a new installation" })).not.toBeInTheDocument();
  expect(view.queryByRole("option", { name: "Host source directory" })).not.toBeInTheDocument();
  expect(view.getByLabelText("Installation")).toHaveValue("owned");
  cleanup();
  const empty = render(Page, { data: { ...data, canCreate: false, targets: [] } });
  expect(empty.getByText(/You do not own an installation yet/)).toBeVisible();
  expect(empty.getByRole("button", { name: "Import and build candidate" })).toBeDisabled();
});
for (const [kind, label, value, field] of [["marketplace", "Marketplace version ID", "version", "versionId"], ["local", "Source directory", "/approved/source", "path"], ["bundled", "Bundled extension name", "scratchpad", "name"]]) test(`${kind} imports use only their supported source fields`, async () => {
  const fetcher = transport();
  const view = render(Page, { data });
  await fireEvent.change(view.getByLabelText("Source type"), { target: { value: kind } });
  await fireEvent.input(view.getByLabelText(label!), { target: { value } });
  await fireEvent.click(view.getByRole("button", { name: "Import and build candidate" }));
  await waitFor(() => expect(goto).toHaveBeenCalled());
  expect(JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ kind, [field!]: value });
});
test("failed imports stay on the form with an accessible error and can be retried", async () => {
  transport(Response.json({ message: "Source access denied" }, { status: 403 }));
  const view = render(Page, { data });
  await fireEvent.input(view.getByLabelText("GitHub repository"), { target: { value: "owner/repository" } });
  await fireEvent.click(view.getByRole("button", { name: "Import and build candidate" }));
  await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Source access denied"));
  expect(goto).not.toHaveBeenCalled();
  expect(view.getByRole("button", { name: "Import and build candidate" })).toBeEnabled();
});
test("invalid server workspace responses cannot navigate to an arbitrary location", async () => {
  transport(Response.json({ openUrl: "https://attacker.invalid" }));
  const view = render(Page, { data });
  await fireEvent.input(view.getByLabelText("GitHub repository"), { target: { value: "owner/repository" } });
  await fireEvent.click(view.getByRole("button", { name: "Import and build candidate" }));
  await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("did not return a source workspace"));
  expect(goto).not.toHaveBeenCalled();
});
