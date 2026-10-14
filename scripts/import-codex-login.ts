/**
 * Store a Codex CLI login as this installation's ChatGPT-plan (openai) credential.
 *
 *   BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1 bun scripts/import-codex-login.ts --from <path to the Codex CLI auth.json>
 *
 * Runs against the installation named by the environment the web server uses (DATABASE_URL,
 * EZCORP_ENCRYPTION_SECRET, EZCORP_ENCRYPTION_SALT). It reads the file itself and prints only the provider,
 * the last four characters of the account id, and the expiry; a refusal prints its code. See
 * src/providers/codex-login-import.ts for the mapping and the one-login-two-holders caveat.
 */
import { closeDb, initDb } from "../src/db/connection";
import { CodexLoginImportError, importCodexLogin } from "../src/providers/codex-login-import";

const at = process.argv.indexOf("--from");
const from = at > 0 ? process.argv[at + 1] : undefined;
if (!from) {
  console.error("usage: bun scripts/import-codex-login.ts --from <path to auth.json>");
  process.exit(64);
}
let code = 0;
try {
  await initDb();
  console.log(JSON.stringify(await importCodexLogin(from)));
} catch (error) {
  code = 2;
  // A refusal by its code; anything else by its class only (a database or decrypt message is not printed).
  console.error(JSON.stringify(error instanceof CodexLoginImportError ? { error: error.code } : { error: "codex_login_import_failed", errorClass: error instanceof Error ? error.name : typeof error }));
} finally {
  await closeDb().catch(() => undefined);
}
process.exit(code);
