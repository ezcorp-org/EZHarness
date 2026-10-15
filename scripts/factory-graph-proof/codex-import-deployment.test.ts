import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deploymentImportEnvironment, parseEnvFile, runCodexImportScript } from "./codex-import-deployment";
import { DEPLOYMENT_FILE, MASTER_KEY_FILE, WEB_SECRETS_FILE, WRAPS_FILE, type DeploymentPlaces } from "./deployment";

const uid = process.getuid!();
// A deployment folder is only allowed under the tmpfs runtime folder, so the fixtures live there.
const scratch = mkdtempSync(join(`/run/user/${uid}`, "w4h28-codex-import-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const places: DeploymentPlaces = { uid, home: "/home/someone", repo: "/home/someone/repo", evidence: "/tmp/factory-platform-evidence" };

/** Fixture secrets that a shell or an eval would mangle: $, a backtick, a backslash, both quotes. */
const ENCRYPTION = "fx-enc-$HOME-`id`-\\n-\"-'-end";
const SALT = "fx-salt-$(true)-\\-\"'";
const PG_PASSWORD = "fx-pg-p@ss:/?#$`\\\"'";
const PRODUCT = "w19a_product_fixture_0001";

let serial = 0;
function fixture(): { dir: string; envFile: string } {
  const dir = join(scratch, `deployment-${++serial}`);
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, DEPLOYMENT_FILE), JSON.stringify({ productDatabase: PRODUCT, createdAt: "2026-10-15T00:00:00Z" }), { mode: 0o600 });
  writeFileSync(join(dir, WEB_SECRETS_FILE), JSON.stringify({ jwt: "fx-jwt", encryption: ENCRYPTION, salt: SALT }), { mode: 0o600 });
  writeFileSync(join(dir, MASTER_KEY_FILE), "fixture-master-key-0000000000000", { mode: 0o600 });
  writeFileSync(join(dir, WRAPS_FILE), "{}", { mode: 0o600 });
  const envFile = join(dir, "postgres.env");
  writeFileSync(envFile, `POSTGRES_USER=fx_admin\nPOSTGRES_PASSWORD=${PG_PASSWORD}\nPOSTGRES_DB=fx_admin_db\n`, { mode: 0o600 });
  return { dir, envFile };
}
const argv = (f: { dir: string; envFile: string }, ...rest: string[]) => ["--deployment", f.dir, "--postgres-env", f.envFile, "--postgres-port", "45999", ...rest];

const NAMES = ["DATABASE_URL", "EZCORP_ENCRYPTION_SECRET", "EZCORP_ENCRYPTION_SALT", "EZCORP_SECRETS_DIR", "EZCORP_DB_PATH"] as const;
const saved = Object.fromEntries(NAMES.map(name => [name, process.env[name]]));
afterEach(() => { for (const name of NAMES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });

function capture() {
  const err: string[] = [];
  return { err, io: { err: (line: string) => { err.push(line); } } };
}

describe("the env file is read verbatim, never through a shell", () => {
  test("KEY=VALUE lines; a value keeps every character after the first =; comments and blanks are skipped", () => {
    expect(parseEnvFile(`# c\n\nA=1\nB=x=y $z \`q\` \\ "'\nnot a pair\n`)).toEqual({ A: "1", B: "x=y $z `q` \\ \"'" });
  });
});

describe("--deployment makes the import's environment from files, in this process only", () => {
  test("no --deployment: no environment", async () => {
    expect(await deploymentImportEnvironment(["--from", "x"], places)).toBeUndefined();
  });

  test("the secret, the salt and the database password round-trip unchanged, whatever characters they hold", async () => {
    const f = fixture();
    const env = (await deploymentImportEnvironment(argv(f), places))!;
    expect(env.EZCORP_ENCRYPTION_SECRET).toBe(ENCRYPTION);
    expect(env.EZCORP_ENCRYPTION_SALT).toBe(SALT);
    const url = new URL(env.DATABASE_URL!);
    expect([url.hostname, url.port, url.pathname]).toEqual(["127.0.0.1", "45999", `/${PRODUCT}`]);
    expect(decodeURIComponent(url.username)).toBe("fx_admin");
    expect(decodeURIComponent(url.password)).toBe(PG_PASSWORD);
  });

  test("a missing option, a bad port, a folder outside /run/user, or an unreadable file is refused by name", async () => {
    const f = fixture(), o = capture();
    const run = (args: string[]) => runCodexImportScript(args, places, o.io, async () => { throw new Error("must not load"); });
    expect(await run(["--deployment", f.dir, "--from", "x"])).toBe(2);
    expect(await run(argv(f).map(a => a === "45999" ? "port" : a))).toBe(2);
    expect(await run(argv({ dir: "/tmp/w4h28-not-allowed", envFile: f.envFile }))).toBe(2);
    expect(await run(argv({ dir: f.dir, envFile: join(f.dir, "absent.env") }))).toBe(2);
    rmSync(join(f.dir, WEB_SECRETS_FILE));
    expect(await run(argv(f))).toBe(2);
    expect(o.err.map(line => JSON.parse(line))).toEqual([
      { error: "deployment_incomplete" },
      { error: "deployment_incomplete" },
      { error: "deployment_dir_not_allowed" },
      { error: "deployment_unreadable", errorClass: "Error", errorCode: "ENOENT" },
      { error: "deployment_unreadable", errorClass: "Error", errorCode: "ENOENT" },
    ]);
    for (const line of o.err) for (const secret of [ENCRYPTION, SALT, PG_PASSWORD]) expect(line).not.toContain(secret);
    expect(process.env.EZCORP_ENCRYPTION_SECRET).toBe(saved.EZCORP_ENCRYPTION_SECRET);
  });

  test("the environment is set before the import loads, and a local secrets folder or database path cannot win", async () => {
    const f = fixture();
    process.env.EZCORP_SECRETS_DIR = "/tmp/fx-secrets"; process.env.EZCORP_DB_PATH = "/tmp/fx-db";
    let seen: Record<string, string | undefined> = {}, args: readonly string[] = [];
    const code = await runCodexImportScript(argv(f, "--dry-run", "--from", "auth.json"), places, capture().io, async () => ({
      runCodexLoginImportCli: async (given: readonly string[]) => { seen = { ...process.env }; args = given; return 7; },
    }));
    expect(code).toBe(7);
    expect(seen.EZCORP_ENCRYPTION_SECRET).toBe(ENCRYPTION);
    expect(seen.EZCORP_SECRETS_DIR).toBeUndefined();
    expect(seen.EZCORP_DB_PATH).toBeUndefined();
    expect(args).toContain("--dry-run");
  });

  test("without --deployment the import runs on the environment it was given", async () => {
    const code = await runCodexImportScript(["--from", "auth.json"], places, capture().io, async () => ({ runCodexLoginImportCli: async () => 0 }));
    expect(code).toBe(0);
    expect(process.env.EZCORP_ENCRYPTION_SECRET).toBe(saved.EZCORP_ENCRYPTION_SECRET);
  });
});

describe("a fixture run keeps every secret out of the process's argv and start environment", () => {
  test("while the import waits on its database, /proc/<pid>/cmdline and /proc/<pid>/environ hold no secret", async () => {
    const f = fixture();
    // A database port that accepts and never answers: the import stays connected and waiting while /proc is read.
    const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const repo = resolve(import.meta.dir, "../..");
    const auth = join(f.dir, "auth.json");
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const access = `${b64({ alg: "none" })}.${b64({ exp: 1_893_456_000, "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account-0001" } })}.fixture-signature`;
    writeFileSync(auth, JSON.stringify({ tokens: { access_token: access, refresh_token: "fixture-refresh-not-real" } }), { mode: 0o600 });
    const args = ["--dry-run", "--deployment", f.dir, "--postgres-env", f.envFile, "--postgres-port", String(silent.port), "--from", auth];
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/", LOG_LEVEL: "warn", BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING: "1" };
    const child = Bun.spawn([process.execPath, join(repo, "scripts/import-codex-login.ts"), ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
    try {
      await Bun.sleep(1_500);
      expect(child.exitCode).toBeNull();
      const cmdline = readFileSync(`/proc/${child.pid}/cmdline`, "utf8");
      const environ = readFileSync(`/proc/${child.pid}/environ`, "utf8");
      for (const secret of [ENCRYPTION, SALT, PG_PASSWORD, encodeURIComponent(PG_PASSWORD)]) {
        expect(cmdline).not.toContain(secret);
        expect(environ).not.toContain(secret);
      }
      expect(environ).not.toContain("DATABASE_URL");
      expect(environ).not.toContain("EZCORP_ENCRYPTION");
    } finally {
      child.kill();
      await child.exited;
      silent.stop(true);
    }
  }, 30_000);
});
