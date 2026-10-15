/**
 * Reuse a Codex CLI login as this installation's ChatGPT-plan credential (W4H-28).
 *
 * The Codex CLI and this application's OpenAI subscription login are the same OAuth client, so the CLI's
 * tokens are a valid `openai-codex` credential here: pi-ai sends the access token and refreshes it with the
 * refresh token when it nears expiry. This maps the CLI's `auth.json` to the credential the browser sign-in
 * writes, and stores it through the product's own credential store, the same serialized write a refresh makes.
 *
 * Every step refuses by its own code with a detail that names WHERE it failed (a key name, a claim path, a
 * variable name, host:port, an error class and code) and never WHAT a value is: nothing here returns, logs or
 * throws a token, a password or an error message. A dry run runs every step except the write.
 *
 * One login, two holders: OpenAI rotates the refresh token on each refresh, so after either holder refreshes,
 * the other's refresh token stops working and that holder must sign in again.
 */
import { readFile } from "node:fs/promises";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { closeDb, initDb } from "../db/connection";
import { getSetting } from "../db/queries/settings";
import { getCredentialStore, oauthSettingKey, tagOAuthCredential, type SettingsCredentialStore } from "./credential-store";
import { decrypt, encrypt } from "./encryption";

/** The claim the access token carries the ChatGPT account under (the same path pi-ai reads). */
const ACCOUNT_CLAIM = "https://api.openai.com/auth";
/** The variables the web server derives its encryption key from; without them the store would make a new key. */
const SECRET_ENV = ["EZCORP_ENCRYPTION_SECRET", "EZCORP_ENCRYPTION_SALT"] as const;

export type CodexLoginImportCode =
  | "codex_login_unreadable"
  | "codex_login_shape_unexpected"
  | "codex_access_token_not_jwt"
  | "codex_jwt_claim_missing"
  | "web_secret_missing"
  | "web_secret_mismatch"
  | "database_unreachable"
  | "credential_store_write_failed";

/** Where a step failed: names, counts, addresses and error classes only, never a value. */
export type CodexLoginImportDetail = Readonly<Record<string, string | number | readonly string[]>>;

export class CodexLoginImportError extends Error {
  constructor(readonly code: CodexLoginImportCode, readonly detail: CodexLoginImportDetail = {}) {
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

export interface CodexLoginImportSummary {
  readonly provider: "openai";
  readonly accountId: string;
  readonly expiresAt: string;
  readonly dryRun?: true;
  /** How a dry run proved the encryption secret: it decrypted the stored login, or it made a round trip. */
  readonly secretCheck?: "read" | "round-trip";
}

export interface CodexLoginImportDeps {
  readonly connect: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly store: Pick<SettingsCredentialStore, "modify">;
}

const defaultDeps = (): CodexLoginImportDeps => ({ connect: initDb, close: closeDb, store: getCredentialStore() });

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The error's own class and code, from the deepest cause that has them; never its message. */
function errorShape(error: unknown): { errorClass: string; errorCode?: string } {
  let deepest = error, errorCode: string | undefined;
  for (let at: unknown = error; at instanceof Error; at = at.cause) {
    deepest = at;
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string") errorCode = code;
  }
  const errorClass = deepest instanceof Error ? deepest.name : typeof deepest;
  return errorCode === undefined ? { errorClass } : { errorClass, errorCode };
}

/** Host:port and database name of a connection URL; the user and password are never read out. */
function databaseAddress(url: string): { address: string; database?: string } {
  try {
    const parsed = new URL(url);
    return { address: `${parsed.hostname}:${parsed.port || "5432"}`, database: decodeURIComponent(parsed.pathname.slice(1)) };
  } catch {
    return { address: "unparsable" };
  }
}

/** Maps a Codex CLI `auth.json` value to the credential the sign-in flow stores. Pure; never quotes a token. */
export function codexLoginCredential(value: unknown): CodexLoginCredential {
  const file = record(value);
  const tokens = record(file?.tokens);
  const access = tokens?.access_token, refresh = tokens?.refresh_token;
  if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh) {
    throw new CodexLoginImportError("codex_login_shape_unexpected", { keys: Object.keys(file ?? {}).sort(), tokenKeys: Object.keys(tokens ?? {}).sort() });
  }
  const segments = access.split(".");
  let payload: Record<string, unknown> | undefined;
  try { payload = record(JSON.parse(Buffer.from(segments[1] ?? "", "base64url").toString("utf8"))); } catch { payload = undefined; }
  if (segments.length !== 3 || !payload) throw new CodexLoginImportError("codex_access_token_not_jwt", { segments: segments.length });
  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) throw new CodexLoginImportError("codex_jwt_claim_missing", { claim: "exp" });
  const claimed = record(payload[ACCOUNT_CLAIM])?.chatgpt_account_id;
  const accountId = typeof claimed === "string" && claimed ? claimed : typeof tokens?.account_id === "string" && tokens.account_id ? tokens.account_id : undefined;
  if (accountId === undefined) throw new CodexLoginImportError("codex_jwt_claim_missing", { claim: `${ACCOUNT_CLAIM}.chatgpt_account_id`, fallback: "tokens.account_id" });
  return { access, refresh, expires: exp * 1_000, accountId };
}

/** The last four characters of an account id, for a summary. */
export function maskAccountId(accountId: string): string {
  return `…${accountId.length > 4 ? accountId.slice(-4) : ""}`;
}

async function readLogin(path: string): Promise<CodexLoginCredential> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch { throw new CodexLoginImportError("codex_login_unreadable"); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  return codexLoginCredential(parsed);
}

/** Connects to the installation the environment names; it never falls back to an embedded database. */
async function connect(deps: CodexLoginImportDeps): Promise<void> {
  const missing = SECRET_ENV.filter(name => !process.env[name]);
  if (missing.length > 0) throw new CodexLoginImportError("web_secret_missing", { env: missing });
  const url = process.env.DATABASE_URL;
  if (!url) throw new CodexLoginImportError("database_unreachable", { env: "DATABASE_URL" });
  try { await deps.connect(); } catch (error) { throw new CodexLoginImportError("database_unreachable", { ...databaseAddress(url), ...errorShape(error) }); }
}

/** Proves the secret: it must decrypt a stored login (a read), else encrypt and decrypt a probe (a round trip). */
async function checkSecret(): Promise<"read" | "round-trip"> {
  const stored = await getSetting(oauthSettingKey("openai"));
  if (typeof stored === "string" && stored.length > 0) {
    try { decrypt(stored); } catch { throw new CodexLoginImportError("web_secret_mismatch", { env: [...SECRET_ENV] }); }
    return "read";
  }
  const probe = "codex-login-import-secret-probe";
  if (decrypt(encrypt(probe)) !== probe) throw new CodexLoginImportError("web_secret_mismatch", { env: [...SECRET_ENV] });
  return "round-trip";
}

/**
 * Reads a Codex CLI login file and stores it as the `openai` OAuth credential; with `dryRun`, every step but the
 * write. Returns a summary with no token. The caller owns `deps.close()`.
 */
export async function importCodexLogin(
  path: string,
  deps: CodexLoginImportDeps = defaultDeps(),
  options: { readonly dryRun?: boolean } = {},
): Promise<CodexLoginImportSummary> {
  const credential = await readLogin(path);
  await connect(deps);
  const secretCheck = await checkSecret();
  const summary = { provider: "openai", accountId: maskAccountId(credential.accountId), expiresAt: new Date(credential.expires).toISOString() } as const;
  if (options.dryRun) return { ...summary, dryRun: true, secretCheck };
  try {
    await deps.store.modify("openai-codex", async () => tagOAuthCredential(credential));
  } catch (error) {
    throw new CodexLoginImportError("credential_store_write_failed", errorShape(error));
  }
  return summary;
}

const USAGE = "usage: bun scripts/import-codex-login.ts [--dry-run] --from <path to auth.json>";

/** The command line: one JSON line (the summary on stdout, or the refusal on stderr) and an exit code. */
export async function runCodexLoginImportCli(
  argv: readonly string[],
  deps: CodexLoginImportDeps = defaultDeps(),
  io: { readonly out: (line: string) => void; readonly err: (line: string) => void } = { out: console.log.bind(console), err: console.error.bind(console) },
): Promise<number> {
  const at = argv.indexOf("--from");
  const from = at >= 0 ? argv[at + 1] : undefined;
  if (!from) {
    io.err(USAGE);
    return 64;
  }
  try {
    io.out(JSON.stringify(await importCodexLogin(from, deps, { dryRun: argv.includes("--dry-run") })));
    return 0;
  } catch (error) {
    io.err(JSON.stringify(error instanceof CodexLoginImportError ? { error: error.code, ...error.detail } : { error: "codex_login_import_failed", ...errorShape(error) }));
    return 2;
  } finally {
    await deps.close().catch(() => undefined);
  }
}
