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
