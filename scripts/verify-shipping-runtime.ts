/** Production R1: recover one paused v2 build after an owned app SIGKILL.
 *
 * The launcher supplies an isolated app, runner store, API key, and human
 * session. This script only pauses the derived runner container and kills the
 * launcher's exact app container.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessClient } from "@ezcorp/harness-client";
import type { RunnerInspection } from "@ezcorp/extension-contract";
import type { InstallationRecord, InstallationState, LifecycleOperation, WorkspaceRecord } from "../src/extensions/v4/types";
import { command, inspectProductionRunner, productionLifecycleClient, required } from "./lib/production-lifecycle-client";
import { echoSource, echoText } from "./lib/shipping-runtime-helpers";
import { requireBundledBootstrapVerified, waitForBundledBootstrap } from "./lib/shipping-bootstrap-state";

type WorkspaceResult = { installation: InstallationRecord; workspace: WorkspaceRecord };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function podman(args: string[]): Promise<string> {
  return command("podman", args);
}

type RunnerEvidence = RunnerInspection | { error: string };

function safeRunnerError(error: unknown): string {
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code;
  return error instanceof Error ? error.name : "runner_inspect_failed";
}

function requireRunnerState(evidence: RunnerEvidence, expected: readonly RunnerInspection["state"][], point: string): void {
  if ("error" in evidence) throw new Error(`Owned runner inspect failed ${point}: ${evidence.error}`);
  if (!expected.includes(evidence.state)) throw new Error(`Owned runner state ${evidence.state} ${point}; expected ${expected.join(", ")}.`);
}

async function ownedRunnerState(operationId: string): Promise<RunnerEvidence> {
  try {
    return await inspectProductionRunner(operationId);
  } catch (error) {
    return { error: safeRunnerError(error) };
  }
}

async function captureBuildFailure(installationId: string, state: InstallationState, operationId: string): Promise<void> {
  const operation = state.operations[operationId];
  const evidence = {
    installationId,
    operationId,
    lifecycle: { state: operation?.state, releaseId: operation?.releaseId, lease: operation?.lease, events: operation?.events ?? [], diagnostics: operation?.diagnostics ?? [] },
    runner: operation?.lease?.holder ? await ownedRunnerState(operation.lease.holder) : { error: "runner_operation_missing" },
  };
  await writeFile(join(required("EZ_PRODUCTION_RECEIPT_DIR"), "failed-build-evidence.json"), JSON.stringify(evidence) + "\n", { mode: 0o600 });
}

async function stateOf(client: HarnessClient, installationId: string, operationId?: string, waitMs = 0): Promise<InstallationState> {
  return client.extensionControl<InstallationState>("extensions_inspect", {
    installationId,
    ...(operationId ? { operationId, waitMs } : {}),
  });
}

async function waitForVerified(client: HarnessClient, installationId: string, operationId: string, maxLongPolls = 12, onFailure?: (state: InstallationState) => Promise<void>): Promise<InstallationState> {
  for (let attempt = 1; attempt <= maxLongPolls; attempt++) {
    const state = await stateOf(client, installationId, operationId, 30_000);
    const operation = state.operations[operationId];
    if (operation?.state === "verified" && operation.releaseId) return state;
    if (!operation || !["queued", "building", "verifying"].includes(operation.state)) {
      await onFailure?.(state);
      throw new Error(`Operation ${operationId} did not verify: ${operation?.state ?? "missing"}; diagnostics=${JSON.stringify(operation?.diagnostics ?? [])}`);
    }
  }
  const state = await stateOf(client, installationId, operationId);
  await onFailure?.(state);
  throw new Error(`Operation ${operationId} remained pending after ${maxLongPolls} lifecycle long-polls.`);
}

async function pauseOwnedBuild(client: HarnessClient, installationId: string, operationId: string, store: string): Promise<{ container: string; runnerOperationId: string; attempts: number }> {
  for (let attempt = 1; attempt <= 120; attempt++) {
    const state = await stateOf(client, installationId, operationId);
    const operation = state.operations[operationId];
    if (!operation || !["queued", "building", "verifying"].includes(operation.state)) throw new Error(`Build ended before its owned container could be paused: ${operation?.state ?? "missing"}`);
    const runnerOperationId = operation.lease?.holder;
    if (!runnerOperationId) continue;
    const container = `ez-v4-${sha256(`${store}:${runnerOperationId}`).slice(0, 32)}`;
    try {
      if (await podman(["inspect", "--format", "{{.State.Status}}", container]) !== "running") continue;
      await podman(["pause", container]);
      if (await podman(["inspect", "--format", "{{.State.Status}}", container]) !== "paused") throw new Error(`Owned build container ${container} did not enter paused state.`);
      return { container, runnerOperationId, attempts: attempt };
    } catch (error) {
      if (attempt === 120) throw error;
    }
  }
  throw new Error("No running owned build container was observed while the build remained pending.");
}

async function waitForHealth(origin: string): Promise<void> {
  let lastFailure = "health endpoint did not respond";
  for (let attempt = 1; attempt <= 120; attempt++) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastFailure = `health returned ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.name : "health request failed";
    }
    if (attempt < 120) await Bun.sleep(250);
  }
  throw new Error(`Restarted owned app never returned healthy: ${lastFailure}.`);
}

const origin = required("EZ_PRODUCTION_ORIGIN");
const appContainer = required("EZ_PRODUCTION_CONTAINER");
const runRoot = required("EZ_PRODUCTION_RUN_ROOT");
const { client, approveAndActivate } = await productionLifecycleClient();
const name = `r1-${crypto.randomUUID().replaceAll("-", "")}`;
const marker = `before-restart-${crypto.randomUUID()}`;
const created = await client.extensionControl<WorkspaceResult>("extensions_workspace", { action: "create", name });
const installationId = created.installation.id;
let revision = created.workspace.revision;
const workspaceId = created.workspace.id;

const v1 = await client.extensionControl<{ id: string; revision: number }>("extensions_workspace", { action: "edit", installationId, workspaceId, expectedRevision: revision, writes: echoSource(name, "1.0.0", "echo-v1:", "R1 production restart echo") });
revision = v1.revision;
const originalBuild = await client.extensionControl<LifecycleOperation>("extensions_build", { installationId, workspaceId, expectedRevision: revision, idempotencyKey: crypto.randomUUID() });
const originalState = await waitForVerified(client, installationId, originalBuild.id, 12, state => captureBuildFailure(installationId, state, originalBuild.id));
const originalRelease = originalState.releases[originalState.operations[originalBuild.id]!.releaseId!]!;
await approveAndActivate(installationId, originalRelease.id, null);
const conversation = await client.createConversation({ title: "R1 retained active release" });
const wired = await client.wireExtensions(conversation.id, [name]);
if (!wired.wired.includes(name)) throw new Error("Original release was not wired to its owned conversation.");
if (echoText(await client.invokeExtensionTool(conversation.id, name, "echo", { text: marker })) !== `echo-v1:${marker}`) throw new Error("Original active echo did not produce its expected output before update.");

const v2 = await client.extensionControl<{ id: string; revision: number }>("extensions_workspace", { action: "edit", installationId, workspaceId, expectedRevision: revision, writes: echoSource(name, "2.0.0", "echo-v2:", "R1 production restart echo") });
revision = v2.revision;
const build = await client.extensionControl<LifecycleOperation>("extensions_build", { installationId, workspaceId, expectedRevision: revision, idempotencyKey: crypto.randomUUID() });
const paused = await pauseOwnedBuild(client, installationId, build.id, join(runRoot, "store"));
const runnerEvidence: { beforeRestart?: RunnerEvidence; afterUnpause?: RunnerEvidence; afterRecovery?: RunnerEvidence } = {};
const writeRunnerEvidence = () => writeFile(join(required("EZ_PRODUCTION_RECEIPT_DIR"), "runner-evidence.json"), JSON.stringify(runnerEvidence) + "\n", { mode: 0o600 });
const failures: unknown[] = [];
try {
  const beforeRestart = await ownedRunnerState(paused.runnerOperationId);
  runnerEvidence.beforeRestart = beforeRestart;
  await writeRunnerEvidence();
  requireRunnerState(beforeRestart, ["building"], "when the build was paused");
  await command("docker", ["kill", "--signal", "KILL", appContainer]);
  await command("docker", ["start", appContainer]);
  await waitForHealth(origin);
} catch (error) {
  failures.push(error);
}
try {
  const state = await podman(["inspect", "--format", "{{.State.Status}}", paused.container]);
  if (state === "paused") await podman(["unpause", paused.container]);
} catch (error) {
  failures.push(error);
}
try {
  runnerEvidence.afterUnpause = await ownedRunnerState(paused.runnerOperationId);
  await writeRunnerEvidence();
} catch (error) {
  failures.push(error);
}
if (failures.length === 1) throw failures[0];
if (failures.length > 1) throw new AggregateError(failures, "R1 restart and cleanup failed");
if (echoText(await client.invokeExtensionTool(conversation.id, name, "echo", { text: marker })) !== `echo-v1:${marker}`) throw new Error("Old active echo changed immediately after app restart and worker unpause.");
// One lease may expire while the app is down. Bounded long-polls let the
// recovered isolated build complete verification.
const recovered = await waitForVerified(client, installationId, build.id, 24, state => captureBuildFailure(installationId, state, build.id));
runnerEvidence.afterRecovery = await ownedRunnerState(paused.runnerOperationId);
await writeRunnerEvidence();
requireRunnerState(runnerEvidence.afterRecovery, ["succeeded", "failed", "cancelled"], "after lifecycle recovery");
const bundledBootstrap = await waitForBundledBootstrap(client, { requireObservedPending: false });
await writeFile(join(required("EZ_PRODUCTION_RECEIPT_DIR"), "bundled-bootstrap-r1.json"), JSON.stringify(bundledBootstrap) + "\n", { mode: 0o600 });
requireBundledBootstrapVerified(bundledBootstrap, "after the R1 app restart");
const candidate = recovered.releases[recovered.operations[build.id]!.releaseId!]!;
const candidates = Object.values(recovered.releases).filter((release) => release.workspaceId === workspaceId && release.workspaceRevision === revision);
if (candidates.length !== 1 || candidate.id !== candidates[0]?.id) throw new Error(`Recovery produced ${candidates.length} v2 candidates, expected one.`);
if (recovered.installation.activeReleaseId !== originalRelease.id || !recovered.installation.enabled) throw new Error("Unapproved v2 candidate changed the active installation.");
if (Object.values(recovered.approvals).some((approval) => approval.releaseId === candidate.id)) throw new Error("Recovery created an approval for the v2 candidate.");
if (echoText(await client.invokeExtensionTool(conversation.id, name, "echo", { text: marker })) !== `echo-v1:${marker}`) throw new Error("Old active echo changed before explicit approval of v2.");
await approveAndActivate(installationId, candidate.id, originalRelease.id);
if (echoText(await client.invokeExtensionTool(conversation.id, name, "echo", { text: marker })) !== `echo-v2:${marker}`) throw new Error("Explicitly approved v2 release did not produce its new output.");

console.log(JSON.stringify({ check: "R1", appDeath: "SIGKILL", installationId, lifecycleOperationId: build.id, runnerOperationId: paused.runnerOperationId, pausedContainer: paused.container, pauseAttempts: paused.attempts, releases: candidates.length, activeReleaseId: recovered.installation.activeReleaseId, recoveryEvents: recovered.operations[build.id]!.events }));
