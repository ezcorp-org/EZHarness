/**
 * Wait for the real server's boot-time bundled builds to settle.
 *
 * Right after the first administrator becomes active, the server stages every
 * bundled extension and builds each one through its single isolated runner
 * (src/extensions/bundled-bootstrap.ts). A spec that builds while that chain
 * runs is parked behind it, which is the root of the "queued for 240 s" and
 * "activation past 5 s" failures the extension specs used to show. The
 * real-server global setups call this once so specs start against a quiet
 * runner. The server does not log the chain, so the observable is the
 * test-surface route `GET /api/__test/bundled-bootstrap`, which counts staged
 * installations and their pending build operations.
 */
export interface BundledBootstrapStatus { staged: number; pending: number }
/** The slice of Playwright's `APIRequestContext` this needs (the global setups pass the real one); a unit test can fake it. */
export interface StatusRequest {
  get(url: string): Promise<{ ok(): boolean; status(): number; text(): Promise<string>; json(): Promise<unknown> }>;
}
export interface BundledBootstrapWaitOptions {
  /** Upper bound for staged installations to appear at all; fails closed. */
  stagingTimeoutMs?: number;
  /** Upper bound for every staged build to leave queued/building/verifying. */
  settleTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export interface BundledBootstrapWaitResult extends BundledBootstrapStatus { elapsedMs: number }

const DEFAULT_STAGING_TIMEOUT_MS = 90_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_MS = 2_000;
/** Consecutive quiet polls required, so a staging burst still in progress is not read as settled. */
const QUIET_POLLS = 2;

export async function readBundledBootstrapStatus(request: StatusRequest, baseURL: string): Promise<BundledBootstrapStatus> {
  const response = await request.get(`${baseURL}/api/__test/bundled-bootstrap`);
  if (!response.ok()) throw new Error(`bundled bootstrap status failed (${response.status()}): ${await response.text()}`);
  return (await response.json()) as BundledBootstrapStatus;
}

export async function waitForBundledBootstrap(
  request: StatusRequest,
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
    if (status.staged > 0 && status.pending === 0) {
      quietPolls += 1;
      if (quietPolls >= QUIET_POLLS) return { ...status, elapsedMs };
    } else {
      quietPolls = 0;
    }
    if (status.staged === 0 && elapsedMs >= stagingTimeoutMs) {
      throw new Error(`No bundled installation was staged within ${stagingTimeoutMs}ms; the real server did not run its bundled bootstrap.`);
    }
    if (elapsedMs >= settleTimeoutMs) {
      throw new Error(`Bundled bootstrap builds did not settle within ${settleTimeoutMs}ms (${status.pending} pending across ${status.staged} installations).`);
    }
    await sleep(pollMs);
  }
}
