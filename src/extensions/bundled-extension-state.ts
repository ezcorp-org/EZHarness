/**
 * The installation state of a bundled first-party extension, for the runtime
 * hosts that wire one into a chat turn (task-tracking, ask-user, orchestration).
 *
 * `ensureBundledExtensions()` stages every bundled extension as a disabled v4
 * installation (`bundled-bootstrap.ts`); it becomes an active extension row
 * only after an administrator approves its exact release. So "no extension
 * row" has two causes that need different words:
 *   - awaiting_approval: the installation is staged. A designed state on every
 *     fresh install; the action is an administrator's approval.
 *   - missing: no installation at all. A real fault: the boot did not stage it.
 */
import { getDb } from "../db/connection";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { getExtensionByName } from "../db/queries/extensions";
import { bundledInstallationId } from "./bundled-installation-id";

export type BundledExtensionState = { kind: "installed"; id: string } | { kind: "awaiting_approval" } | { kind: "missing" };

/** Classify one bundled extension by name. */
export async function bundledExtensionState(name: string): Promise<BundledExtensionState> {
  const row = await getExtensionByName(name);
  if (row) return { kind: "installed", id: row.id };
  const staged = await new DatabaseLifecycleRepository(getDb()).read(bundledInstallationId(name), getDb());
  return staged && !staged.installation.uninstalled ? { kind: "awaiting_approval" } : { kind: "missing" };
}

/** The message a host logs once for a staged extension: the real state and the action. */
export function awaitingApprovalMessage(name: string): string {
  return `${name} is staged and awaits administrator approval`;
}

/** Brand on an error that means "staged, awaits approval", read by {@link awaitingApprovalOf}. */
const AWAITING_APPROVAL = Symbol.for("ezcorp.bundled-extension.awaiting-approval");

/** Mark `error` as "`name` is staged and awaits approval", for callers that only see the error. */
export function markAwaitingApproval<E extends Error>(error: E, name: string): E {
  Object.defineProperty(error, AWAITING_APPROVAL, { value: name });
  return error;
}

/** The extension name an error was marked with by {@link markAwaitingApproval}, if any. */
export function awaitingApprovalOf(error: unknown): string | undefined {
  const name = error instanceof Error ? (error as unknown as Record<symbol, unknown>)[AWAITING_APPROVAL] : undefined;
  return typeof name === "string" ? name : undefined;
}

const reportedAwaiting = new Set<string>();

/** Log a staged extension once per process at info; it is the same designed state on every turn. */
export function reportAwaitingApproval(log: { info(msg: string): void }, name: string): void {
  if (reportedAwaiting.has(name)) return;
  reportedAwaiting.add(name);
  log.info(awaitingApprovalMessage(name));
}

/**
 * One host's resolver: the extension id once installed (cached for the
 * process, as the hosts did before), otherwise the state, never cached,
 * so an approval later in the process is seen on the next turn.
 */
export function bundledExtensionResolver(name: string): { state(): Promise<BundledExtensionState>; reset(): void } {
  let cachedId: string | undefined;
  return {
    async state() {
      if (cachedId) return { kind: "installed", id: cachedId };
      const state = await bundledExtensionState(name);
      if (state.kind === "installed") cachedId = state.id;
      return state;
    },
    reset() {
      cachedId = undefined;
      reportedAwaiting.delete(name);
    },
  };
}
