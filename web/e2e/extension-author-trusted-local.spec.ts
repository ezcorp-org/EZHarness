/**
 * The unsandboxed (`trusted-local`) extension mode, end to end through the
 * real server, the real lifecycle and — under
 * web/playwright.trusted-local.config.ts — the REAL in-process
 * TrustedLocalRunner building, typechecking and testing a workspace as a
 * plain process.
 *
 * One spec, two servers, decided by the server (`/api/auth/me` reports the
 * mode), no `.skip`:
 *   - the ordinary real-auth server (isolated runner): the mode leaves NO
 *     trace — no banner, no acknowledgement notes, Build enabled as before;
 *   - the trusted-local server: the standing banner, both acknowledgement
 *     points gating their buttons, the API refusing a build and an approval
 *     that lack the acknowledgement (`unsandboxed_acknowledgement_required`),
 *     and a release stamped `trusted-local-v4` / `localhost/trusted-local@`.
 */
import { test, expect } from "./fixtures/hydration.js";
import { captureEvidence } from "./fixtures/evidence.js";
import { buildWorkspace, extensionClient, requestRelease, type CreatedWorkspace } from "./fixtures/extension-v4.js";
import type { InstallationState } from "../../src/extensions/v4/types";

test("trusted-local: two acknowledgements, API refusals without them, standing banner @evidence", async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(300_000);
  const me = await request.get("/api/auth/me");
  expect(me.status(), await me.text()).toBe(200);
  const { extensionRunner } = await me.json() as { extensionRunner: string };
  const { client } = await extensionClient(request, baseURL!);
  const name = `trusted-local-${crypto.randomUUID().slice(0, 8)}`;
  const created = await client.extensionControl<CreatedWorkspace>("extensions_workspace", { action: "create", name });

  try {
    await page.goto(created.openUrl);
    await expect(page.getByRole("heading", { name: "Extension workspace", exact: true })).toBeVisible();
    const banner = page.getByTestId("unsandboxed-extensions-banner");
    const buildNote = page.getByTestId("unsandboxed-build-note");
    const build = page.getByRole("button", { name: "Save and build", exact: true });

    if (extensionRunner !== "trusted-local") {
      // Isolated host. The only acceptable other answer is the default, and
      // nothing about the unsandboxed mode may show.
      expect(extensionRunner).toBe("isolated");
      await expect(banner).toHaveCount(0);
      await expect(buildNote).toHaveCount(0);
      await expect(build).toBeEnabled();
      return;
    }

    // ── Standing banner + first acknowledgement point (Build) ──────────
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("not sandboxed");
    await expect(buildNote).toBeVisible();
    await expect(buildNote).toContainText("cgroup-memory");
    await expect(build).toBeDisabled();
    await page.getByLabel("I understand this build runs without a sandbox.").check();
    await expect(build).toBeEnabled();

    // The API refuses a build that lacks the acknowledgement — the UI gate is
    // a courtesy, the server is the rule.
    const refusedBuild = await request.post("/api/extensions/control", { data: { tool: "extensions_build", input: { installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: created.workspace.revision, idempotencyKey: crypto.randomUUID() } } });
    expect(refusedBuild.status(), await refusedBuild.text()).toBeGreaterThanOrEqual(400);
    expect((await refusedBuild.json()).code).toBe("unsandboxed_acknowledgement_required");

    // With it, the real TrustedLocalRunner builds, typechecks and runs the
    // scaffold's own test as a plain process, and stamps the release so it
    // can never be mistaken for an isolated one.
    const built = await buildWorkspace(client, created, { acknowledgeUnsandboxed: true });
    const release = Object.values(built.releases)[0]!;
    expect(release.runnerProfile).toBe("trusted-local-v4");
    expect(release.imageDigest).toMatch(/^localhost\/trusted-local@sha256:[a-f0-9]{64}$/);

    // ── Second acknowledgement point (Approve exact release) ───────────
    const approval = await requestRelease(client, built, release.id);
    const refusedApprove = await request.post(`/api/extensions/releases/${created.installation.id}/approve`, { data: { approvalId: approval.id, decision: true } });
    expect(refusedApprove.status(), await refusedApprove.text()).toBeGreaterThanOrEqual(400);
    expect((await refusedApprove.json()).code).toBe("unsandboxed_acknowledgement_required");

    await page.reload();
    await expect(page.getByTestId("unsandboxed-approval-note")).toBeVisible();
    const approve = page.getByRole("button", { name: "Approve exact release", exact: true });
    await expect(approve).toBeDisabled();
    await page.getByLabel("I reviewed this release and its permissions.").check();
    // The ordinary review checkbox alone is not enough here.
    await expect(approve).toBeDisabled();
    await page.getByLabel("I understand this extension will run without a sandbox.").check();
    await expect(approve).toBeEnabled();
    await captureEvidence(page, testInfo, "trusted-local-approval-card");
    await approve.click();

    await page.getByRole("button", { name: "Activate approved release", exact: true }).click();
    await expect(page.getByRole("button", { name: "Disable installation", exact: true })).toBeEnabled();
    const active = await client.extensionControl<InstallationState>("extensions_inspect", { installationId: created.installation.id });
    expect(active.installation.activeReleaseId).toBe(release.id);
    expect(active.installation.enabled).toBe(true);
    await captureEvidence(page, testInfo, "trusted-local-active-with-banner");
  } finally {
    const removed = await request.delete(`/api/extensions/${created.installation.id}`);
    expect(removed.status(), await removed.text()).toBe(204);
  }
});
