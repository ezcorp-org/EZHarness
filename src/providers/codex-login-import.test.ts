import { mockDbConnection, closeTestDb, setupTestDb } from "../__tests__/helpers/test-pglite";
mockDbConnection();
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSetting, getSetting } from "../db/queries/settings";
import { oauthSettingKey } from "./credential-store";
import { decrypt } from "./encryption";
import { getCredential } from "./credentials";
import { codexLoginCredential, CodexLoginImportError, importCodexLogin, maskAccountId } from "./codex-login-import";

const ACCOUNT = "fixture-account-0000-1234";
const EXP = Math.floor(Date.parse("2030-01-01T00:00:00.000Z") / 1_000);
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: "none" })}.${b64(payload)}.fixture-signature`;
const ACCESS = jwt({ exp: EXP, "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT } });
const REFRESH = "fixture-refresh-token-not-real";
/** The shape the Codex CLI writes to ~/.codex/auth.json, holding only fixture values. */
const login = (tokens: Record<string, unknown> = {}) => ({ OPENAI_API_KEY: null, tokens: { id_token: "fixture-id-token", access_token: ACCESS, refresh_token: REFRESH, account_id: ACCOUNT, ...tokens }, last_refresh: "2029-12-31T00:00:00Z" });

const dir = mkdtempSync(join(tmpdir(), "codex-login-import-"));
const previousSecretsDir = process.env.EZCORP_SECRETS_DIR;
beforeAll(async () => { process.env.EZCORP_SECRETS_DIR = dir; await setupTestDb(); });
afterAll(async () => {
  await closeTestDb();
  if (previousSecretsDir === undefined) delete process.env.EZCORP_SECRETS_DIR; else process.env.EZCORP_SECRETS_DIR = previousSecretsDir;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => { await deleteSetting(oauthSettingKey("openai")); });

describe("a Codex CLI login maps to the application's ChatGPT-plan credential", () => {
  test("access, refresh and the account id map; the expiry is the access token's own exp", () => {
    expect(codexLoginCredential(login())).toEqual({ access: ACCESS, refresh: REFRESH, expires: EXP * 1_000, accountId: ACCOUNT });
  });

  test("the account id comes from the token's claim when the file does not carry it", () => {
    expect(codexLoginCredential(login({ account_id: undefined })).accountId).toBe(ACCOUNT);
  });

  test("a file that is not a Codex login is refused by name, and no refusal quotes a token", () => {
    const cases: Array<[unknown, string]> = [
      [null, "codex_login_not_json_object"],
      [{ tokens: {} }, "codex_login_tokens_missing"],
      [login({ refresh_token: "" }), "codex_login_tokens_missing"],
      [login({ access_token: "not-a-jwt" }), "codex_login_access_unreadable"],
      [login({ access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT } }) }), "codex_login_access_unreadable"],
      [login({ access_token: jwt({ exp: EXP }), account_id: undefined }), "codex_login_account_missing"],
    ];
    for (const [value, code] of cases) {
      let caught: unknown;
      try { codexLoginCredential(value); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(CodexLoginImportError);
      expect((caught as CodexLoginImportError).code).toBe(code);
      expect(String((caught as Error).message)).not.toContain(REFRESH);
      expect(String((caught as Error).message)).not.toContain(ACCESS);
    }
  });

  test("the account id is masked to its last four characters", () => {
    expect(maskAccountId(ACCOUNT)).toBe("…1234");
    expect(maskAccountId("abc")).toBe("…");
  });
});

describe("importing stores the credential through the product's own credential store", () => {
  test("the stored row is what the sign-in flow writes, the provider reads connected, and the summary holds no token", async () => {
    const from = join(dir, "auth.json");
    writeFileSync(from, JSON.stringify(login()), { mode: 0o600 });
    const summary = await importCodexLogin(from);
    expect(summary).toEqual({ provider: "openai", accountId: "…1234", expiresAt: new Date(EXP * 1_000).toISOString() });
    expect(JSON.stringify(summary)).not.toContain(REFRESH);
    expect(JSON.stringify(summary)).not.toContain(ACCESS);
    const stored = JSON.parse(decrypt(String(await getSetting(oauthSettingKey("openai")))));
    expect(stored).toMatchObject({ access: ACCESS, refresh: REFRESH, expires: EXP * 1_000, accountId: ACCOUNT });
    // The connect poll's own test (/api/providers): a stored row that decrypts. The credential read: an OAuth login.
    expect(await getCredential("openai")).toMatchObject({ type: "oauth" });
  });

  test("a missing file is refused by name and nothing is stored", async () => {
    await expect(importCodexLogin(join(dir, "absent.json"))).rejects.toMatchObject({ code: "codex_login_unreadable" });
    expect(await getSetting(oauthSettingKey("openai"))).toBeFalsy();
  });
});
