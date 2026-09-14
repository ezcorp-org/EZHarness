/**
 * Real readiness probes for the seven services C09 requires, and the
 * aggregation that decides whether product admission may open.
 *
 * `assertFactoryBootReadiness` already refuses to open admission unless every
 * required service is named available, but nothing produced that list — the
 * parameter defaulted to the empty array and no caller ever passed one. So the
 * gate existed and had no input. These probes are that input, and each one
 * consults a live fact rather than a configured intention:
 *
 *   - `temporal` and `orchestration` read the Node process's own readiness
 *     record, which already refuses a stale, foreign, or non-`ready` state.
 *   - `pool-admission` reads the pool process's record under the same rules.
 *   - `object-storage` writes and reads back a byte it just wrote.
 *   - `execution-gateway` asks the started listener over its own transport.
 *   - `host-supervisor` runs the runner's own preflight.
 *   - `required-sandbox` reads the boot-captured policy.
 *
 * Every probe is bounded by the caller's deadline, and one probe's failure
 * never hides another's: the whole set runs and every failure is reported, so
 * an operator sees all of what is down rather than the first of it.
 */
import { FACTORY_REQUIRED_SERVICES, type FactoryBootConfig, type FactoryService } from "./boot";
import { readFactoryOrchestrationReadiness } from "./orchestration-readiness";
import { readFactoryPoolReadiness } from "./pool/readiness";

export interface FactoryServiceProbe {
  readonly service: FactoryService;
  /** Resolves when the service is genuinely live. Throws or rejects otherwise. */
  probe(signal: AbortSignal): Promise<void>;
}

export interface FactoryServiceProbeResult {
  readonly service: FactoryService;
  readonly available: boolean;
  /** A code or short reason. Never a credential, a URL with a secret, or a stack. */
  readonly detail: string;
}

export class FactoryServiceProbeError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "FactoryServiceProbeError";
  }
}

/** The reason text a probe failure contributes, with nothing sensitive in it. */
export function factoryProbeDetail(error: unknown): string {
  if (error instanceof FactoryServiceProbeError) return error.code;
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    if (error.name.length > 0) return error.name;
  }
  return "probe_failed";
}

/**
 * Run every probe and report each verdict.
 *
 * Deliberately not `Promise.all` with a short circuit. Startup is the one
 * moment an operator can see the whole picture, and the recovery loop's
 * comment in `extension-lifecycle-service.ts` applies as well: a fan-out wider
 * than the connection pool deadlocks it. Seven sequential bounded probes cost
 * one round trip each.
 */
export async function probeFactoryServices(
  probes: readonly FactoryServiceProbe[],
  signal: AbortSignal,
): Promise<readonly FactoryServiceProbeResult[]> {
  const results: FactoryServiceProbeResult[] = [];
  for (const probe of probes) {
    if (signal.aborted) {
      results.push({ service: probe.service, available: false, detail: "probe_aborted" });
      continue;
    }
    try {
      await probe.probe(signal);
      results.push({ service: probe.service, available: true, detail: "ready" });
    } catch (error) {
      results.push({ service: probe.service, available: false, detail: factoryProbeDetail(error) });
    }
  }
  return Object.freeze(results);
}

/** The services a probe set actually proved live, in the required-service order. */
export function availableFactoryServices(results: readonly FactoryServiceProbeResult[]): readonly FactoryService[] {
  const proven = new Set(results.filter((result) => result.available).map((result) => result.service));
  return FACTORY_REQUIRED_SERVICES.filter((service) => proven.has(service));
}

/** The named reasons for every service that did not prove itself. */
export function unavailableFactoryServices(results: readonly FactoryServiceProbeResult[]): readonly string[] {
  return results.filter((result) => !result.available).map((result) => `${result.service}: ${result.detail}`);
}

export interface FactoryProbeIdentity {
  readonly installationId: string;
  readonly tenantId: string;
  readonly poolId: string;
  readonly temporalNamespace: string;
  readonly orchestrationReadinessFilePath: string;
  readonly poolReadinessFilePath: string;
  readonly readinessHeartbeatMs?: number;
}

/** A byte round-trip through the store the product will actually use. */
export interface FactoryStorageProbeTarget {
  put(key: string, content: Uint8Array): Promise<unknown>;
  get(key: string): Promise<Uint8Array>;
}

/** The started listener, asked over its own transport. */
export interface FactoryListenerProbeTarget {
  health(signal: AbortSignal): Promise<boolean>;
}

/** The runner's own preflight, which is the supervisor's liveness. */
export interface FactorySupervisorProbeTarget {
  preflight(signal: AbortSignal): Promise<void>;
}

function probeOf(service: FactoryService, run: (signal: AbortSignal) => Promise<void>): FactoryServiceProbe {
  return Object.freeze({ service, probe: run });
}

/**
 * The orchestration process's readiness record answers two services.
 *
 * C09 lists Temporal and the Node orchestration process separately, and they
 * are separate facts, but only the orchestration process can observe Temporal:
 * it is the one process that links `@temporalio/*`. Its record says
 * `workerPolling` and `dispatcherLive`, which are exactly "the worker is
 * polling Temporal" and "the dispatcher is draining" — so a fresh `ready`
 * record is live evidence of both, and product code never opens a Temporal
 * client to find out.
 */
export function factoryOrchestrationProbes(identity: FactoryProbeIdentity): readonly FactoryServiceProbe[] {
  const options = {
    installationId: identity.installationId,
    tenantId: identity.tenantId,
    namespace: identity.temporalNamespace,
    taskQueue: "factory-orchestrator",
    readinessFilePath: identity.orchestrationReadinessFilePath,
    ...(identity.readinessHeartbeatMs === undefined ? {} : { readinessHeartbeatMs: identity.readinessHeartbeatMs }),
  };
  const read = async () => {
    await readFactoryOrchestrationReadiness(options);
  };
  return Object.freeze([probeOf("orchestration", read), probeOf("temporal", read)]);
}

export function factoryPoolProbe(identity: FactoryProbeIdentity): FactoryServiceProbe {
  return probeOf("pool-admission", async () => {
    await readFactoryPoolReadiness({
      installationId: identity.installationId,
      poolId: identity.poolId,
      readinessFilePath: identity.poolReadinessFilePath,
      ...(identity.readinessHeartbeatMs === undefined ? {} : { readinessHeartbeatMs: identity.readinessHeartbeatMs }),
    });
  });
}

/**
 * A store is available when a byte written under the probe key reads back
 * equal. A reachable endpoint that silently drops a write is not storage.
 */
export function factoryStorageProbe(target: FactoryStorageProbeTarget, key: string): FactoryServiceProbe {
  return probeOf("object-storage", async () => {
    const written = new TextEncoder().encode(`factory-probe:${key}`);
    await target.put(key, written);
    const read = await target.get(key);
    if (read.byteLength !== written.byteLength || !written.every((byte, index) => read[index] === byte)) {
      throw new FactoryServiceProbeError("object_storage_roundtrip_mismatch");
    }
  });
}

export function factoryGatewayProbe(target: FactoryListenerProbeTarget): FactoryServiceProbe {
  return probeOf("execution-gateway", async (signal) => {
    if (!(await target.health(signal))) throw new FactoryServiceProbeError("execution_gateway_unhealthy");
  });
}

export function factorySupervisorProbe(target: FactorySupervisorProbeTarget): FactoryServiceProbe {
  return probeOf("host-supervisor", (signal) => target.preflight(signal));
}

/**
 * C05's required-sandbox setting, read from the boot-captured policy.
 *
 * This is the one required service that is a decision rather than a process,
 * and it is still probed rather than assumed: the flag is captured once at
 * boot, and a composition running against a config that did not capture it
 * must not open admission.
 */
export function factorySandboxProbe(config: Pick<FactoryBootConfig, "requireSandbox">): FactoryServiceProbe {
  return probeOf("required-sandbox", async () => {
    if (config.requireSandbox !== true) throw new FactoryServiceProbeError("required_sandbox_not_enforced");
  });
}
