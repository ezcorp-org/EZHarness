import type { HarnessClient } from "@ezcorp/harness-client";
import { resolveBundledExtensions } from "../../src/extensions/bundled";
import { bundledInstallationId } from "../../src/extensions/bundled-bootstrap";
import type { InstallationState, LifecycleOperation } from "../../src/extensions/v4/types";
import {
  BUNDLED_BOOTSTRAP_POLICY,
  type BundledBootstrapBuild,
  type BundledBootstrapPolicy,
  BundledBootstrapProgress,
  type BundledBootstrapProgressSummary,
  type BundledBootstrapVerdict,
  bundledBootstrapSafetyNetMs,
  describeBundledBootstrapVerdict,
  isPendingBuildState,
  latestBuild,
} from "./bundled-bootstrap-progress";

export type BundledBootstrapState = {
  bootstrapInstallations: number;
  initialPending: number;
  maximumPending: number;
  terminalOperationStates: Record<string, number>;
  terminalOperations: Array<{ name: string; installationId: string; operations: Array<Pick<LifecycleOperation, "id" | "kind" | "state" | "diagnostics">> }>;
};

export type BundledBootstrapObserver = {
  startedAt: string;
  policy: BundledBootstrapPolicy;
  /** The safety net for this chain (bundled-bootstrap-progress.ts: builds x slowest step + one lease). */
  safetyNetMs: number;
};

export type BundledBootstrapObservation = BundledBootstrapState & {
  capturedAt: string;
  observer: BundledBootstrapObserver;
  /** Present on a finished wait: the total and the stall clock's maximum (the timeout error carries the verdict instead). */
  progress?: BundledBootstrapProgressSummary;
  terminalOperations: Array<{
    name: string;
    installationId: string;
    operations: Array<Pick<LifecycleOperation, "id" | "kind" | "state" | "diagnostics" | "updatedAt"> & {
      lease: Pick<NonNullable<LifecycleOperation["lease"]>, "fence" | "until"> | null;
      lastEvent: Pick<LifecycleOperation["events"][number], "state" | "at"> | null;
    }>;
  }>;
};

export class BundledBootstrapTimeoutError extends Error {
  constructor(
    public readonly snapshot: BundledBootstrapObservation,
    public readonly observer: BundledBootstrapObserver,
    public readonly verdict: BundledBootstrapVerdict,
  ) {
    super(`Candidate bootstrap did not reach a terminal runner state: ${describeBundledBootstrapVerdict(verdict)}: ${JSON.stringify({ observer, verdict, snapshot })}`);
    this.name = "BundledBootstrapTimeoutError";
  }
}

function summarizeBootstrap(
  states: Array<{ name: string; installationId: string; state: InstallationState }>,
  initialPending: number,
  maximumPending: number,
  observer: BundledBootstrapObserver,
): BundledBootstrapObservation {
  const terminalOperationStates: Record<string, number> = {};
  for (const { state } of states) for (const operation of Object.values(state.operations)) terminalOperationStates[operation.state] = (terminalOperationStates[operation.state] ?? 0) + 1;
  return {
    capturedAt: new Date().toISOString(),
    observer,
    bootstrapInstallations: states.length,
    initialPending,
    maximumPending,
    terminalOperationStates,
    terminalOperations: states.map(({ name, installationId, state }) => ({
      name,
      installationId,
      operations: Object.values(state.operations).map(operation => {
        const lastEvent = operation.events.at(-1);
        return {
          id: operation.id,
          kind: operation.kind,
          state: operation.state,
          diagnostics: operation.diagnostics,
          updatedAt: operation.updatedAt,
          lease: operation.lease ? { fence: operation.lease.fence, until: operation.lease.until } : null,
          lastEvent: lastEvent ? { state: lastEvent.state, at: lastEvent.at } : null,
        };
      }),
    })),
  };
}

/** Every bundled installation's lifecycle state, by name (the server's installation id, else the deterministic bundled id). */
async function inspectBundledInstallations(client: HarnessClient, names: ReadonlySet<string>): Promise<Array<{ name: string; installationId: string; state: InstallationState }>> {
  const extensions = await client.listExtensions();
  const installationByName = new Map(extensions.map(({ id, name }) => [name, id]));
  const installations = [...names].map(name => ({ name, installationId: installationByName.get(name) ?? bundledInstallationId(name) }));
  if (new Set(installations.map(({ installationId }) => installationId)).size !== names.size) throw new Error("Candidate bootstrap installation IDs are not unique");
  return Promise.all(installations.map(async ({ name, installationId }) => ({ name, installationId, state: await client.extensionControl<InstallationState>("extensions_inspect", { installationId }) })));
}

function bundledNames(): Set<string> {
  return new Set(resolveBundledExtensions().map(({ name }) => name));
}

export type BundledBootstrapWaitOptions = {
  requireObservedPending?: boolean;
  policy?: BundledBootstrapPolicy;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
};

/** Wait until every bundled build is terminal. The wait ends early only on NO PROGRESS (bundled-bootstrap-progress.ts). */
export async function waitForBundledBootstrap(client: HarnessClient, options: BundledBootstrapWaitOptions = {}): Promise<BundledBootstrapObservation> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const policy = options.policy ?? BUNDLED_BOOTSTRAP_POLICY;
  const startedAtMs = now();
  const bootstrapNames = bundledNames();
  const observer: BundledBootstrapObserver = {
    startedAt: new Date(startedAtMs).toISOString(),
    policy,
    safetyNetMs: bundledBootstrapSafetyNetMs(bootstrapNames.size, policy),
  };
  const requireObservedPending = options.requireObservedPending ?? true;
  const progress = new BundledBootstrapProgress(startedAtMs, policy);
  let idleChecks = 0;
  let initialPending = 0;
  let maximumPending = 0;
  for (;;) {
    const states = await inspectBundledInstallations(client, bootstrapNames);
    const pending = states.reduce((count, { state }) => count + Object.values(state.operations).filter(operation => isPendingBuildState(operation.state)).length, 0);
    maximumPending = Math.max(maximumPending, pending);
    if (pending > 0 && initialPending === 0) initialPending = pending;
    const latest = summarizeBootstrap(states, initialPending, maximumPending, observer);
    if (pending > 0) {
      idleChecks = 0;
    } else if (!requireObservedPending || initialPending > 0) {
      idleChecks += 1;
    }
    const verdict = progress.observe(states.map(({ name, state }) => latestBuild(name, state)), now());
    if (idleChecks === 2) return { ...latest, progress: progress.summary() };
    if (verdict) throw new BundledBootstrapTimeoutError(latest, observer, verdict);
    await sleep(1_000);
  }
}

export class BuildWaitTimeoutError extends Error {
  constructor(
    public readonly operationId: string,
    public readonly verdict: BundledBootstrapVerdict,
  ) {
    super(`Build ${operationId} did not finish: ${describeBundledBootstrapVerdict(verdict)}`);
    this.name = "BuildWaitTimeoutError";
  }
}

/**
 * Wait until one build verifies with a release, and return its installation's state. Every build shares the
 * one runner with the bundled bootstrap, so a build requested while the bootstrap runs waits behind its whole chain (the
 * historical upgrade's candidate staged 28 bundled builds just before its user build). The wait therefore ends on NO
 * PROGRESS of that queue (bundled-bootstrap-progress.ts), never on a flat wall clock.
 */
export async function waitForBuildVerified(
  client: HarnessClient,
  installationId: string,
  operationId: string,
  options: Pick<BundledBootstrapWaitOptions, "policy" | "now" | "sleep"> = {},
): Promise<InstallationState> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const progress = new BundledBootstrapProgress(now(), options.policy ?? BUNDLED_BOOTSTRAP_POLICY);
  const names = bundledNames();
  for (;;) {
    const state = await client.extensionControl<InstallationState>("extensions_inspect", { installationId, operationId, waitMs: 30_000 });
    const operation = state.operations[operationId];
    if (!operation) throw new Error(`Build ${operationId} disappeared from installation ${installationId}`);
    if (!isPendingBuildState(operation.state)) {
      if (operation.state !== "verified") throw new Error(`Build ${operationId} ended ${operation.state}: ${JSON.stringify(operation.diagnostics)}`);
      if (!operation.releaseId || !state.releases[operation.releaseId]) throw new Error(`Build ${operationId} verified without a release`);
      return state;
    }
    const awaited: BundledBootstrapBuild = { name: `build ${operationId}`, operationId, state: operation.state, updatedAt: operation.updatedAt, leaseUntil: operation.lease?.until ?? null };
    const queue = await inspectBundledInstallations(client, names);
    const verdict = progress.observe([awaited, ...queue.map(({ name, state: bundled }) => latestBuild(name, bundled))], now());
    if (verdict) throw new BuildWaitTimeoutError(operationId, verdict);
    await sleep(1_000);
  }
}

export function requireBundledBootstrapVerified(state: BundledBootstrapState, point: string): void {
  const builds = state.terminalOperations.map(({ operations }) => operations.filter(operation => operation.kind === "build"));
  if (builds.length !== state.bootstrapInstallations || builds.some(operations => operations.length === 0 || operations.some(operation => operation.state !== "verified"))) throw new Error(`Bundled bootstrap did not verify ${point}: ${JSON.stringify(state.terminalOperations)}`);
}
