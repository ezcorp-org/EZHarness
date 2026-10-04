import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { closeTestDb, mockDbConnection, setupTestDb } from "../src/__tests__/helpers/test-pglite";

// In-process cases read the test database through the mocked connection.
mockDbConnection();

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oauthSettingKey } from "../src/providers/credential-store";
import { encrypt } from "../src/providers/encryption";
import { deleteSetting, upsertSetting } from "../src/db/queries/settings";
import { REFERENCE_CODE_MODEL_PIN, runReferenceCodeProviderCheck, withDeploymentStore } from "./verify-factory-reference-code-provider";

const OAUTH_TOKEN = "fixture-oauth-token";
const scratch = mkdtempSync(join(tmpdir(), "w10c-probe-"));
const previousSecretsDir = process.env.EZCORP_SECRETS_DIR;
/** The in-process cases run on the mocked test database; this names it the way a test deployment does. */
const MEMORY = { EZCORP_DB_PATH: ":memory:", EZCORP_SECRETS_DIR: scratch };

beforeAll(async () => {
  // encrypt() persists a generated key beside the database; keep it out of the checkout.
  process.env.EZCORP_SECRETS_DIR = scratch;
  await setupTestDb();
});
afterAll(async () => {
  await closeTestDb();
  if (previousSecretsDir === undefined) delete process.env.EZCORP_SECRETS_DIR;
  else process.env.EZCORP_SECRETS_DIR = previousSecretsDir;
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(async () => { await deleteSetting(oauthSettingKey("openai")); });

function capture() {
  const lines: string[] = [];
  return { log: { log: (line: string) => { lines.push(line); } }, lines };
}

describe("the reference code provider probe", () => {
  test("pins the reviewed C10 revision: openai gpt-6-luna", () => {
    expect(REFERENCE_CODE_MODEL_PIN).toEqual({ provider: "openai", model: "gpt-6-luna" });
    expect(Object.isFrozen(REFERENCE_CODE_MODEL_PIN)).toBe(true);
  });

  test("reads ready on a deployment signed in with OAuth, and records only the credential kind", async () => {
    await upsertSetting(oauthSettingKey("openai"), encrypt(JSON.stringify({ access: OAUTH_TOKEN, refresh: "fixture-refresh-token", expires: Date.now() + 3_600_000 })));
    const evidencePath = join(scratch, "ready.json");
    const { log, lines } = capture();
    expect(await runReferenceCodeProviderCheck({ evidencePath, log, env: MEMORY })).toBe(0);
    const record = JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({ provider: "openai", model: "gpt-6-luna", ready: true, credentialKind: "oauth", failures: [] });
    expect(readFileSync(evidencePath, "utf8")).not.toContain(OAUTH_TOKEN);
    expect(lines.join("\n")).not.toContain(OAUTH_TOKEN);
  });

  test("names the missing credential, and only that, on a deployment with no login", async () => {
    const { log, lines } = capture();
    expect(await runReferenceCodeProviderCheck({ log, env: MEMORY })).toBe(1);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ ready: false, credentialKind: null, failures: ["provider_not_configured"], store: { kind: "pglite-memory", opened: true } });
  });

  test("the shared store helper returns the work's answer and passes its failure through unchanged", async () => {
    expect(await withDeploymentStore(async () => "answered", MEMORY)).toBe("answered");
    const failure = new Error("work failed");
    await expect(withDeploymentStore(async () => { throw failure; }, MEMORY)).rejects.toBe(failure);
    await expect(withDeploymentStore(async () => "never", {})).rejects.toThrow(/no configuration store is named/);
  });

  test("names the store by kind and records that it was opened, never its path", async () => {
    const { log, lines } = capture();
    await runReferenceCodeProviderCheck({ log, env: { EZCORP_DB_PATH: "/home/someone/private/ez-corp-db", EZCORP_SECRETS_DIR: scratch } });
    const record = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    expect(record.store).toEqual({ kind: "pglite-file", opened: true });
    expect(lines.join("\n")).not.toContain("someone");
  });

  test("stops by name when the environment names no store, and opens nothing", async () => {
    for (const env of [{}, { EZCORP_DB_PATH: ":memory:" }, { DATABASE_URL: "postgres://u@h/db" }]) {
      const { log, lines } = capture();
      expect(await runReferenceCodeProviderCheck({ log, env })).toBe(1);
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ ready: false, credentialKind: null, failures: ["store_not_named"], store: { opened: false } });
      expect(lines.join("\n")).not.toContain("postgres://");
    }
  });

  test("a command run with no store named writes nothing, neither in its folder nor in HOME", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "w10c-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "w10c-home-"));
    const env: Record<string, string | undefined> = { ...process.env, HOME: home };
    for (const name of ["DATABASE_URL", "EZCORP_DB_PATH", "EZCORP_SECRETS_DIR", "EZCORP_ENCRYPTION_SECRET", "EZCORP_ENCRYPTION_SALT"]) delete env[name];
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "verify-factory-reference-code-provider.ts")], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('"store_not_named"');
    expect(readdirSync(cwd)).toEqual([]);
    // `.bun` is the runtime's own cache folder, made by Bun for any process in a fresh HOME.
    expect(readdirSync(home).filter((name) => name !== ".bun")).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("a store that fails to open is named as unavailable, not as a missing credential", async () => {
    const env: Record<string, string | undefined> = { ...process.env, EZCORP_DB_PATH: "/proc/w10c-no-such-store/ez-corp-db", EZCORP_SECRETS_DIR: scratch };
    delete env.DATABASE_URL;
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "verify-factory-reference-code-provider.ts")], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(exitCode).toBe(1);
    const record = JSON.parse(stdout.slice(stdout.indexOf("{\n"))) as Record<string, unknown>;
    expect(record).toMatchObject({ ready: false, credentialKind: null, failures: ["store_unavailable"], store: { kind: "pglite-file", opened: false } });
    expect(stdout).not.toContain("w10c-no-such-store");
  });

  test("opens the deployment's own configuration store when run as a command", async () => {
    // A fresh in-memory deployment in a separate process: the mocked connection above cannot
    // show whether the command opens the store, only a real process can. Before the fix the
    // command never opened it, so every host read "not configured", signed in or not.
    const evidencePath = join(scratch, "cli.json");
    const env: Record<string, string | undefined> = { ...process.env, EZCORP_DB_PATH: ":memory:", EZCORP_SECRETS_DIR: scratch };
    delete env.DATABASE_URL;
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "verify-factory-reference-code-provider.ts"), "--evidence", evidencePath], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(stdout).not.toContain("provider configuration could not be read");
    expect(exitCode).toBe(1);
    expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toMatchObject({ provider: "openai", model: "gpt-6-luna", ready: false, credentialKind: null, failures: ["provider_not_configured"] });
  });
});
