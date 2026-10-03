import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { closeTestDb, mockDbConnection, setupTestDb } from "../src/__tests__/helpers/test-pglite";

// In-process cases read the test database through the mocked connection.
mockDbConnection();

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oauthSettingKey } from "../src/providers/credential-store";
import { encrypt } from "../src/providers/encryption";
import { deleteSetting, upsertSetting } from "../src/db/queries/settings";
import { REFERENCE_CODE_MODEL_PIN, runReferenceCodeProviderCheck, withDeploymentStore } from "./verify-factory-reference-code-provider";

const OAUTH_TOKEN = "fixture-oauth-token";
const scratch = mkdtempSync(join(tmpdir(), "w10c-probe-"));
const previousSecretsDir = process.env.EZCORP_SECRETS_DIR;

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
  test("pins the reviewed C10 revision: openai gpt-5.6-luna", () => {
    expect(REFERENCE_CODE_MODEL_PIN).toEqual({ provider: "openai", model: "gpt-5.6-luna" });
    expect(Object.isFrozen(REFERENCE_CODE_MODEL_PIN)).toBe(true);
  });

  test("reads ready on a deployment signed in with OAuth, and records only the credential kind", async () => {
    await upsertSetting(oauthSettingKey("openai"), encrypt(JSON.stringify({ access: OAUTH_TOKEN, refresh: "fixture-refresh-token", expires: Date.now() + 3_600_000 })));
    const evidencePath = join(scratch, "ready.json");
    const { log, lines } = capture();
    expect(await runReferenceCodeProviderCheck({ evidencePath, log })).toBe(0);
    const record = JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({ provider: "openai", model: "gpt-5.6-luna", ready: true, credentialKind: "oauth", failures: [] });
    expect(readFileSync(evidencePath, "utf8")).not.toContain(OAUTH_TOKEN);
    expect(lines.join("\n")).not.toContain(OAUTH_TOKEN);
  });

  test("names the missing credential, and only that, on a deployment with no login", async () => {
    const { log, lines } = capture();
    expect(await runReferenceCodeProviderCheck({ log })).toBe(1);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ ready: false, credentialKind: null, failures: ["provider_not_configured"] });
  });

  test("the shared store helper returns the work's answer and passes its failure through unchanged", async () => {
    expect(await withDeploymentStore(async () => "answered")).toBe("answered");
    const failure = new Error("work failed");
    await expect(withDeploymentStore(async () => { throw failure; })).rejects.toBe(failure);
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
    expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toMatchObject({ provider: "openai", model: "gpt-5.6-luna", ready: false, credentialKind: null, failures: ["provider_not_configured"] });
  });
});
