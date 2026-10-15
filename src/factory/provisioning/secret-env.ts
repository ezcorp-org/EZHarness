/**
 * Start a process with secrets read from private files into its environment.
 *
 * The harness reads `DATABASE_URL`, `EZCORP_JWT_SECRET`,
 * `EZCORP_ENCRYPTION_SECRET`, and `EZCORP_ENCRYPTION_SALT` from its
 * environment and nowhere else. A deployment must therefore put them there
 * without writing them into a Compose file, a Kubernetes manifest, or a
 * process listing. This wrapper is that seam: the deployment names FILES, this
 * reads each through the same private reader every factory process uses, and
 * the value exists only in the child's environment.
 *
 *   bun src/factory/provisioning/secret-env.ts /run/ezcorp/secrets/secret-env.json -- bun web/build/index.js
 */
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateDirectory, readPrivateBounded } from "../private-files";

export const FACTORY_SECRET_ENV_SCHEMA = "factory.secret-env.v1";
const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_VALUE_BYTES = 16 * 1024;

export interface FactorySecretEnvManifest {
  readonly schemaVersion: typeof FACTORY_SECRET_ENV_SCHEMA;
  /** Environment variable name -> absolute path of the private file holding its value. */
  readonly variables: Readonly<Record<string, string>>;
}

export class FactorySecretEnvError extends Error {
  constructor(message: string) { super(message); this.name = "FactorySecretEnvError"; }
}

async function readPrivate(path: string, limit: number): Promise<string> {
  const absolute = resolve(path);
  const directory = await privateDirectory(dirname(absolute));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(await readPrivateBounded(directory, basename(absolute), limit)); }
  finally { await directory.close(); }
}

export function parseFactorySecretEnvManifest(value: unknown): FactorySecretEnvManifest {
  const record = value as Partial<FactorySecretEnvManifest> | null;
  if (!record || typeof record !== "object" || Object.keys(record).sort().join(",") !== "schemaVersion,variables" || record.schemaVersion !== FACTORY_SECRET_ENV_SCHEMA
    || !record.variables || typeof record.variables !== "object" || Array.isArray(record.variables)) throw new FactorySecretEnvError("The secret environment manifest is invalid.");
  const entries = Object.entries(record.variables);
  if (entries.length === 0 || entries.length > 32 || entries.some(([name, path]) => !NAME.test(name) || typeof path !== "string" || resolve(path) !== path)) throw new FactorySecretEnvError("The secret environment manifest names an invalid variable or path.");
  return { schemaVersion: FACTORY_SECRET_ENV_SCHEMA, variables: Object.freeze(Object.fromEntries(entries)) };
}

/** Read every named file; a missing or non-private file fails by VARIABLE name, never by value. */
export async function loadFactorySecretEnvironment(manifestPath: string): Promise<Readonly<Record<string, string>>> {
  let manifest: FactorySecretEnvManifest;
  try { manifest = parseFactorySecretEnvManifest(JSON.parse(await readPrivate(manifestPath, 64 * 1024))); }
  catch (error) { throw error instanceof FactorySecretEnvError ? error : new FactorySecretEnvError("The secret environment manifest cannot be read privately."); }
  const values: Record<string, string> = {};
  for (const [name, path] of Object.entries(manifest.variables)) {
    let value: string;
    try { value = (await readPrivate(path, MAX_VALUE_BYTES)).replace(/\r?\n$/, ""); }
    catch { throw new FactorySecretEnvError(`The secret for ${name} cannot be read privately.`); }
    if (value.length === 0 || /[\r\n\0]/.test(value)) throw new FactorySecretEnvError(`The secret for ${name} is empty or spans lines.`);
    values[name] = value;
  }
  return Object.freeze(values);
}

export interface FactorySecretEnvDependencies {
  readonly spawn: (command: readonly string[], env: Record<string, string>) => { readonly exited: Promise<number>; kill(signal: NodeJS.Signals): void };
  readonly on: (signal: NodeJS.Signals, listener: () => void) => void;
  readonly exit: (code: number) => void;
  readonly report: (message: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Parse `<manifest> -- <command...>`, load, spawn, forward signals, and exit with the child's code. */
export async function runFactorySecretEnv(argv: readonly string[], dependencies: FactorySecretEnvDependencies): Promise<void> {
  const separator = argv.indexOf("--");
  const manifestPath = argv[0];
  if (!manifestPath || separator !== 1 || separator === argv.length - 1) {
    dependencies.report("usage: secret-env.ts <manifest.json> -- <command> [args...]");
    dependencies.exit(64);
    return;
  }
  let secrets: Readonly<Record<string, string>>;
  try { secrets = await loadFactorySecretEnvironment(manifestPath); }
  catch (error) {
    dependencies.report(`[secret-env] ${error instanceof Error ? error.message : String(error)}`);
    dependencies.exit(78);
    return;
  }
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(dependencies.env)) if (value !== undefined) env[name] = value;
  const child = dependencies.spawn(argv.slice(separator + 1), { ...env, ...secrets });
  for (const signal of ["SIGTERM", "SIGINT"] as const) dependencies.on(signal, () => child.kill(signal));
  dependencies.exit(await child.exited);
}

const productionDependencies: FactorySecretEnvDependencies = {
  spawn: (command, env) => { const child = Bun.spawn([...command], { env, stdio: ["inherit", "inherit", "inherit"] }); return { exited: child.exited, kill: (signal) => child.kill(signal) }; },
  on: (signal, listener) => { process.on(signal, listener); },
  exit: (code) => process.exit(code),
  report: (message) => console.error(message),
  env: process.env,
};

/** Run only when this file is the process entry, so importing it for a test starts nothing. */
export function startFactorySecretEnv(argv: readonly string[], moduleUrl: string, dependencies: FactorySecretEnvDependencies = productionDependencies): Promise<void> | undefined {
  if (!argv[1] || resolve(argv[1]) !== fileURLToPath(moduleUrl)) return undefined;
  return runFactorySecretEnv(argv.slice(2), dependencies);
}

void startFactorySecretEnv(process.argv, import.meta.url);
