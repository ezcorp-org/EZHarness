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
      | "factory-services-unavailable",
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
