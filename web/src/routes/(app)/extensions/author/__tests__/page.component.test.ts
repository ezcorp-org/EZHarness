import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/svelte";
import { afterEach, expect, test, vi } from "vitest";
import AuthorPage from "../+page.svelte";

vi.mock("$app/navigation", () => ({ goto: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function data(overrides: Record<string, unknown> = {}) {
  const installation = {
    id: "installation",
    ownerId: "owner",
    scope: "global",
    activeReleaseId: "release",
    generation: 4,
    enabled: true,
    uninstalled: false,
    status: "active",
    grants: [],
    acknowledgedGeneration: 4,
  };
  const workspace = { id: "workspace", installationId: installation.id, revision: 3, sourceDigest: "source", createdAt: "now" };
  return {
    state: {
      installation,
      workspaces: { workspace },
      revisions: {},
      operations: {},
      releases: { release: { id: "release", manifest: { name: "weather", version: "1.0.0", permissions: {} }, releaseDigest: "release-digest", sourceDigest: "source", artifactDigest: "artifact", runnerProfile: "podman", imageDigest: "image", evidence: { tests: [] } } },
      approvals: {},
    },
    workspace,
    files: { "extension.ts": "export {}" },
    installations: [installation],
    canApprove: true,
    canBindProject: false,
    projects: [],
    projectBinding: null,
    ...overrides,
  } as any;
}

test("uninstalled installations keep visible retained history but cannot be activated or disabled", () => {
  const input = data();
  input.state.installation = { ...input.state.installation, uninstalled: true, enabled: false, status: "uninstalled" };
  const view = render(AuthorPage, { data: input });
  expect(view.getByRole("status")).toHaveTextContent("retained build history");
  expect(view.getByText("Previously active")).toBeVisible();
  expect(view.getByRole("button", { name: "Disable installation" })).toBeDisabled();
  expect(view.queryByRole("button", { name: "Activate approved release" })).not.toBeInTheDocument();
});

test("renders a runner diagnostic with its exact stage, code and source location", () => {
  const input = data();
  input.state.operations = {
    build: { id: "build", state: "failed", diagnostics: [{ stage: "verify", code: "TEST_FAILED", message: "expected true", file: "src/extension.ts", line: 9 }] },
  };
  const view = render(AuthorPage, { data: input });
  expect(view.getByText("verify / TEST_FAILED")).toBeVisible();
  expect(view.getByText("expected true")).toBeVisible();
  expect(view.getByText("src/extension.ts:9")).toBeVisible();
  expect(view.getByText("build")).toBeVisible();
});

test("shows exact release evidence without creating an implicit approval control", () => {
  const view = render(AuthorPage, { data: data() });
  expect(view.getByText("release-digest")).toBeVisible();
  expect(view.getByText("artifact")).toBeVisible();
  expect(view.getByRole("button", { name: "Request approval" })).toBeEnabled();
  expect(view.queryByRole("button", { name: "Approve exact release" })).not.toBeInTheDocument();
});

test("a missing saved source offers recovery without exposing edit or build controls", () => {
  const input = data({ workspace: null, files: {}, sourceUnavailable: { workspaceId: "workspace" } });
  input.state.workspaces.available = { id: "available", installationId: "installation", revision: 2, sourceDigest: "other", createdAt: "later" };
  const view = render(AuthorPage, { data: input });
  expect(view.getByRole("alert")).toHaveTextContent("Saved source is unavailable");
  expect(view.getByRole("link", { name: "Import source to create a new candidate" })).toHaveAttribute("href", "/extensions/import-source");
  expect(view.getByRole("link", { name: "Revision 2" })).toHaveAttribute("href", "?installation=installation&workspace=available");
  expect(view.queryByRole("button", { name: "Save revision" })).not.toBeInTheDocument();
  expect(view.queryByRole("button", { name: "Save and build" })).not.toBeInTheDocument();
  expect(view.getByRole("button", { name: "Request approval" })).toBeDisabled();
});

test("a missing saved source does not substitute another revision", () => {
  const view = render(AuthorPage, { data: data({ workspace: null, files: {}, sourceUnavailable: { workspaceId: "workspace" } }) });
  expect(view.getByRole("alert")).toHaveTextContent("No other saved workspaces are available.");
  expect(view.queryByRole("link", { name: /Revision/ })).not.toBeInTheDocument();
});

test("the heading and title name the extension being edited", () => {
  const view = render(AuthorPage, { data: data({ extensionName: "memory-extractor" }) });
  expect(view.getByRole("heading", { level: 1 })).toHaveTextContent("memory-extractor");
  expect(document.title).toBe("memory-extractor · Extension workspace");
});

test("without a resolved name the page keeps its generic heading", () => {
  const view = render(AuthorPage, { data: data({ extensionName: null }) });
  expect(view.getByRole("heading", { level: 1 })).toHaveTextContent("Extension workspace");
  expect(document.title).toBe("Extension workspace");
});

test("the installations list links by extension name and keeps the id as secondary text", () => {
  const input = data({ state: null, workspace: null, files: {}, installations: [{ id: "installation-a", status: "active", name: "memory-extractor" }] });
  const view = render(AuthorPage, { data: input });
  const link = view.getByRole("link", { name: /memory-extractor/ });
  expect(link).toHaveAttribute("href", "?installation=installation-a");
  expect(link).toHaveTextContent("memory-extractor");
  expect(link).toHaveTextContent("installation-a");
  expect(view.getByText("installation-a")).toHaveClass("installation-id");
});

test("an installation with no known name falls back to its id alone", () => {
  const input = data({ state: null, workspace: null, files: {}, installations: [{ id: "installation-b", status: "disabled", name: null }] });
  const view = render(AuthorPage, { data: input });
  expect(view.getByRole("link", { name: /installation-b/ })).toHaveAttribute("href", "?installation=installation-b");
  expect(view.container.querySelector(".installation-id")).toBeNull();
  expect(view.getByText("disabled")).toHaveClass("installation-status");
});
