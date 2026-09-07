import type { HarnessClient } from "@ezcorp/harness-client";
import { resolveBundledExtensions } from "../../src/extensions/bundled";
import { bundledInstallationId } from "../../src/extensions/bundled-bootstrap";
import type { InstallationState, LifecycleOperation } from "../../src/extensions/v4/types";

export type BundledBootstrapState = {
  bootstrapInstallations: number;
  initialPending: number;
  maximumPending: number;
  terminalOperationStates: Record<string, number>;
  terminalOperations: Array<{ name: string; installationId: string; operations: Array<Pick<LifecycleOperation, "id" | "kind" | "state" | "diagnostics">> }>;
};

export async function waitForBundledBootstrap(client: HarnessClient, options: { requireObservedPending?: boolean; deadlineMs?: number } = {}): Promise<BundledBootstrapState> {
  const deadline = Date.now() + (options.deadlineMs ?? 360_000);
  const requireObservedPending = options.requireObservedPending ?? true;
  const bootstrapNames = new Set(resolveBundledExtensions().map(({ name }) => name));
  let idleChecks = 0;
  let initialPending = 0;
  let maximumPending = 0;
  while (Date.now() < deadline) {
    const extensions = await client.listExtensions();
    const installationByName = new Map(extensions.map(({ id, name }) => [name, id]));
    const lifecycleInstallations = [...bootstrapNames].map(name => ({ name, installationId: installationByName.get(name) ?? bundledInstallationId(name) }));
    const lifecycleIds = lifecycleInstallations.map(({ installationId }) => installationId);
    if (new Set(lifecycleIds).size !== bootstrapNames.size) throw new Error("Candidate bootstrap installation IDs are not unique");
    const states = await Promise.all(lifecycleInstallations.map(async ({ name, installationId }) => ({ name, installationId, state: await client.extensionControl<InstallationState>("extensions_inspect", { installationId }) })));
    const installationStates = states.map(({ state }) => state);
    const pending = installationStates.reduce((count, state) => count + Object.values(state.operations).filter(operation => ["queued", "building", "verifying"].includes(operation.state)).length, 0);
    maximumPending = Math.max(maximumPending, pending);
    if (pending > 0) {
      if (initialPending === 0) initialPending = pending;
      idleChecks = 0;
    } else if (!requireObservedPending || initialPending > 0) {
      idleChecks += 1;
      if (idleChecks === 2) {
        const terminalOperationStates: Record<string, number> = {};
        for (const state of installationStates) for (const operation of Object.values(state.operations)) terminalOperationStates[operation.state] = (terminalOperationStates[operation.state] ?? 0) + 1;
        return { bootstrapInstallations: lifecycleIds.length, initialPending, maximumPending, terminalOperationStates, terminalOperations: states.map(({ name, installationId, state }) => ({ name, installationId, operations: Object.values(state.operations).map(({ id, kind, state: operationState, diagnostics }) => ({ id, kind, state: operationState, diagnostics })) })) };
      }
    }
    await Bun.sleep(1_000);
  }
  throw new Error("Candidate bootstrap did not reach a terminal runner state before the deadline");
}

export function requireBundledBootstrapVerified(state: BundledBootstrapState, point: string): void {
  const builds = state.terminalOperations.map(({ operations }) => operations.filter(operation => operation.kind === "build"));
  if (builds.length !== state.bootstrapInstallations || builds.some(operations => operations.length === 0 || operations.some(operation => operation.state !== "verified"))) throw new Error(`Bundled bootstrap did not verify ${point}: ${JSON.stringify(state.terminalOperations)}`);
}
