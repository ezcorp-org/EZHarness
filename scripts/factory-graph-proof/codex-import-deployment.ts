/**
 * The Codex-login import against a persistent proof deployment (W4H-28, lead's ruling 2).
 *
 *   --deployment <dir> --postgres-env <file> --postgres-port <port>
 *
 * Reads the deployment's files (deployment.json, web-secrets.json) and the shared PostgreSQL's env file BY PATH and
 * sets the import's environment in THIS process, before the database module loads (it reads DATABASE_URL at load).
 * No secret passes through argv, a shell, an eval, or the environment the process started with, so none shows in
 * /proc/<pid>/cmdline or /proc/<pid>/environ, and a value with $, a backtick, a backslash or a quote stays unchanged.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { errorShape } from "../../src/providers/error-shape";
import { deploymentEnvironment, DeploymentRefusedError, type DeploymentPlaces } from "./deployment";

/** The import's own command line (only the part this file needs). */
interface ImportCli {
  readonly runCodexLoginImportCli: (argv: readonly string[]) => Promise<number>;
}

const defaultPlaces = (): DeploymentPlaces => ({
  uid: process.getuid!(), home: process.env.HOME ?? "/", repo: resolve(import.meta.dir, "../.."), evidence: "/tmp/factory-platform-evidence",
});

function option(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

/** KEY=VALUE lines, as the proof scripts' env files hold them; a value is every character after the first `=`. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) values[match[1]!] = match[2]!;
  }
  return values;
}

/** The import's environment for the deployment the arguments name, or undefined when they name none. */
export async function deploymentImportEnvironment(argv: readonly string[], places: DeploymentPlaces): Promise<Record<string, string> | undefined> {
  const dir = option(argv, "--deployment");
  if (dir === undefined) return undefined;
  const envFile = option(argv, "--postgres-env"), port = option(argv, "--postgres-port");
  if (!envFile || !port || !/^[1-9][0-9]{0,4}$/.test(port)) {
    throw new DeploymentRefusedError("deployment_incomplete", "--deployment needs --postgres-env <file> and --postgres-port <port>");
  }
  const postgres = parseEnvFile(await readFile(envFile, "utf8"));
  const url = new URL("postgres://127.0.0.1");
  url.port = port;
  url.username = postgres.POSTGRES_USER ?? "";
  url.password = postgres.POSTGRES_PASSWORD ?? "";
  return deploymentEnvironment(dir, places, url.toString());
}

/** The script: apply the deployment's environment, then load and run the import's command line. */
export async function runCodexImportScript(
  argv: readonly string[],
  places: DeploymentPlaces = defaultPlaces(),
  io: { readonly err: (line: string) => void } = { err: console.error.bind(console) },
  load: () => Promise<ImportCli> = () => import("../../src/providers/codex-login-import"),
): Promise<number> {
  let environment: Record<string, string> | undefined;
  try {
    environment = await deploymentImportEnvironment(argv, places);
  } catch (error) {
    io.err(JSON.stringify(error instanceof DeploymentRefusedError ? { error: error.code } : { error: "deployment_unreadable", ...errorShape(error) }));
    return 2;
  }
  if (environment) {
    Object.assign(process.env, environment);
    // The deployment's secret is the only one: a local secrets folder or embedded database must not take part.
    delete process.env.EZCORP_SECRETS_DIR;
    delete process.env.EZCORP_DB_PATH;
  }
  return (await load()).runCodexLoginImportCli(argv);
}
