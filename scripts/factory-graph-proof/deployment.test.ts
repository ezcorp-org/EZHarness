import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  assertDeploymentDir,
  DEPLOYMENT_FILE,
  deploymentEnvironment,
  DeploymentRefusedError,
  MASTER_KEY_FILE,
  openDeployment,
  recordDeployment,
  WEB_SECRETS_FILE,
  WRAPS_FILE,
  type DeploymentPlaces,
} from "./deployment";

const uid = process.getuid!();
const runtime = `/run/user/${uid}`;
// The rule under test only allows folders under the tmpfs runtime folder, so the fixtures live there.
const scratch = mkdtempSync(join(runtime, "w10c-deployment-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const places: DeploymentPlaces = { uid, home: "/home/someone", repo: "/home/someone/repo", evidence: "/tmp/factory-platform-evidence" };
let serial = 0;
const fresh = () => join(scratch, `deployment-${++serial}`);
const name = () => `w19a_product_test_${serial}`;
const MASTER = Uint8Array.from({ length: 32 }, (_, index) => index);
const WRAPS = JSON.stringify({ schemaVersion: "factory.key-wraps.v1", wraps: [] });
const POSTGRES = "postgres://proof@127.0.0.1:5432/admin";

function refusal(code: string) {
  return expect.objectContaining({ name: "DeploymentRefusedError", code });
}

describe("where a deployment folder may live", () => {
  test("only under this user's tmpfs runtime folder", () => {
    expect(() => assertDeploymentDir(join(runtime, "w10c"), places)).not.toThrow();
    for (const dir of ["relative/w10c", "/tmp/w10c", runtime, `/run/user/${uid + 1}/w10c`, `${runtime}/../${uid + 1}/w10c`]) {
      expect(() => assertDeploymentDir(dir, places)).toThrow(DeploymentRefusedError);
    }
  });

  test("never inside the repository, HOME or the evidence folder, even when those sit under the runtime folder", () => {
    const local: DeploymentPlaces = { uid, home: join(runtime, "home"), repo: join(runtime, "repo"), evidence: join(runtime, "evidence") };
    for (const [dir, where] of [[join(runtime, "repo", "d"), "the repository"], [join(runtime, "home", "d"), "HOME"], [join(runtime, "evidence", "d"), "the evidence folder"]]) {
      expect(() => assertDeploymentDir(dir!, local)).toThrow(`must not be inside ${where}`);
    }
  });
});

describe("a persistent deployment", () => {
  test("first start: a fresh database name and fresh secrets, a private folder, nothing recorded yet", async () => {
    const dir = fresh();
    const deployment = await openDeployment(dir, { places, databaseExists: async () => false, newDatabaseName: name });
    expect(deployment).toMatchObject({ mode: "fresh", productDatabase: name() });
    const { jwt, encryption, salt } = deployment.webSecrets;
    expect(new Set([jwt, encryption, salt]).size).toBe(3);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("later start: the same database and the same key material, and no new name is asked for", async () => {
    const dir = fresh();
    const first = await openDeployment(dir, { places, databaseExists: async () => false, newDatabaseName: name });
    await recordDeployment(dir, first, MASTER, WRAPS);
    for (const file of [DEPLOYMENT_FILE, WEB_SECRETS_FILE, MASTER_KEY_FILE, WRAPS_FILE]) expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    const asked: string[] = [];
    const second = await openDeployment(dir, { places, databaseExists: async (database) => { asked.push(database); return true; }, newDatabaseName: () => { throw new Error("a reused deployment must not be renamed"); } });
    expect(second).toEqual({ mode: "reuse", productDatabase: first.productDatabase, webSecrets: first.webSecrets, masterKey: MASTER, wraps: WRAPS });
    expect(asked).toEqual([first.productDatabase]);
  });

  test("a folder that names a database that no longer exists is refused by that name", async () => {
    const dir = fresh();
    const first = await openDeployment(dir, { places, databaseExists: async () => false, newDatabaseName: name });
    await recordDeployment(dir, first, MASTER, WRAPS);
    const opening = openDeployment(dir, { places, databaseExists: async () => false, newDatabaseName: name });
    await expect(opening).rejects.toEqual(refusal("deployment_database_missing"));
    await expect(openDeployment(dir, { places, databaseExists: async () => false, newDatabaseName: name })).rejects.toThrow(`deployment ${first.productDatabase} names a database that does not exist`);
  });

  test("a half-written or tampered folder is refused as incomplete, never treated as fresh", async () => {
    const lacking = fresh();
    mkdirSync(lacking, { mode: 0o700 });
    writeFileSync(join(lacking, DEPLOYMENT_FILE), JSON.stringify({ productDatabase: "w19a_product_half" }));
    await expect(openDeployment(lacking, { places, databaseExists: async () => true, newDatabaseName: name })).rejects.toThrow(`deployment w19a_product_half lacks ${WEB_SECRETS_FILE}`);

    for (const productDatabase of ["postgres", 'w19a_product_x"; DROP DATABASE postgres; --', 7]) {
      const dir = fresh();
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(join(dir, DEPLOYMENT_FILE), JSON.stringify({ productDatabase }));
      await expect(openDeployment(dir, { places, databaseExists: async () => true, newDatabaseName: name })).rejects.toEqual(refusal("deployment_incomplete"));
    }

    const unreadable = fresh();
    const first = await openDeployment(unreadable, { places, databaseExists: async () => false, newDatabaseName: name });
    await recordDeployment(unreadable, first, MASTER, WRAPS);
    writeFileSync(join(unreadable, WEB_SECRETS_FILE), JSON.stringify({ jwt: "j", encryption: "", salt: "s" }));
    await expect(openDeployment(unreadable, { places, databaseExists: async () => true, newDatabaseName: name })).rejects.toThrow(`deployment ${first.productDatabase} has an unreadable ${WEB_SECRETS_FILE}`);

    await expect(openDeployment(fresh(), { places, databaseExists: async () => false, newDatabaseName: () => "public" })).rejects.toEqual(refusal("deployment_incomplete"));
  });

  test("a folder outside the allowed place is refused before anything is created", async () => {
    await expect(openDeployment("/tmp/w10c-not-allowed", { places, databaseExists: async () => true, newDatabaseName: name })).rejects.toEqual(refusal("deployment_dir_not_allowed"));
    expect(() => statSync("/tmp/w10c-not-allowed")).toThrow();
  });
});

describe("the probe environment for a deployment", () => {
  test("points at the deployment's database with its own encryption secret and salt", async () => {
    const dir = fresh();
    const first = await openDeployment(dir, { places, databaseExists: async () => false, newDatabaseName: name });
    await recordDeployment(dir, first, MASTER, WRAPS);
    expect(await deploymentEnvironment(dir, places, POSTGRES)).toEqual({
      DATABASE_URL: `postgres://proof@127.0.0.1:5432/${first.productDatabase}`,
      EZCORP_ENCRYPTION_SECRET: first.webSecrets.encryption,
      EZCORP_ENCRYPTION_SALT: first.webSecrets.salt,
    });
  });

  test("refuses a folder outside the allowed place and a tampered database name", async () => {
    await expect(deploymentEnvironment("/tmp/w10c-not-allowed", places, POSTGRES)).rejects.toEqual(refusal("deployment_dir_not_allowed"));
    const dir = fresh();
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, DEPLOYMENT_FILE), JSON.stringify({ productDatabase: "admin" }));
    await expect(deploymentEnvironment(dir, places, POSTGRES)).rejects.toEqual(refusal("deployment_incomplete"));
  });
});
