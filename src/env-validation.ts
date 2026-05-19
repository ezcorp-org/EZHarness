import { logger } from "./logger";

const log = logger.child("env-validation");

const MIN_SECRET_LENGTH = 16;

/**
 * Validates ops-critical environment variables on startup.
 *
 * Philosophy: every variable is OPTIONAL — the platform has sensible
 * dev defaults (auto-generated secrets, embedded PGlite). What this
 * function catches is *malformed* values: short secrets, bad DB URLs,
 * out-of-range ports. Misconfiguration in production should fail fast
 * with an actionable message rather than silently producing a broken
 * server.
 *
 * Throws `Error` with var-name + what's wrong + how to fix on any
 * malformed value. Emits a `warn` log when a security-critical secret
 * is unset (the auto-generation path is fine for dev, but operators
 * deploying multi-instance should know).
 */
export function validateEnv(): void {
  validateSecret("EZCORP_ENCRYPTION_SECRET");
  validateSecret("EZCORP_JWT_SECRET");
  validateDatabaseUrl();
  validatePort("EZCORP_OAUTH_CB_PORT");
}

function validateSecret(varName: string): void {
  const value = process.env[varName];
  if (value === undefined || value === "") {
    log.warn(
      `${varName} is unset; falling back to auto-generated secret. ` +
        `Set ${varName} explicitly (≥${MIN_SECRET_LENGTH} chars) for ` +
        `production / multi-instance deployments.`,
    );
    return;
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${varName} is too short (${value.length} chars). ` +
        `Must be at least ${MIN_SECRET_LENGTH} characters. ` +
        `Generate one with: openssl rand -hex 32`,
    );
  }
}

function validateDatabaseUrl(): void {
  const value = process.env.DATABASE_URL;
  if (value === undefined || value === "") return;
  if (!value.startsWith("postgres://") && !value.startsWith("postgresql://")) {
    throw new Error(
      `DATABASE_URL is malformed: must start with "postgres://" or ` +
        `"postgresql://" (got "${value.slice(0, 32)}…"). ` +
        `Example: postgres://user:pass@host:5432/dbname. ` +
        `Unset DATABASE_URL to use the embedded PGlite store instead.`,
    );
  }
}

function validatePort(varName: string): void {
  const value = process.env[varName];
  if (value === undefined || value === "") return;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(
      `${varName} is not a valid port: "${value}". ` +
        `Must be an integer in 1–65535. Unset to use the default.`,
    );
  }
}
