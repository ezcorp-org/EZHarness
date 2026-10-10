import { setReadiness } from "../readiness";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

export const FACTORY_REQUIRED_SERVICES = [
  "temporal",
  "object-storage",
  "orchestration",
  "execution-gateway",
  "host-supervisor",
  "pool-admission",
  "required-sandbox",
] as const;

export type FactoryService = (typeof FACTORY_REQUIRED_SERVICES)[number];

/**
 * C11's detection bound, next to the C09 service list because it is the same
 * kind of fact: something a flag-on installation must have, checked at startup.
 *
 * C10 requires an orphaned legacy run to reach a terminal or resumable state
 * within thirty seconds. W13's orphan sweep is a sub-tick of the host
 * maintenance daemon, whose default wake is one hour — so on a default
 * installation the bound is missed by two orders of magnitude, and nothing
 * would have said so. The interval is therefore a declared factory setting,
 * checked against this bound AND against the interval the daemon will really
 * use: a document that states thirty seconds while the daemon ticks hourly is
 * a wish, not a setting.
 */
export const FACTORY_ORPHAN_DETECTION_BOUND_MS = 30_000;

/**
 * The reason C09 promises when the flag is off, in one place.
 *
 * The contract's spelling is dashed. The API emitted an underscored variant,
 * so the documented 404 was unrecognisable to a client written against the
 * contract. Both the route and its tests now read this constant, so the two
 * cannot drift again.
 */
export const FACTORY_DISABLED_REASON = "factory-disabled" as const;

export interface FactoryBootConfig {
  enabled: boolean;
  /** One boot-captured policy used by every untrusted subprocess seam. */
  requireSandbox?: boolean;
  installationId?: string;
  secretsDir?: string;
  projectRoot: string;
  /** Roots an extension can receive through the built-in $CWD grant. */
  grantableRoots?: readonly string[];
}

/** Read the factory flag exactly once at process boot. */
export function captureFactoryBootConfig(
  env: Readonly<Record<string, string | undefined>>,
): FactoryBootConfig {
  const projectRoot = resolve(env.EZCORP_PROJECT_ROOT ?? process.cwd());
  return Object.freeze({
    enabled: env.EZCORP_FACTORY_ENABLED === "1",
    requireSandbox:
      env.EZCORP_FACTORY_ENABLED === "1" || env.EZCORP_REQUIRE_SANDBOX === "1",
    installationId: env.EZCORP_INSTALLATION_ID,
    secretsDir: env.EZCORP_SECRETS_DIR,
    projectRoot,
    grantableRoots: Object.freeze([projectRoot, resolve(process.cwd())]),
  });
}

export const factoryBootConfig = captureFactoryBootConfig(process.env);

export class FactoryBootError extends Error {
  constructor(
    readonly code:
      | "factory-pglite-unsupported"
      | "factory-installation-id-required"
      | "factory-secrets-dir-required"
      | "factory-services-unavailable"
      | "factory-orphan-sweep-too-slow"
      | "factory-orphan-sweep-mismatch",
    message: string,
  ) {
    super(message);
    this.name = "FactoryBootError";
  }
}

/** Validate prerequisites before a driver opens; services depend on this database. */
export function assertFactoryBootConfiguration(
  databaseUrl: string | undefined,
  config: FactoryBootConfig = factoryBootConfig,
): void {
  if (!config.enabled) return;

  if (!databaseUrl) {
    const error = new FactoryBootError(
      "factory-pglite-unsupported",
      "Factory startup requires external PostgreSQL; embedded PGlite is unsupported.",
    );
    setReadiness({ state: "degraded", reason: error.code, detail: { message: error.message } });
    throw error;
  }

  if (!config.installationId?.trim()) {
    const error = new FactoryBootError(
      "factory-installation-id-required",
      "Factory startup requires EZCORP_INSTALLATION_ID.",
    );
    setReadiness({ state: "degraded", reason: error.code, detail: { message: error.message } });
    throw error;
  }

  const grantableRoots = config.grantableRoots ?? [config.projectRoot];
  if (!config.secretsDir || grantableRoots.some((root) => isWithin(root, config.secretsDir!))) {
    const error = new FactoryBootError(
      "factory-secrets-dir-required",
      "Factory startup requires EZCORP_SECRETS_DIR outside the grantable project root.",
    );
    setReadiness({ state: "degraded", reason: error.code, detail: { grantableRoots } });
    throw error;
  }
}

/** Product admission remains closed until all post-database service probes succeed. */
export function assertFactoryBootReadiness(
  databaseUrl: string | undefined,
  availableServices: readonly FactoryService[] = [],
  config: FactoryBootConfig = factoryBootConfig,
): void {
  assertFactoryBootConfiguration(databaseUrl, config);
  if (!config.enabled) return;

  const available = new Set(availableServices);
  const missing = FACTORY_REQUIRED_SERVICES.filter((service) => !available.has(service));
  if (missing.length > 0) {
    const error = new FactoryBootError(
      "factory-services-unavailable",
      `Factory startup requires unavailable services: ${missing.join(", ")}.`,
    );
    setReadiness({ state: "degraded", reason: error.code, detail: { missing } });
    throw error;
  }
}

/**
 * The orphan sweep must tick at least as often as C11's detection bound.
 *
 * Two facts, both named. `declaredMs` is what the startup document states and
 * `effectiveMs` is what `getSweepIntervalMs` will really use after its own
 * default and floor; a mismatch is its own failure, because a document that
 * disagrees with the daemon is the silent pass this check exists to prevent.
 */
export function assertFactoryOrphanDetectionBound(
  declaredMs: number,
  effectiveMs: number,
  config: FactoryBootConfig = factoryBootConfig,
): void {
  if (!config.enabled) return;
  if (!Number.isSafeInteger(declaredMs) || declaredMs < 1 || declaredMs > FACTORY_ORPHAN_DETECTION_BOUND_MS) {
    const error = new FactoryBootError("factory-orphan-sweep-too-slow",
      `Factory startup requires an orphan sweep at most every ${FACTORY_ORPHAN_DETECTION_BOUND_MS} ms; this installation declares ${declaredMs}.`);
    setReadiness({ state: "degraded", reason: error.code, detail: { declaredMs, boundMs: FACTORY_ORPHAN_DETECTION_BOUND_MS } });
    throw error;
  }
  if (effectiveMs !== declaredMs) {
    const error = new FactoryBootError("factory-orphan-sweep-mismatch",
      `The factory declares an orphan sweep every ${declaredMs} ms and the host maintenance daemon will use ${effectiveMs} ms.`);
    setReadiness({ state: "degraded", reason: error.code, detail: { declaredMs, effectiveMs, boundMs: FACTORY_ORPHAN_DETECTION_BOUND_MS } });
    throw error;
  }
}

function isWithin(root: string, path: string): boolean {
  try {
    // This is a boundary, not a convenience check. Canonical paths make a
    // secrets-dir symlink into a grantable root fail closed as well.
    const canonicalRoot = realpathSync(resolve(root));
    const canonicalPath = realpathSync(resolve(path));
    const rootPrefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`;
    return canonicalPath === canonicalRoot || canonicalPath.startsWith(rootPrefix);
  } catch {
    // A missing or unresolvable mount cannot prove isolation.
    return true;
  }
}
