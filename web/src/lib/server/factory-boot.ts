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
import { factoryBootConfig, type FactoryBootConfig } from "$server/factory/boot";
import { setReadiness } from "$server/readiness";
import type { TransactionalDb } from "$server/db/migrations/types";

export interface FactoryHostBootDependencies {
  readonly database: TransactionalDb;
  readonly databaseUrl: string | undefined;
  readonly signal: AbortSignal;
  readonly boot: FactoryBootConfig;
  readonly registerTeardown: (name: string, fn: () => Promise<void> | void) => void;
  readonly log: Pick<Console, "info" | "error">;
}

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
  try {
    const startup = await startFactoryInstallation({
      host: {
        database: dependencies.database,
        // `resolveParameters` is omitted so `createFactoryApplication` uses the
        // run-inputs resolver it builds; naming it here would shadow that.
        runOptions: hostRunOptions(env),
        availableResourceClasses: (env.EZCORP_FACTORY_RESOURCE_CLASSES ?? "cpu").split(",").map((value) => value.trim()).filter(Boolean),
        report: (role, error) => {
          dependencies.log.error("[factory] background role failed", { role, error: String(error) });
        },
      },
      databaseUrl: dependencies.databaseUrl,
      signal: dependencies.signal,
      boot: dependencies.boot,
    });
    // Registered last, so shutdown stops the factory roles FIRST. They hold
    // database leases, and draining them before the database closes is the
    // same LIFO rule `pglite-close` relies on.
    dependencies.registerTeardown("factory-runtime", () => startup.stop());
    const report = startup.runtime.report();
    dependencies.log.info("[factory] composed", {
      tenantId: report.tenantId,
      running: report.workers.filter((worker) => worker.running).map((worker) => worker.name),
      held: report.heldWorkers.map((worker) => worker.role),
    });
    return startup;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    setReadiness({
      state: "degraded",
      reason: typeof code === "string" ? code : "factory-composition-failed",
      detail: { message: error instanceof Error ? error.message : "Factory composition failed." },
    });
    dependencies.log.error("[factory] composition failed; factory routes stay closed", { error: String(error) });
    return null;
  }
}

/** The one call `ensureInitialized` makes. Off means no factory service starts. */
export async function startFactoryIfEnabled(
  dependencies: Omit<FactoryHostBootDependencies, "boot"> & { readonly boot?: FactoryBootConfig },
): Promise<FactoryInstallationStartup | null> {
  const boot = dependencies.boot ?? factoryBootConfig;
  if (!boot.enabled) return null;
  return startFactoryForHost({ ...dependencies, boot });
}
