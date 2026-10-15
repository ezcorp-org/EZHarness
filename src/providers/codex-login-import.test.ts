import { mockDbConnection, closeTestDb, setupTestDb } from "../__tests__/helpers/test-pglite";
mockDbConnection();
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSetting, getSetting, upsertSetting } from "../db/queries/settings";
import { getCredentialStore, oauthSettingKey } from "./credential-store";
import { _resetKeyCache, decrypt, encrypt } from "./encryption";
import { getCredential } from "./credentials";
import {
  codexLoginCredential,
  CodexLoginImportError,
  importCodexLogin,
  maskAccountId,
  runCodexLoginImportCli,
  type CodexLoginImportDeps,
} from "./codex-login-import";

const ACCOUNT = "fixture-account-0000-1234";
const EXP = Math.floor(Date.parse("2030-01-01T00:00:00.000Z") / 1_000);
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: "none" })}.${b64(payload)}.fixture-signature`;
const ACCESS = jwt({ exp: EXP, "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT } });
const REFRESH = "fixture-refresh-token-not-real";
const DB_PASSWORD = "fixture-db-password-not-real";
/** The shape the Codex CLI writes to ~/.codex/auth.json, holding only fixture values. */
const login = (tokens: Record<string, unknown> = {}) => ({ OPENAI_API_KEY: null, tokens: { id_token: "fixture-id-token", access_token: ACCESS, refresh_token: REFRESH, account_id: ACCOUNT, ...tokens }, last_refresh: "2029-12-31T00:00:00Z" });

const ENV_NAMES = ["DATABASE_URL", "EZCORP_ENCRYPTION_SECRET", "EZCORP_ENCRYPTION_SALT", "EZCORP_SECRETS_DIR"] as const;
const FIXTURE_ENV = {
  DATABASE_URL: `postgres://fixture_user:${DB_PASSWORD}@127.0.0.1:5999/fixture_product_db`,
  EZCORP_ENCRYPTION_SECRET: "fixture-encryption-secret-0000",
  EZCORP_ENCRYPTION_SALT: "fixture-salt-0000",
};
const dir = mkdtempSync(join(tmpdir(), "codex-login-import-"));
const previousEnv = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
function setEnv(values: Partial<Record<(typeof ENV_NAMES)[number], string | undefined>>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  _resetKeyCache();
}
beforeAll(async () => { await setupTestDb(); });
afterAll(async () => {
  await closeTestDb();
  setEnv(previousEnv);
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  setEnv({ ...FIXTURE_ENV, EZCORP_SECRETS_DIR: dir });
  await deleteSetting(oauthSettingKey("openai"));
});

/** The test database is already open (the mocked connection); a step's calls are counted. */
function deps(overrides: Partial<CodexLoginImportDeps> = {}): CodexLoginImportDeps & { calls: string[] } {
  const calls: string[] = [];
  return { calls, connect: async () => { calls.push("connect"); }, close: async () => { calls.push("close"); }, store: getCredentialStore(), ...overrides };
}
function authFile(value: unknown = login()): string {
  const from = join(dir, `auth-${crypto.randomUUID()}.json`);
  writeFileSync(from, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  return from;
}
async function refusal(run: Promise<unknown>): Promise<CodexLoginImportError> {
  const caught = await run.then(() => undefined, (error: unknown) => error);
  expect(caught).toBeInstanceOf(CodexLoginImportError);
  const error = caught as CodexLoginImportError;
  for (const secret of [ACCESS, REFRESH, DB_PASSWORD, FIXTURE_ENV.EZCORP_ENCRYPTION_SECRET, FIXTURE_ENV.EZCORP_ENCRYPTION_SALT]) {
    expect(JSON.stringify({ message: error.message, detail: error.detail })).not.toContain(secret);
  }
  return error;
}
const mapped = (value: unknown) => refusal((async () => codexLoginCredential(value))());

describe("a Codex CLI login maps to the application's ChatGPT-plan credential", () => {
  test("access, refresh and the account id map; the expiry is the access token's own exp", () => {
    expect(codexLoginCredential(login())).toEqual({ access: ACCESS, refresh: REFRESH, expires: EXP * 1_000, accountId: ACCOUNT });
  });

  test("the account id comes from the token's claim when the file does not carry it", () => {
    expect(codexLoginCredential(login({ account_id: undefined })).accountId).toBe(ACCOUNT);
  });

  test("an unexpected file shape names the key NAMES it found, never a value", async () => {
    expect(await mapped(null)).toMatchObject({ code: "codex_login_shape_unexpected", detail: { keys: [], tokenKeys: [] } });
    expect(await mapped({ tokens: {} })).toMatchObject({ code: "codex_login_shape_unexpected", detail: { keys: ["tokens"], tokenKeys: [] } });
    const error = await mapped({ auth_mode: "apikey", OPENAI_API_KEY: "fixture-api-key-value", tokens: { refresh_token: "" } });
    expect(error).toMatchObject({ code: "codex_login_shape_unexpected", detail: { keys: ["OPENAI_API_KEY", "auth_mode", "tokens"], tokenKeys: ["refresh_token"] } });
    expect(JSON.stringify(error.detail)).not.toContain("fixture-api-key-value");
    expect(JSON.stringify(error.detail)).not.toContain("apikey\"");
  });

  test("an access token that is not a JWT is refused by name with its segment count", async () => {
    expect(await mapped(login({ access_token: "not-a-jwt" }))).toMatchObject({ code: "codex_access_token_not_jwt", detail: { segments: 1 } });
    expect(await mapped(login({ access_token: "aa.%%%.cc" }))).toMatchObject({ code: "codex_access_token_not_jwt", detail: { segments: 3 } });
    expect(await mapped(login({ access_token: `x.${b64([1])}.y` }))).toMatchObject({ code: "codex_access_token_not_jwt", detail: { segments: 3 } });
  });

  test("a missing JWT claim is refused by its claim path", async () => {
    expect(await mapped(login({ access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT } }) })))
      .toMatchObject({ code: "codex_jwt_claim_missing", detail: { claim: "exp" } });
    expect(await mapped(login({ access_token: jwt({ exp: -1 }) }))).toMatchObject({ code: "codex_jwt_claim_missing", detail: { claim: "exp" } });
    expect(await mapped(login({ access_token: jwt({ exp: EXP }), account_id: undefined })))
      .toMatchObject({ code: "codex_jwt_claim_missing", detail: { claim: "https://api.openai.com/auth.chatgpt_account_id", fallback: "tokens.account_id" } });
  });

  test("the account id is masked to its last four characters", () => {
    expect(maskAccountId(ACCOUNT)).toBe("…1234");
    expect(maskAccountId("abc")).toBe("…");
  });
});

describe("importing stores the credential through the product's own credential store", () => {
  test("the stored row is what the sign-in flow writes, the provider reads connected, and the summary holds no token", async () => {
    const d = deps();
    const summary = await importCodexLogin(authFile(), d);
    expect(summary).toEqual({ provider: "openai", accountId: "…1234", expiresAt: new Date(EXP * 1_000).toISOString() });
    expect(JSON.stringify(summary)).not.toContain(REFRESH);
    expect(JSON.stringify(summary)).not.toContain(ACCESS);
    expect(d.calls).toEqual(["connect"]);
    const stored = JSON.parse(decrypt(String(await getSetting(oauthSettingKey("openai")))));
    expect(stored).toMatchObject({ access: ACCESS, refresh: REFRESH, expires: EXP * 1_000, accountId: ACCOUNT });
    // The connect poll's own test (/api/providers): a stored row that decrypts. The credential read: an OAuth login.
    expect(await getCredential("openai")).toMatchObject({ type: "oauth" });
  });

  test("a secret and salt holding $, a backtick, a backslash and both quotes store a login that decrypts unchanged", async () => {
    setEnv({ EZCORP_ENCRYPTION_SECRET: "fx-$HOME-`id`-\\-\"-'", EZCORP_ENCRYPTION_SALT: "fx-$(true)-\\-\"'" });
    expect(process.env.EZCORP_ENCRYPTION_SECRET).toBe("fx-$HOME-`id`-\\-\"-'");
    await importCodexLogin(authFile(), deps());
    expect(JSON.parse(decrypt(String(await getSetting(oauthSettingKey("openai")))))).toMatchObject({ refresh: REFRESH });
    expect(await importCodexLogin(authFile(), deps(), { dryRun: true })).toMatchObject({ secretCheck: "read" });
  });

  test("a missing file is refused by name and nothing is stored", async () => {
    expect(await refusal(importCodexLogin(join(dir, "absent.json"), deps()))).toMatchObject({ code: "codex_login_unreadable" });
    expect(await refusal(importCodexLogin(authFile("{not json"), deps()))).toMatchObject({ code: "codex_login_shape_unexpected" });
    expect(await getSetting(oauthSettingKey("openai"))).toBeFalsy();
  });

  test("a missing web encryption secret or salt is refused by its variable name before any connection", async () => {
    setEnv({ EZCORP_ENCRYPTION_SECRET: undefined });
    const d = deps();
    expect(await refusal(importCodexLogin(authFile(), d))).toMatchObject({ code: "web_secret_missing", detail: { env: ["EZCORP_ENCRYPTION_SECRET"] } });
    setEnv({ EZCORP_ENCRYPTION_SALT: undefined });
    expect(await refusal(importCodexLogin(authFile(), d))).toMatchObject({ code: "web_secret_missing", detail: { env: ["EZCORP_ENCRYPTION_SECRET", "EZCORP_ENCRYPTION_SALT"] } });
    expect(d.calls).toEqual([]);
    expect(await getSetting(oauthSettingKey("openai"))).toBeFalsy();
  });

  test("no DATABASE_URL is refused as unreachable by its variable name; it never falls back to an embedded database", async () => {
    setEnv({ DATABASE_URL: undefined });
    const d = deps();
    expect(await refusal(importCodexLogin(authFile(), d))).toMatchObject({ code: "database_unreachable", detail: { env: "DATABASE_URL" } });
    expect(d.calls).toEqual([]);
  });

  test("a failed connection names host:port, the database, and the deepest error's class and code, never the password", async () => {
    const refused = Object.assign(new Error(`connect to ${FIXTURE_ENV.DATABASE_URL} refused`), { name: "PostgresError", code: "ERR_POSTGRES_CONNECTION_REFUSED" });
    const wrapped = new Error("Failed query: CREATE EXTENSION IF NOT EXISTS vector", { cause: refused });
    const error = await refusal(importCodexLogin(authFile(), deps({ connect: async () => { throw wrapped; } })));
    expect(error).toMatchObject({ code: "database_unreachable", detail: { address: "127.0.0.1:5999", database: "fixture_product_db", errorClass: "PostgresError", errorCode: "ERR_POSTGRES_CONNECTION_REFUSED" } });
    setEnv({ DATABASE_URL: "postgres://fixture_host/fixture_db" });
    expect(await refusal(importCodexLogin(authFile(), deps({ connect: async () => { throw "down"; } }))))
      .toMatchObject({ code: "database_unreachable", detail: { address: "fixture_host:5432", database: "fixture_db", errorClass: "string" } });
    setEnv({ DATABASE_URL: "not a url" });
    expect(await refusal(importCodexLogin(authFile(), deps({ connect: async () => { throw new TypeError("x"); } }))))
      .toMatchObject({ code: "database_unreachable", detail: { address: "unparsable", errorClass: "TypeError" } });
  });

  test("a failed store write names the error's class and code and the import reports no success", async () => {
    const failing = { modify: async () => { throw Object.assign(new Error(`write ${REFRESH}`), { code: "ERR_POSTGRES_SERVER_ERROR" }); } } as unknown as CodexLoginImportDeps["store"];
    expect(await refusal(importCodexLogin(authFile(), deps({ store: failing }))))
      .toMatchObject({ code: "credential_store_write_failed", detail: { errorClass: "Error", errorCode: "ERR_POSTGRES_SERVER_ERROR" } });
  });

  test("a stored login the given secret cannot decrypt is refused as a secret mismatch and left untouched", async () => {
    await upsertSetting(oauthSettingKey("openai"), encrypt(JSON.stringify({ fixture: true })));
    const before = await getSetting(oauthSettingKey("openai"));
    setEnv({ EZCORP_ENCRYPTION_SECRET: "fixture-other-secret-0000" });
    expect(await refusal(importCodexLogin(authFile(), deps()))).toMatchObject({ code: "web_secret_mismatch", detail: { env: ["EZCORP_ENCRYPTION_SECRET", "EZCORP_ENCRYPTION_SALT"] } });
    expect(await getSetting(oauthSettingKey("openai"))).toBe(before);
  });
});

describe("a dry run checks every step and writes nothing", () => {
  test("no stored login: the secret is proved by a round trip, the summary says dryRun, nothing is stored", async () => {
    const d = deps();
    expect(await importCodexLogin(authFile(), d, { dryRun: true })).toEqual({ provider: "openai", accountId: "…1234", expiresAt: new Date(EXP * 1_000).toISOString(), dryRun: true, secretCheck: "round-trip" });
    expect(d.calls).toEqual(["connect"]);
    expect(await getSetting(oauthSettingKey("openai"))).toBeFalsy();
  });

  test("a stored login: the secret is proved by reading it, and the stored row is unchanged", async () => {
    await upsertSetting(oauthSettingKey("openai"), encrypt(JSON.stringify({ fixture: true })));
    const before = await getSetting(oauthSettingKey("openai"));
    expect(await importCodexLogin(authFile(), deps(), { dryRun: true })).toMatchObject({ dryRun: true, secretCheck: "read" });
    expect(await getSetting(oauthSettingKey("openai"))).toBe(before);
  });

  test("a dry run refuses the same causes as the import", async () => {
    setEnv({ EZCORP_ENCRYPTION_SALT: undefined });
    expect(await refusal(importCodexLogin(authFile(), deps(), { dryRun: true }))).toMatchObject({ code: "web_secret_missing" });
  });
});

describe("the command line prints one JSON line and an exit code", () => {
  function io() {
    const out: string[] = [], err: string[] = [];
    return { out, err, io: { out: (line: string) => { out.push(line); }, err: (line: string) => { err.push(line); } } };
  }

  test("no --from prints the usage and exits 64 without connecting", async () => {
    const d = deps(), o = io();
    expect(await runCodexLoginImportCli(["--dry-run"], d, o.io)).toBe(64);
    expect(o.err[0]).toContain("usage:");
    expect(d.calls).toEqual([]);
  });

  test("--dry-run prints the summary with dryRun:true, exits 0, and closes the database", async () => {
    const d = deps(), o = io();
    expect(await runCodexLoginImportCli(["--dry-run", "--from", authFile()], d, o.io)).toBe(0);
    expect(JSON.parse(o.out[0]!)).toMatchObject({ provider: "openai", dryRun: true });
    expect(d.calls).toEqual(["connect", "close"]);
    expect(await getSetting(oauthSettingKey("openai"))).toBeFalsy();
  });

  test("an import prints the summary without dryRun and stores the login", async () => {
    const o = io();
    expect(await runCodexLoginImportCli(["--from", authFile()], deps(), o.io)).toBe(0);
    expect(JSON.parse(o.out[0]!).dryRun).toBeUndefined();
    expect(await getSetting(oauthSettingKey("openai"))).toBeTruthy();
  });

  test("a refusal prints its code and detail on stderr and exits 2; the database is still closed", async () => {
    const d = deps({ connect: async () => { throw Object.assign(new Error("x"), { code: "ECONNREFUSED" }); } }), o = io();
    expect(await runCodexLoginImportCli(["--from", authFile()], d, o.io)).toBe(2);
    expect(JSON.parse(o.err[0]!)).toEqual({ error: "database_unreachable", address: "127.0.0.1:5999", database: "fixture_product_db", errorClass: "Error", errorCode: "ECONNREFUSED" });
    expect(o.out).toEqual([]);
    expect(d.calls).toEqual(["close"]);
  });

  test("a failed close does not change the answer", async () => {
    const o = io();
    const d = deps({ close: async () => { throw new Error("pool close timed out"); } });
    expect(await runCodexLoginImportCli(["--dry-run", "--from", authFile()], d, o.io)).toBe(0);
    expect(o.err).toEqual([]);
  });

  test("an error outside every named step prints its class and code only and exits 2", async () => {
    const o = io();
    const broken = { out: () => { throw Object.assign(new Error(`stdout closed ${REFRESH}`), { code: "EPIPE" }); }, err: o.io.err };
    expect(await runCodexLoginImportCli(["--from", authFile(), "--dry-run"], deps(), broken)).toBe(2);
    expect(JSON.parse(o.err[0]!)).toEqual({ error: "codex_login_import_failed", errorClass: "Error", errorCode: "EPIPE" });
    expect(o.err.join("")).not.toContain(REFRESH);
  });

  test("the script runs the command line with its own arguments", async () => {
    const previous = process.exitCode;
    await import("../../scripts/import-codex-login.ts");
    // The test runner's own argv has no --from: the usage exit.
    expect(process.exitCode).toBe(64);
    process.exitCode = previous ?? 0;
  });
});
