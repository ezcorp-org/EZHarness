import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./hydration.js";
import { HarnessClient } from "../../../packages/@ezcorp/harness-client/src/index";
import type { InstallationState, LifecycleOperation, WorkspaceRecord, InstallationRecord, LifecycleApproval } from "../../../src/extensions/v4/types";
import { buildElapsedMs, nextBuildClock, type BuildClock } from "./extension-build-clock.js";

export interface CreatedWorkspace { installation: InstallationRecord; workspace: WorkspaceRecord; openUrl: string }

export async function extensionClient(request: APIRequestContext, baseURL: string, scopes = ["read", "chat", "extensions"]): Promise<{ client: HarnessClient; key: string }> {
  const response = await request.post("/api/settings/developer/api-keys", { data: { name: `extension-v4-${crypto.randomUUID()}`, scopes } });
  expect(response.status(), await response.text()).toBe(201);
  const { key } = await response.json();
  return { client: new HarnessClient({ baseUrl: baseURL, apiKey: key }), key };
}

export async function buildWorkspace(client: HarnessClient, created: CreatedWorkspace, deadline: BuildDeadline = buildDeadline()): Promise<InstallationState> {
  const operation = await client.extensionControl<LifecycleOperation>("extensions_build", { installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: created.workspace.revision, idempotencyKey: crypto.randomUUID() });
  return waitForExtensionBuild(client, created.installation.id, operation.id, deadline);
}

/**
 * Two fail-closed bounds for the isolated candidate build.
 *
 * The real server owns ONE isolated runner, and right after the first
 * administrator becomes active it builds every bundled extension through it
 * (src/extensions/bundled-bootstrap.ts): 29 serial builds, several minutes on
 * a CI host. A candidate build queued behind them is re-queued with a
 * retryable `runner_busy` diagnostic (src/extensions/v4/lifecycle.ts). The
 * server does not log that parking, so its share is inferred: on the green
 * run 34753638464 the round-trip spec took 4.0 minutes while its two builds
 * take well under a minute each on a quiet host. Queued time is therefore not
 * build time — the build budget only runs while the runner holds the
 * operation (extension-build-clock.ts) — and it is bounded by a
 * `BuildDeadline` that a spec with several builds SHARES across them. A
 * single 240s budget over both phases failed exactly when the boot queue ran
 * a little long (CI runs 34538349926, 34753665125).
 *
 * Every bound is also capped below the running test's own timeout: a bare
 * Playwright timeout would hide which bound tripped and which state the
 * operation was in. Budget arithmetic for a spec that needs the full
 * allowance: RUNNER_WAIT_BUDGET_MS (one shared deadline) + ACTIVATION_BUDGET_MS
 * per activation + its own UI steps must fit `test.setTimeout`, and that must
 * fit the ci.yml job `timeout-minutes` with the rest of the lane.
 */
const BUILD_BUDGET_MS = 240_000;
const RUNNER_WAIT_BUDGET_MS = 480_000;
const INSPECT_WAIT_MS = 1_000;
/** Leave this much of the test timeout for the fixture message and teardown. */
const TEST_TIMEOUT_MARGIN_MS = 15_000;

/** `budgetMs`, or less when the running test's timeout could not hold it. */
function withinTestTimeout(budgetMs: number): number {
  const testTimeout = test.info().timeout;
  if (testTimeout <= 0) return budgetMs;
  return Math.min(budgetMs, Math.max(testTimeout - TEST_TIMEOUT_MARGIN_MS, 1_000));
}

/** One allowance for runner parking plus builds, shared by every build wait it is passed to. */
export interface BuildDeadline { readonly until: number }
export function buildDeadline(now = Date.now()): BuildDeadline {
  return { until: now + withinTestTimeout(RUNNER_WAIT_BUDGET_MS) };
}
/**
 * Activation is one server call that verifies the candidate, prepares
 * migrations and publishes the release to the runtime before the page's
 * refresh reports `enabled` (src/extensions/v4/lifecycle.ts `activate`,
 * extension-lifecycle-service.ts `publish`). Playwright's 5s default assumed
 * an idle host; on CI run 34755508391 the button was still disabled at 5s
 * while the boot-time bundled builds were still loading the runtime. No run
 * has measured how long it took, so this is a ceiling on a documented state,
 * not a measured duration; it is capped below the test timeout like the rest.
 */
const ACTIVATION_BUDGET_MS = 120_000;

export async function waitForExtensionBuild(client: HarnessClient, installationId: string, operationId: string, deadline: BuildDeadline = buildDeadline()): Promise<InstallationState> {
  let clock: BuildClock = {};
  for (;;) {
    // The server long-polls for `waitMs` (extension-control.ts `inspect`), so
    // one turn is about a second — unless its own read took that long, in
    // which case it returns at once. Pace the client too, so a slow
    // single-writer PGlite never sees a tight loop competing with the build.
    const requestedAt = Date.now();
    const state = await client.extensionControl<InstallationState>("extensions_inspect", { installationId, operationId, waitMs: INSPECT_WAIT_MS });
    const operation = state.operations[operationId]!;
    if (!/^(queued|building|verifying)$/.test(operation.state)) {
      expect(operation.state, JSON.stringify(operation.diagnostics)).toBe("verified");
      expect(state.releases[operation.releaseId!]).toBeDefined();
      return state;
    }
    const now = Date.now();
    clock = nextBuildClock(clock, operation, now);
    const detail = `state=${operation.state} diagnostics=${JSON.stringify(operation.diagnostics)}`;
    expect(buildElapsedMs(clock, now), `The real isolated candidate build must finish within ${BUILD_BUDGET_MS}ms once the runner takes it (${detail}).`).toBeLessThanOrEqual(BUILD_BUDGET_MS);
    expect(now, `The real isolated candidate build must finish within its shared allowance for queueing and builds (${RUNNER_WAIT_BUDGET_MS}ms, or less inside a shorter test timeout) (${detail}).`).toBeLessThanOrEqual(deadline.until);
    const remaining = INSPECT_WAIT_MS - (Date.now() - requestedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

export async function requestRelease(client: HarnessClient, state: InstallationState, releaseId?: string): Promise<LifecycleApproval> {
  const release = releaseId ? state.releases[releaseId]! : Object.values(state.releases)[0]!;
  const result = await client.extensionControl<{ approval: LifecycleApproval }>("extensions_release", { installationId: state.installation.id, action: "requestApproval", releaseId: release.id, expectedActiveReleaseId: state.installation.activeReleaseId });
  return result.approval;
}

export async function createAndActivateExtension({ page, request, baseURL, name, deadline = buildDeadline() }: {
  page: Page; request: APIRequestContext; baseURL: string; name: string; deadline?: BuildDeadline;
}): Promise<{ client: HarnessClient; state: InstallationState }> {
  const { client } = await extensionClient(request, baseURL);
  const created = await client.extensionControl<CreatedWorkspace>("extensions_workspace", { action: "create", name });
  const state = await buildWorkspace(client, created, deadline);
  const release = Object.values(state.releases)[0]!;
  return { client, state: await approveAndActivateWorkspace(page, client, created, state, release.id) };
}

export async function approveAndActivateWorkspace(page: Page, client: HarnessClient, created: CreatedWorkspace, state: InstallationState, releaseId: string): Promise<InstallationState> {
  await requestRelease(client, state, releaseId);
  await page.goto(created.openUrl);
  const approve = page.getByRole("button", { name: "Approve exact release", exact: true });
  await expect(approve).toBeDisabled();
  await page.getByLabel("I reviewed this release and its permissions.").check();
  await approve.click();
  await page.getByRole("button", { name: "Activate approved release", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disable installation", exact: true })).toBeEnabled({ timeout: withinTestTimeout(ACTIVATION_BUDGET_MS) });
  const active = await client.extensionControl<InstallationState>("extensions_inspect", { installationId: created.installation.id });
  expect(active.installation.activeReleaseId).toBe(releaseId);
  expect(active.installation.enabled).toBe(true);
  expect(active.installation.acknowledgedGeneration).toBe(active.installation.generation);
  return active;
}

export async function importAndActivateBundledExtension({ page, request, baseURL, name }: {
  page: Page; request: APIRequestContext; baseURL: string; name: string;
}): Promise<{ client: HarnessClient; state: InstallationState }> {
  const { client } = await extensionClient(request, baseURL);
  const listed = await request.get(`/api/extensions?name=${encodeURIComponent(name)}`);
  expect(listed.status(), await listed.text()).toBe(200);
  const existing = (await listed.json() as Array<{ id: string; name: string }>).find(extension => extension.name === name);
  const imported = await request.post("/api/extensions/import-source", {
    data: { kind: "bundled", name, ...(existing ? { targetInstallationId: existing.id } : {}) },
  });
  expect(imported.status(), await imported.text()).toBe(200);
  const created = await imported.json() as CreatedWorkspace & { operation: LifecycleOperation };
  const state = await waitForExtensionBuild(client, created.installation.id, created.operation.id);
  const release = state.releases[state.operations[created.operation.id]!.releaseId!]!;
  expect(release.manifest.name).toBe(name);
  const active = await approveAndActivateWorkspace(page, client, created, state, release.id);
  // Event-only extensions (for example Kokoro TTS) intentionally have no
  // tool endpoint. Query and compare the registry only when the release
  // actually declares callable tools; a 404 is meaningful for an event-only
  // manifest and must not make activation appear to fail.
  const declaredTools = release.manifest.tools ?? [];
  if (declaredTools.length > 0) {
    const tools = await request.get(`/api/extensions/${encodeURIComponent(name)}/tools`);
    expect(tools.status(), await tools.text()).toBe(200);
    expect((await tools.json()).tools.map((tool: { name: string }) => tool.name).sort()).toEqual(declaredTools.map(tool => tool.name).sort());
  }
  return { client, state: active };
}
