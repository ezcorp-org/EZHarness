/**
 * Wait for the real server's boot-time bundled builds to settle.
 *
 * Right after the first administrator becomes active, the server stages every
 * bundled extension and builds each one through its single isolated runner
 * (src/extensions/bundled-bootstrap.ts). A spec that builds while that chain
 * runs is parked behind it, which is the root of the "queued for 240 s" and
 * "activation past 5 s" failures the extension specs used to show. The
 * real-server global setups call this once so specs start against a quiet
 * runner.
 *
 * The observable is the production control API with the administrator's
 * session — the bundled installations are owned by that administrator, so
 * `extensions_workspace { action: "list" }` enumerates them and
 * `extensions_inspect` shows each one's operations. No test-surface route is
 * involved, so this also holds in the production-image lane, where
 * `NODE_ENV=production` keeps `/api/__test/**` closed.
 */
import type { InstallationRecord, InstallationState } from "../../../src/extensions/v4/types";

export interface BundledBootstrapStatus {
  /** Live installations the administrator owns; at setup time, the bundled ones. */
  installations: number;
  /** Their build operations still queued, building or verifying. */
  pending: number;
}
export interface BundledBootstrapWaitOptions {
  /** Upper bound for the first installation to appear at all; fails closed. */
  stagingTimeoutMs?: number;
  /** Upper bound for every build to leave queued/building/verifying. */
  settleTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export interface BundledBootstrapWaitResult extends BundledBootstrapStatus { elapsedMs: number }

/** The slice of Playwright's `APIRequestContext` this needs (the global setups pass the real one); a unit test can fake it. */
export interface ControlRequest {
  post(url: string, options: { data: unknown }): Promise<{ ok(): boolean; status(): number; text(): Promise<string>; json(): Promise<unknown> }>;
}

const DEFAULT_STAGING_TIMEOUT_MS = 90_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_MS = 2_000;
/** Consecutive quiet polls required, so a staging burst still in progress is not read as settled. */
const QUIET_POLLS = 2;
const PENDING_BUILD = /^(queued|building|verifying)$/;

async function control<T>(request: ControlRequest, baseURL: string, tool: string, input: Record<string, unknown>): Promise<T> {
  const response = await request.post(`${baseURL}/api/extensions/control`, { data: { tool, input } });
  if (!response.ok()) throw new Error(`${tool} failed while waiting for the bundled bootstrap (${response.status()}): ${await response.text()}`);
  return (await response.json()) as T;
}

export async function readBundledBootstrapStatus(request: ControlRequest, baseURL: string): Promise<BundledBootstrapStatus> {
  const installations = (await control<InstallationRecord[]>(request, baseURL, "extensions_workspace", { action: "list" })).filter((installation) => !installation.uninstalled);
  let pending = 0;
  for (const installation of installations) {
    const state = await control<InstallationState>(request, baseURL, "extensions_inspect", { installationId: installation.id });
    pending += Object.values(state.operations).filter((operation) => operation.kind === "build" && PENDING_BUILD.test(operation.state)).length;
  }
  return { installations: installations.length, pending };
}

export async function waitForBundledBootstrap(
  request: ControlRequest,
  baseURL: string,
  options: BundledBootstrapWaitOptions = {},
): Promise<BundledBootstrapWaitResult> {
  const stagingTimeoutMs = options.stagingTimeoutMs ?? DEFAULT_STAGING_TIMEOUT_MS;
  const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  let quietPolls = 0;
  for (;;) {
    const status = await readBundledBootstrapStatus(request, baseURL);
    const elapsedMs = now() - startedAt;
    if (status.installations > 0 && status.pending === 0) {
      quietPolls += 1;
      if (quietPolls >= QUIET_POLLS) return { ...status, elapsedMs };
    } else {
      quietPolls = 0;
    }
    if (status.installations === 0 && elapsedMs >= stagingTimeoutMs) {
      throw new Error(`No bundled installation was staged within ${stagingTimeoutMs}ms; the real server did not run its bundled bootstrap.`);
    }
    if (elapsedMs >= settleTimeoutMs) {
      throw new Error(`Bundled bootstrap builds did not settle within ${settleTimeoutMs}ms (${status.pending} pending across ${status.installations} installations).`);
    }
    await sleep(pollMs);
  }
}
