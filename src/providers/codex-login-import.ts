/**
 * Reuse a Codex CLI login as this installation's ChatGPT-plan credential (W4H-28).
 *
 * The Codex CLI and this application's OpenAI subscription login are the same OAuth client, so the CLI's
 * tokens are a valid `openai-codex` credential here: pi-ai sends the access token and refreshes it with the
 * refresh token when it nears expiry. This maps the CLI's `auth.json` to the credential the browser sign-in
 * writes, and stores it through the product's own credential store, the same serialized write a refresh makes.
 *
 * Nothing here returns, logs or throws a token. A refusal names its reason by code; the summary carries the
 * provider, the last four characters of the account id, and the expiry.
 *
 * One login, two holders: OpenAI rotates the refresh token on each refresh, so after either holder refreshes,
 * the other's refresh token stops working and that holder must sign in again.
 */
import { readFile } from "node:fs/promises";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { getCredentialStore, tagOAuthCredential } from "./credential-store";

/** The claim the access token carries the ChatGPT account under (the same path pi-ai reads). */
const ACCOUNT_CLAIM = "https://api.openai.com/auth";

export type CodexLoginImportCode =
  | "codex_login_unreadable"
  | "codex_login_not_json_object"
  | "codex_login_tokens_missing"
  | "codex_login_access_unreadable"
  | "codex_login_account_missing";

export class CodexLoginImportError extends Error {
  constructor(readonly code: CodexLoginImportCode) {
    super(code);
    this.name = "CodexLoginImportError";
  }
}

export interface CodexLoginCredential extends OAuthCredentials {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly accountId: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The access token's payload, or undefined when it is not a readable JWT. */
function jwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (part === undefined) return undefined;
  try { return record(JSON.parse(Buffer.from(part, "base64url").toString("utf8"))); } catch { return undefined; }
}

/** Maps a Codex CLI `auth.json` value to the credential the sign-in flow stores. Pure; never quotes a token. */
export function codexLoginCredential(value: unknown): CodexLoginCredential {
  const file = record(value);
  if (!file) throw new CodexLoginImportError("codex_login_not_json_object");
  const tokens = record(file.tokens);
  const access = tokens?.access_token, refresh = tokens?.refresh_token;
  if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh) throw new CodexLoginImportError("codex_login_tokens_missing");
  const payload = jwtPayload(access);
  const exp = payload?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) throw new CodexLoginImportError("codex_login_access_unreadable");
  const claimed = record(payload?.[ACCOUNT_CLAIM])?.chatgpt_account_id;
  const accountId = typeof claimed === "string" && claimed ? claimed : typeof tokens?.account_id === "string" && tokens.account_id ? tokens.account_id : undefined;
  if (accountId === undefined) throw new CodexLoginImportError("codex_login_account_missing");
  return { access, refresh, expires: exp * 1_000, accountId };
}

/** The last four characters of an account id, for a summary. */
export function maskAccountId(accountId: string): string {
  return `…${accountId.length > 4 ? accountId.slice(-4) : ""}`;
}

/** Reads a Codex CLI login file, stores it as the `openai` OAuth credential, and returns a summary with no token. */
export async function importCodexLogin(path: string): Promise<{ readonly provider: "openai"; readonly accountId: string; readonly expiresAt: string }> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch { throw new CodexLoginImportError("codex_login_unreadable"); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new CodexLoginImportError("codex_login_not_json_object"); }
  const credential = codexLoginCredential(parsed);
  await getCredentialStore().modify("openai-codex", async () => tagOAuthCredential(credential));
  return { provider: "openai", accountId: maskAccountId(credential.accountId), expiresAt: new Date(credential.expires).toISOString() };
}
