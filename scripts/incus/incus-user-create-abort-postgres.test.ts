import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { createHash, generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { sql, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "../../src/db/schema";
import { patchJsonColumns } from "../../src/db/nul-column-patch";
import { sandboxPresetDigest, SANDBOX_PROVIDER_OPERATIONS, sandboxProviderMethodSchemas } from "@ezcorp/extension-contract";
import { incusManifest, INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { makeTestCertificates } from "../../src/infrastructure/incus-transport/test-certificates";
import { SandboxController, operationPayloadHash } from "../../src/sandboxes/controller";
import { resourceName, incusLifecycleOperationId } from "../../src/infrastructure/incus-transport/lifecycle";
import { up as addController } from "../../src/db/migrations/add-sandbox-controller";
import { up as addReleaseTables } from "../../src/db/migrations/add-extension-releases";
import { up as addConnections } from "../../src/db/migrations/add-provider-connections";
import { up as addFixtures } from "../../src/db/migrations/add-incus-qualification-fixtures";
import { up as addRecovery } from "../../src/db/migrations/add-incus-noeffect-recoveries";
import { up as addRuns } from "../../src/db/migrations/add-incus-qualification-runs";
import * as recovery from "../../src/infrastructure/incus-create-noeffect-recovery";
import testImages from "../test-images.json";

const container = `user-abort-postgres-${crypto.randomUUID()}`;
const databases: { name: string; client: SQL; peer: SQL; dispose: () => void }[] = [];
let admin: SQL;
let destination: URL;
let ownsContainer = false;

async function podman(...args: string[]) {
  const child = Bun.spawn(["podman", ...args], { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(error);
  return output.trim();
}

beforeAll(async () => {
  const supplied = process.env.EZCORP_CONTINUATION_TEST_PG_URL;
  if (supplied) {
    destination = new URL(supplied);
    if (destination.hostname !== "127.0.0.1" || destination.pathname !== "/continuation_fixture") {
      throw new Error("Only the existing disposable loopback PostgreSQL lane is allowed");
    }
  } else {
    await podman("run", "-d", "--name", container, "--pull=never", "--log-driver=none", "--memory=256m", "-e", "POSTGRES_PASSWORD=fixture", "-p", "127.0.0.1::5432", testImages.postgres);
    ownsContainer = true;
    const port = (await podman("port", container, "5432/tcp")).split(":").at(-1);
    await podman("exec", container, "sh", "-c", "for attempt in $(seq 1 100); do pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && exit 0; sleep 0.1; done; exit 1");
    destination = new URL(`postgres://postgres:fixture@127.0.0.1:${port}/postgres`);
  }
  destination.pathname = "/postgres";
  admin = new SQL(destination.toString(), { max: 1, connectionTimeout: 10 });
  await admin`SELECT 1`;
  await patchJsonColumns(true);
}, 30_000);

afterAll(async () => {
  for (const fixture of databases) {
    await fixture.client.close({ timeout: 1 });
    await fixture.peer.close({ timeout: 1 });
    await admin.unsafe(`DROP DATABASE "${fixture.name}"`);
    fixture.dispose();
  }
  await admin?.close({ timeout: 1 });
  if (ownsContainer) await podman("rm", "-f", container);
}, 30_000);

type UserFixture = {
  db: ReturnType<typeof drizzle>;
  peer: ReturnType<typeof drizzle>;
  signed: recovery.UserCreateRecoveryReceipt;
  abort: recovery.UserCreateAbortReceipt;
  publicKeyPem: string;
};

/** Reuse the existing seed and signed payload functions, without registering
 * its PGlite tests. Only the fixture driver differs.
 * All tested recovery consumers and PostgreSQL transactions are real. */
async function fixture(): Promise<UserFixture> {
  const name = `user_abort_fixture_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(destination); url.pathname = `/${name}`;
  const client = new SQL(url.toString(), { max: 3, connectionTimeout: 10 });
  const peer = new SQL(url.toString(), { max: 1, connectionTimeout: 10 });
  await client`SET statement_timeout = '10s'`;
  await peer`SET statement_timeout = '10s'`;
  const owned: (typeof databases)[number] = { name, client, peer, dispose: () => undefined };
  databases.push(owned);
  const database = drizzle(client, { schema });
  const source = readFileSync(new URL("../../src/infrastructure/incus-fenced-cleanup-recovery.test.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("seed.ts", source, ts.ScriptTarget.Latest, true);
  const functions = new Set(["setup", "receipt", "userCreateSetup", "userAbortReceipt"]);
  const globals = new Set(["clients", "fixtureOperationId", "bindingId", "operationId", "scope", "publicKeyPem", "now", "certificates", "serverCertificatePem", "serverCertificateSha256", "preset", "presetDigest", "manifest", "releaseDigest"]);
  const selected = ast.statements.filter(node => {
    if (ts.isFunctionDeclaration(node)) return functions.has(node.name?.text ?? "");
    if (ts.isVariableStatement(node)) return node.declarationList.declarations.some(declaration => globals.has(declaration.name.getText(ast)) || declaration.name.getText(ast) === "{ privateKey, publicKey }");
    return (ts.isExpressionStatement(node) && node.getText(ast).startsWith("manifest.")) || (ts.isForOfStatement(node) && node.getText(ast).includes("SANDBOX_PROVIDER_OPERATIONS"));
  });
  expect(selected.filter(ts.isFunctionDeclaration)).toHaveLength(4);
  let body = selected.map(node => node.getText(ast)).join("\n");
  body = body.replace('await import("./incus-create-noeffect-recovery")', "await Promise.resolve(recovery)");
  body += "\nconst seeded = await userCreateSetup(); return { ...seeded, abort: userAbortReceipt(seeded), publicKeyPem, dispose: () => certificates.dispose() };";
  const compiled = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  class FixtureDriver { waitReady = Promise.resolve(); exec(text: string) { return client.unsafe(text).simple(); } }
  const certificates = () => {
    const result = makeTestCertificates(); owned.dispose = () => result.dispose(); return result;
  };
  const bindings = { PGlite: FixtureDriver, drizzle: () => database, schema, sql, createHash, generateKeyPairSync, sign, X509Certificate, sandboxPresetDigest, SANDBOX_PROVIDER_OPERATIONS, sandboxProviderMethodSchemas, incusManifest, INCUS_PRESETS, makeTestCertificates: certificates, operationPayloadHash, resourceName, incusLifecycleOperationId, addController, addReleaseTables, addConnections, addFixtures, addRecovery, addRuns, recovery, canonicalRecoveryJson: recovery.canonicalRecoveryJson, recoveryRowHash: recovery.recoveryRowHash };
  const build = new Function(...Object.keys(bindings), `return (async () => { ${compiled} })();`);
  const seeded = await build(...Object.values(bindings)) as UserFixture & { dispose: () => void };
  owned.dispose = seeded.dispose;
  return { ...seeded, peer: drizzle(peer, { schema }) };
}

const rows = (f: UserFixture) => Promise.all([schema.projects, schema.projectMembers, schema.sandboxBindings, schema.sandboxOperations, schema.sandboxReservations, schema.sandboxAdmissionRequests].map(table => f.db.select().from(table)));

test("PostgreSQL USER abort preserves all original rows and refuses stale signed settlement", async () => {
  const f = await fixture(), original = await rows(f);
  expect(await recovery.userCreateRecoveryAbort(f.db, f.abort, f.publicKeyPem, false)).toHaveProperty("status", "uncommitted");
  const proof = await recovery.userCreateRecoveryAbort(f.db, f.abort, f.publicKeyPem, true);
  expect(proof).toHaveProperty("abortId");
  expect(await rows(f)).toEqual(original);
  expect(await recovery.userCreateRecoveryAbort(f.db, f.abort, f.publicKeyPem, true)).toEqual(proof);
  await expect(recovery.applyUserCreateRecovery(f.db, f.signed, f.publicKeyPem)).rejects.toThrow("nonce");
  expect(await rows(f)).toEqual(original);
  expect(await f.db.select().from(schema.incusFencedCleanupNonceClaims)).toHaveLength(1);
  expect(await f.db.select().from(schema.incusFencedCleanupAborts)).toHaveLength(1);
  const [json] = await f.db.execute(sql`SELECT jsonb_typeof(receipt) AS type FROM incus_fenced_cleanup_aborts`);
  expect(json.type).toBe("object");
}, 30_000);

test("PostgreSQL USER abort and settlement have exactly one concurrent winner", async () => {
  const f = await fixture();
  const [first, second] = await Promise.all([f.db.execute(sql`SELECT pg_backend_pid() AS pid`), f.peer.execute(sql`SELECT pg_backend_pid() AS pid`)]);
  expect(first[0]?.pid).not.toBe(second[0]?.pid);
  const outcomes = await Promise.allSettled([recovery.userCreateRecoveryAbort(f.db, f.abort, f.publicKeyPem, true), recovery.applyUserCreateRecovery(f.peer, f.signed, f.publicKeyPem)]);
  expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
  expect(await f.db.select().from(schema.incusFencedCleanupNonceClaims)).toHaveLength(1);
  expect(await f.db.select().from(schema.sandboxOperations).where(eq(schema.sandboxOperations.id, f.signed.payload.operationId))).toMatchObject([{ state: "FAILED" }]);
}, 30_000);

async function observedLock(f: UserFixture, predicate: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = await f.db.execute(sql`SELECT COUNT(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${predicate}`);
    if (Number(found[0]?.count) > 0) return;
    await Bun.sleep(10);
  }
  throw new Error("The expected actual PostgreSQL lock boundary was not observed");
}

test("PostgreSQL ordinary journal racing USER abort cannot pass stale target validation", async () => {
  const f = await fixture();
  const barrier = await f.db.$client.reserve();
  await barrier`SELECT pg_advisory_lock(716204)`;
  let journal: Promise<unknown> | undefined;
  let abort: Promise<unknown> | undefined;
  try {
    await f.db.execute(sql`CREATE FUNCTION pause_user_journal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(716204); RETURN NEW; END $$`);
    await f.db.execute(sql`CREATE TRIGGER pause_user_journal BEFORE UPDATE ON sandbox_bindings FOR EACH ROW EXECUTE FUNCTION pause_user_journal()`);
    const forbidden = async () => { throw new Error("Provider calls are forbidden in this database fixture"); };
    const controller = new SandboxController(f.peer, { dispatch: forbidden, inspectOperation: forbidden });
    journal = controller.journalOperation({ bindingId: f.signed.payload.bindingId, kind: "STOP", generation: 1,
      idempotencyScope: "incus-management-ui", idempotencyKey: "parallel-user-journal", payload: { expectedGeneration: 1 } });
    await observedLock(f, "%update%sandbox_bindings%");
    abort = recovery.userCreateRecoveryAbort(f.db, f.abort, f.publicKeyPem, true);
    await observedLock(f, "%sandbox_bindings%for update%");
  } finally {
    await barrier`SELECT pg_advisory_unlock(716204)`;
    barrier.release();
  }
  expect(journal).toBeDefined(); expect(abort).toBeDefined();
  await journal;
  await expect(abort!).rejects.toThrow();
  expect(await f.db.select().from(schema.incusFencedCleanupNonceClaims)).toHaveLength(0);
  expect(await f.db.select().from(schema.incusFencedCleanupAborts)).toHaveLength(0);
  expect(await f.db.select().from(schema.sandboxOperations).where(eq(schema.sandboxOperations.id, f.signed.payload.operationId))).toMatchObject([{ state: "FAILED" }]);
}, 30_000);

test("PostgreSQL USER abort rollback leaves no nonce and authority drift denies", async () => {
  const f = await fixture(), original = await rows(f);
  await f.db.execute(sql`CREATE FUNCTION deny_user_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected USER abort rollback'; END $$`);
  await f.db.execute(sql`CREATE TRIGGER deny_user_abort BEFORE INSERT ON incus_fenced_cleanup_aborts FOR EACH ROW EXECUTE FUNCTION deny_user_abort()`);
  try {
    await recovery.userCreateRecoveryAbort(f.db, f.abort, f.publicKeyPem, true);
    throw new Error("The database rollback trigger must refuse");
  } catch (error) {
    expect(String((error as { cause?: unknown }).cause)).toContain("injected USER abort rollback");
  }
  expect(await f.db.select().from(schema.incusFencedCleanupNonceClaims)).toHaveLength(0);
  expect(await f.db.select().from(schema.incusFencedCleanupAborts)).toHaveLength(0);
  expect(await rows(f)).toEqual(original);
  await f.db.execute(sql`DROP TRIGGER deny_user_abort ON incus_fenced_cleanup_aborts`);
  await f.db.update(schema.projectMembers).set({ userId: "different-owner" });
  await expect(recovery.userCreateRecoveryAbort(f.db, f.abort, f.publicKeyPem, true)).rejects.toThrow();
  expect(await f.db.select().from(schema.incusFencedCleanupNonceClaims)).toHaveLength(0);
}, 30_000);
