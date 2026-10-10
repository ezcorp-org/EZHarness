/**
 * An opt-in persistent deployment for the proof stack (W10c, coordinator ruling 2026-10-03).
 *
 * By default every stack start is a new installation: a fresh product database and fresh key
 * material. A provider sign-in made in one start is then gone at the next, because the login
 * lives encrypted in the product database under that start's encryption secret. A persistent
 * deployment keeps exactly what the next start needs to be the same installation:
 *
 *   - the product database, by NAME (`deployment.json`, the only non-secret file);
 *   - the web process's encryption secret, salt and session secret (`web-secrets.json`, 0600);
 *   - the installation master key and its key wraps (`master.key`, `wraps.json`, 0600).
 *
 * The folder must live under this user's tmpfs runtime folder (`/run/user/<uid>/`), never under
 * the repository, HOME, or the evidence folder: the files are credentials. A record or receipt
 * names the deployment by its database name only, never a path inside the folder or a value.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export const DEPLOYMENT_FILE = "deployment.json";
export const WEB_SECRETS_FILE = "web-secrets.json";
export const MASTER_KEY_FILE = "master.key";
export const WRAPS_FILE = "wraps.json";

const PRODUCT_DATABASE = /^w19a_product_[0-9a-z_]{1,48}$/;

export interface WebSecrets {
  readonly jwt: string;
  readonly encryption: string;
  readonly salt: string;
}

export interface PersistentDeployment {
  readonly mode: "fresh" | "reuse";
  readonly productDatabase: string;
  readonly webSecrets: WebSecrets;
  /** The installation master key and its wraps document, when a previous start recorded them. */
  readonly masterKey?: Uint8Array;
  readonly wraps?: string;
}

export class DeploymentRefusedError extends Error {
  constructor(readonly code: "deployment_dir_not_allowed" | "deployment_database_missing" | "deployment_incomplete", message: string) {
    super(`${code}: ${message}`);
    this.name = "DeploymentRefusedError";
  }
}

export interface DeploymentPlaces {
  readonly uid: number;
  readonly home: string;
  readonly repo: string;
  readonly evidence: string;
}

function inside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** Refuses any folder outside `/run/user/<uid>/`, or inside the repository, HOME or the evidence folder. */
export function assertDeploymentDir(dir: string, places: DeploymentPlaces): void {
  const runtime = `/run/user/${places.uid}`;
  if (!isAbsolute(dir) || !inside(runtime, dir) || resolve(dir) === resolve(runtime)) {
    throw new DeploymentRefusedError("deployment_dir_not_allowed", `the deployment folder must be a folder under ${runtime}/`);
  }
  for (const [name, forbidden] of [["the repository", places.repo], ["HOME", places.home], ["the evidence folder", places.evidence]] as const) {
    if (inside(forbidden, dir)) throw new DeploymentRefusedError("deployment_dir_not_allowed", `the deployment folder must not be inside ${name}`);
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function privateWrite(path: string, content: string | Uint8Array): Promise<void> {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

export interface OpenDeploymentOptions {
  readonly places: DeploymentPlaces;
  /** Whether the shared PostgreSQL holds a database of this name. */
  readonly databaseExists: (name: string) => Promise<boolean>;
  /** The name a fresh product database gets. */
  readonly newDatabaseName: () => string;
}

/**
 * Opens the deployment the folder names, or prepares a fresh one.
 *
 * Fresh: nothing recorded yet. The caller creates the database, then calls {@link recordDeployment}.
 * Reuse: the database must still exist, by name; a folder that names a dropped database is refused,
 * because starting on an empty database would silently be a different installation.
 */
export async function openDeployment(dir: string, options: OpenDeploymentOptions): Promise<PersistentDeployment> {
  assertDeploymentDir(dir, options.places);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  if (!await exists(join(dir, DEPLOYMENT_FILE))) {
    const productDatabase = options.newDatabaseName();
    if (!PRODUCT_DATABASE.test(productDatabase)) throw new DeploymentRefusedError("deployment_incomplete", "a fresh product database name is malformed");
    const secret = () => randomBytes(24).toString("hex");
    return { mode: "fresh", productDatabase, webSecrets: { jwt: `w19a-jwt-${secret()}`, encryption: `w19a-enc-${secret()}`, salt: secret() } };
  }
  const recorded = JSON.parse(await readFile(join(dir, DEPLOYMENT_FILE), "utf8")) as { productDatabase?: unknown };
  const productDatabase = recorded.productDatabase;
  if (typeof productDatabase !== "string" || !PRODUCT_DATABASE.test(productDatabase)) {
    throw new DeploymentRefusedError("deployment_incomplete", `${DEPLOYMENT_FILE} does not name a product database`);
  }
  for (const file of [WEB_SECRETS_FILE, MASTER_KEY_FILE, WRAPS_FILE]) {
    if (!await exists(join(dir, file))) throw new DeploymentRefusedError("deployment_incomplete", `deployment ${productDatabase} lacks ${file}`);
  }
  if (!await options.databaseExists(productDatabase)) {
    throw new DeploymentRefusedError("deployment_database_missing", `deployment ${productDatabase} names a database that does not exist`);
  }
  const webSecrets = JSON.parse(await readFile(join(dir, WEB_SECRETS_FILE), "utf8")) as WebSecrets;
  if (![webSecrets.jwt, webSecrets.encryption, webSecrets.salt].every((value) => typeof value === "string" && value.length > 0)) {
    throw new DeploymentRefusedError("deployment_incomplete", `deployment ${productDatabase} has an unreadable ${WEB_SECRETS_FILE}`);
  }
  return {
    mode: "reuse",
    productDatabase,
    webSecrets,
    masterKey: new Uint8Array(await readFile(join(dir, MASTER_KEY_FILE))),
    wraps: await readFile(join(dir, WRAPS_FILE), "utf8"),
  };
}

/**
 * Records a fresh deployment once its database exists and its key material is made. The secret
 * files are written first and the name file last, so a start that dies halfway leaves a folder
 * that the next start reads as incomplete rather than as a deployment.
 */
export async function recordDeployment(dir: string, deployment: PersistentDeployment, masterKey: Uint8Array, wraps: string): Promise<void> {
  await privateWrite(join(dir, WEB_SECRETS_FILE), JSON.stringify(deployment.webSecrets));
  await privateWrite(join(dir, MASTER_KEY_FILE), masterKey);
  await privateWrite(join(dir, WRAPS_FILE), wraps);
  await privateWrite(join(dir, DEPLOYMENT_FILE), JSON.stringify({ productDatabase: deployment.productDatabase, createdAt: new Date().toISOString() }));
}

/** The environment that points a probe at the deployment: for a child's env, never argv, never a log. */
export async function deploymentEnvironment(dir: string, places: DeploymentPlaces, postgresUrl: string): Promise<Record<string, string>> {
  assertDeploymentDir(dir, places);
  const recorded = JSON.parse(await readFile(join(dir, DEPLOYMENT_FILE), "utf8")) as { productDatabase: string };
  if (!PRODUCT_DATABASE.test(recorded.productDatabase)) throw new DeploymentRefusedError("deployment_incomplete", `${DEPLOYMENT_FILE} does not name a product database`);
  const secrets = JSON.parse(await readFile(join(dir, WEB_SECRETS_FILE), "utf8")) as WebSecrets;
  const url = new URL(postgresUrl);
  url.pathname = `/${recorded.productDatabase}`;
  return { DATABASE_URL: url.toString(), EZCORP_ENCRYPTION_SECRET: secrets.encryption, EZCORP_ENCRYPTION_SALT: secrets.salt };
}
