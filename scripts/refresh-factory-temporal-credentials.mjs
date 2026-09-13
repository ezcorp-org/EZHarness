import { createSign } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SQL } from "bun";

const controlDatabaseUrl = process.env.EZCORP_FACTORY_CONTROL_DATABASE_URL;
const authDirectory = process.env.EZCORP_FACTORY_TEMPORAL_AUTH_DIR;
const secretsRoot = process.env.EZCORP_FACTORY_SECRETS_ROOT;
const intervalSeconds = Number(process.env.EZCORP_FACTORY_TEMPORAL_REFRESH_SECONDS ?? "120");
if (!controlDatabaseUrl || !authDirectory || !secretsRoot) throw new Error("Control database and private credential references are required.");
if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 30 || intervalSeconds > 240) throw new Error("Temporal credential refresh interval must be 30 to 240 seconds.");
const privateRoot = resolve(secretsRoot);
const key = await readFile(join(authDirectory, "jwt.key"));
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(subject, namespace) { const input = `${encode({ alg: "RS256", kid: "factory-local", typ: "JWT" })}.${encode({ sub: subject, iss: "ezcorp-factory-local", aud: "ezcorp-temporal", permissions: [`admin:${namespace}`], exp: Math.floor(Date.now() / 1000) + 300 })}`; const signer = createSign("RSA-SHA256"); signer.update(input); signer.end(); return `${input}.${signer.sign(key).toString("base64url")}`; }
function expiresSoon(value) { try { const payload = JSON.parse(Buffer.from(value.split(".")[1] ?? "", "base64url").toString("utf8")); return !Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000) + intervalSeconds * 2; } catch { return true; } }
async function privateDirectory(path) { const resolved = resolve(path); if (resolved !== privateRoot && !resolved.startsWith(`${privateRoot}/`)) throw new Error("Credential directory escaped the configured private root."); const status = await lstat(resolved); if (!status.isDirectory() || status.isSymbolicLink() || status.uid !== process.getuid?.() || (status.mode & 0o077) !== 0) throw new Error("Credential directory is not a private owned directory."); return resolved; }
async function replacePrivateToken(directory, value) { const target = join(directory, "temporal-token"), temporary = join(directory, `.temporal-token-${process.pid}`); const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await handle.writeFile(`${value}\n`); } finally { await handle.close(); } await rename(temporary, target); const status = await lstat(target); if (!status.isFile() || status.isSymbolicLink() || status.uid !== process.getuid?.() || (status.mode & 0o077) !== 0) throw new Error("Refreshed Temporal token is unsafe."); }
async function refresh() { const control = new SQL(controlDatabaseUrl, { max: 1 }); try { const rows = await control`SELECT tenant_id, temporal_namespace, secret_bundle_path FROM factory_installations WHERE state = 'ready' ORDER BY tenant_id`; for (const row of rows) { const directory = await privateDirectory(row.secret_bundle_path); let prior = ""; try { prior = await readFile(join(directory, "temporal-token"), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; } if (expiresSoon(prior.trim())) await replacePrivateToken(directory, token(row.tenant_id, row.temporal_namespace)); } } finally { await control.close(); } }
await refresh();
if (process.argv.includes("--watch")) setInterval(() => { void refresh().catch(() => process.exitCode = 1); }, intervalSeconds * 1000);
