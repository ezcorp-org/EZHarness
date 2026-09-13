import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
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

// ── trusted-local (unsandboxed) mode: the two acknowledgement points ──────
// The server refuses a build or an approval without the acknowledgement
// (`unsandboxed_acknowledgement_required`); these prove the page never lets
// a person reach that refusal, and that an isolated host shows none of it.
const TRUSTED_LOCAL = { extensionRunnerMode: "trusted-local", trustedLocalProfile: "trusted-local-v4", unsandboxedOmittedControls: ["filesystem-isolation", "cgroup-memory"] };

function pendingApproval(runnerProfile: string) {
  return { id: "approval", installationId: "installation", releaseId: "release", releaseDigest: "release-digest", principalId: "owner", scope: "global", grants: [], runnerProfile, expectedActiveReleaseId: "release", expectedGeneration: 4, status: "pending", createdAt: "now" };
}

test("an isolated host shows no unsandboxed notes and Build needs no acknowledgement", () => {
  const input = data();
  input.state.approvals = { approval: pendingApproval("podman") };
  const view = render(AuthorPage, { data: input });
  expect(view.queryByTestId("unsandboxed-build-note")).not.toBeInTheDocument();
  expect(view.queryByTestId("unsandboxed-approval-note")).not.toBeInTheDocument();
  expect(view.queryByLabelText(/without a sandbox/)).not.toBeInTheDocument();
  expect(view.getByRole("button", { name: "Save and build" })).toBeEnabled();
  expect(view.getByText("Build in isolation. Review the exact release. Activate only after approval.")).toBeVisible();
});

test("on a trusted-local host, Build names the missing controls and stays disabled until acknowledged", async () => {
  const view = render(AuthorPage, { data: data(TRUSTED_LOCAL) });
  expect(view.getByText(/No sandbox on this host\. Every build and every release/)).toBeVisible();
  const note = view.getByTestId("unsandboxed-build-note");
  expect(note).toHaveAttribute("role", "note");
  expect(note).toHaveTextContent("filesystem-isolation, cgroup-memory");
  const build = view.getByRole("button", { name: "Save and build" });
  expect(build).toBeDisabled();
  await fireEvent.click(view.getByLabelText("I understand this build runs without a sandbox."));
  expect(build).toBeEnabled();
});

test("an approval for a trusted-local release needs BOTH checkboxes before Approve exact release enables", async () => {
  const input = data(TRUSTED_LOCAL);
  input.state.approvals = { approval: pendingApproval("trusted-local-v4") };
  const view = render(AuthorPage, { data: input });
  expect(view.getByTestId("unsandboxed-approval-note")).toHaveTextContent("Not isolated");
  const approve = view.getByRole("button", { name: "Approve exact release" });
  expect(approve).toBeDisabled();
  await fireEvent.click(view.getByLabelText("I reviewed this release and its permissions."));
  // The ordinary review checkbox alone is not enough here.
  expect(approve).toBeDisabled();
  await fireEvent.click(view.getByLabelText("I understand this extension will run without a sandbox."));
  expect(approve).toBeEnabled();
  // Rejecting never needs the acknowledgement.
  expect(view.getByRole("button", { name: "Reject" })).toBeEnabled();
});

test("the approval's OWN profile decides, not the host's mode — a podman-built approval shows no unsandboxed note even on a trusted-local host", () => {
  const input = data(TRUSTED_LOCAL);
  input.state.approvals = { approval: pendingApproval("podman") };
  const view = render(AuthorPage, { data: input });
  expect(view.queryByTestId("unsandboxed-approval-note")).not.toBeInTheDocument();
  expect(view.queryByLabelText("I understand this extension will run without a sandbox.")).not.toBeInTheDocument();
});
