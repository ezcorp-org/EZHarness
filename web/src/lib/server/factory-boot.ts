/**
 * The host's side of the factory composition, called once from
 * `ensureInitialized`.
 *
 * The composition root itself lives in `src/factory/runtime-composition.ts` and
 * needs three things this layer owns and it does not: the open database, the
 * product object store, and the run bounds. Everything else — identities,
 * endpoints, readiness paths — comes from the startup document.
 *
 * A failure here degrades the factory and not the host. `getFactoryApplication()`
 * stays null, so every `/api/factories/*` route answers 503, readiness carries
 * the named reason, and the rest of the server keeps serving. It is reported,
 * never swallowed: an operator reads the code out of `/api/ready`.
 */
import { startFactoryInstallation, type FactoryInstallationStartup } from "$server/factory/installation-startup";
import { FactoryBootError, factoryBootConfig, type FactoryBootConfig } from "$server/factory/boot";
import { setReadiness } from "$server/readiness";
import { errorChain } from "$server/db/error-chain";
import type { TransactionalDb } from "$server/db/migrations/types";
import type { FactoryWorkerStopRecord } from "$server/factory/background-workers";

export interface FactoryHostBootDependencies {
  readonly database: TransactionalDb;
  readonly databaseUrl: string | undefined;
  readonly signal: AbortSignal;
  readonly boot: FactoryBootConfig;
  readonly registerTeardown: (name: string, fn: () => Promise<void> | void) => void;
  readonly log: Pick<Console, "info" | "error">;
  /**
   * Discard the database pool after a driver statement desync and say whether
   * it did (`recoverFromDriverDesync`). A role that retried on a poisoned
   * connection would fail the same way forever (W09f).
   */
  readonly recoverDatabase: (error: unknown) => Promise<boolean>;
  /** Overrides {@link FACTORY_BOOT_BOUND_MS}. */
  readonly bootBoundMs?: number;
  /** How the host ends itself when boot outlives its bound. Defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
}

/**
 * How long factory boot may take before the host gives up and exits.
 *
 * Boot, up to "[factory] composed", is the startup config, binding the
 * installation, the object store, the provider broker, the collaborators, and
 * one round of the seven startup probes. Each probe has its own fifteen-second
 * deadline (FACTORY_PROBE_DEADLINE_MS), so the probes cannot exceed 105 s even
 * if every one hangs, and the other phases take seconds on a healthy host.
 * Three minutes leaves that headroom, and stays well inside the provisioner's
 * ten-minute ready() wait, so a restart and a fresh boot still fit in it. The
 * readinessRetry window runs after boot, in the background, and is not part
 * of this bound. Past it, the host logs the phase it stalled in and exits
 * non-zero, so its supervisor restarts it instead of the healthcheck reporting
 * "starting" for the whole wait.
 */
export const FACTORY_BOOT_BOUND_MS = 180_000;

/** Bounds a run may not exceed, from the environment or the documented default. */
function hostRunOptions(env: Readonly<Record<string, string | undefined>>) {
  return {
    interpreterBuild: env.EZCORP_FACTORY_INTERPRETER_BUILD ?? "factory-interpreter-1",
    interpreterCompatibility: env.EZCORP_FACTORY_INTERPRETER_COMPATIBILITY ?? "1",
    limits: { maxCostMicros: "1000000", maxTokens: 1_000_000, maxComputeMs: 3_600_000 },
  };
}

/**
 * Compose and start the factory, or degrade readiness with a named reason.
 *
 * Returns the started handle so a caller can inspect what ran, and `null` when
 * composition refused. The teardown is registered here rather than by the
 * caller so the stop cannot be forgotten on one of the two paths.
 */
export async function startFactoryForHost(
  dependencies: FactoryHostBootDependencies,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<FactoryInstallationStartup | null> {
  const boundMs = dependencies.bootBoundMs ?? FACTORY_BOOT_BOUND_MS;
  let started = "boot";
  let finished = "none";
  const bound = setTimeout(() => {
    dependencies.log.error("[factory] boot exceeded its bound; exiting so the host restarts", { phase: started, lastFinished: finished, boundMs });
    setReadiness({ state: "degraded", reason: "factory-boot-stalled", detail: { phase: started, lastFinished: finished, boundMs } });
    (dependencies.exit ?? ((code: number) => process.exit(code)))(1);
  }, boundMs);
  bound.unref?.();
  try {
    const startup = await startFactoryInstallation({
      host: {
        trace: (event) => {
          if (event.state === "started") started = event.phase;
          else finished = event.phase;
          dependencies.log.info("[factory] boot phase", event);
        },
        database: dependencies.database,
        // `resolveParameters` is omitted so `createFactoryApplication` uses the
        // run-inputs resolver it builds; naming it here would shadow that.
        runOptions: hostRunOptions(env),
        availableResourceClasses: (env.EZCORP_FACTORY_RESOURCE_CLASSES ?? "cpu").split(",").map((value) => value.trim()).filter(Boolean),
        // The causes carry the server's own words (SQLSTATE, routine,
        // statement); the top message of a driver error is only the query.
        // After a driver statement desync the pool is replaced, so the role's
        // retry reaches a fresh connection instead of the poisoned one.
        report: (role, error) => {
          const causes = errorChain(error).slice(1);
          dependencies.log.error("[factory] background role failed", causes.length > 0 ? { role, error: String(error), causes } : { role, error: String(error) });
          dependencies.recoverDatabase(error).then(
            (replaced) => { if (replaced) dependencies.log.info("[factory] database pool replaced after a driver statement desync", { role }); },
            (cause: unknown) => { dependencies.log.error("[factory] database pool replacement failed", { role, error: String(cause) }); },
          );
        },
      },
      databaseUrl: dependencies.databaseUrl,
      signal: dependencies.signal,
      boot: dependencies.boot,
    });
    // Registered last, so shutdown stops the factory roles FIRST. They hold
    // database leases, and draining them before the database closes is the
    // same LIFO rule `pglite-close` relies on.
    dependencies.registerTeardown("factory-runtime", async () => logRoleStops(dependencies.log, await startup.stop()));
    const report = startup.runtime.report();
    dependencies.log.info("[factory] composed", {
      tenantId: report.tenantId,
      running: report.workers.filter((worker) => worker.running).map((worker) => worker.name),
      held: report.heldWorkers.map((worker) => worker.role),
    });
    return startup;
  } catch (error) {
    // `startFactoryRuntime` writes the richer readiness before it throws a
    // `FactoryBootError` — the probe failures service by service — and that
    // detail is the operator's only pointer to the fix. Replacing it with the
    // bare service name would cost exactly the line worth reading, so that one
    // error is left alone. Every other failure has written nothing.
    if (!(error instanceof FactoryBootError)) {
      const code = (error as { code?: unknown }).code;
      setReadiness({
        state: "degraded",
        reason: typeof code === "string" ? code : "factory-composition-failed",
        detail: { message: error instanceof Error ? error.message : "Factory composition failed." },
      });
    }
    dependencies.log.error("[factory] composition failed; factory routes stay closed", { error: String(error) });
    return null;
  } finally {
    // Boot is over, composed or refused: the bound no longer applies.
    clearTimeout(bound);
  }
}

/**
 * One line per shutdown with each role's stop time, so a slow stop is named
 * rather than hidden inside the teardown's total. A role whose in-flight step
 * outlived its stop deadline is an error line naming it.
 */
export function logRoleStops(log: FactoryHostBootDependencies["log"], records: readonly FactoryWorkerStopRecord[]): void {
  const ms = Object.fromEntries(records.map((record) => [record.name, record.ms]));
  const stuck = records.filter((record) => !record.settled).map((record) => record.name);
  if (stuck.length === 0) log.info("[factory] roles stopped", { ms });
  else log.error("[factory] roles stopped; in-flight steps left running past the stop deadline", { stuck, ms });
}

/** The one call `ensureInitialized` makes. Off means no factory service starts. */
export async function startFactoryIfEnabled(
  dependencies: Omit<FactoryHostBootDependencies, "boot"> & { readonly boot?: FactoryBootConfig },
): Promise<FactoryInstallationStartup | null> {
  const boot = dependencies.boot ?? factoryBootConfig;
  if (!boot.enabled) return null;
  return startFactoryForHost({ ...dependencies, boot });
}
