/**
 * Store a Codex CLI login as this installation's ChatGPT-plan (openai) credential.
 *
 *   BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1 bun scripts/import-codex-login.ts [--dry-run] --from <path to auth.json>
 *
 * Runs against the installation named by the environment the web server uses (DATABASE_URL,
 * EZCORP_ENCRYPTION_SECRET, EZCORP_ENCRYPTION_SALT). It reads the file itself and prints only the provider,
 * the last four characters of the account id, and the expiry; a refusal prints its code and where it failed.
 * --dry-run runs every step (read, map, connect, prove the secret) except the write. See
 * src/providers/codex-login-import.ts for the mapping, the refusal codes and the one-login-two-holders caveat.
 */
import { runCodexLoginImportCli } from "../src/providers/codex-login-import";

process.exitCode = await runCodexLoginImportCli(process.argv.slice(2));
