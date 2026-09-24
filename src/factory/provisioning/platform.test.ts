import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPrivateKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { factoryRejection, makeFactoryPrivateRoot, removeFactoryPrivateRoot, writeModeFile } from "../../__tests__/helpers/factory-private-root";
import { factorySpawnRunner, type FactoryCommandRunner } from "./certificates";
import type { FactoryCommandExecutor, FactoryCommandResult } from "./compose-profile";
import {
  ensureFactoryPlatformMaterial,
  factoryIngressMainConfig,
  factoryPlatformEnvironment,
  factoryPlatformPaths,
  factoryPlatformProject,
  factoryPodmanIngressReloader,
  startFactoryPlatform,
  waitForFactoryPlatform,
  type FactoryPlatformSettings,
} from "./platform";
import { FactoryProvisioningError } from "./steps";
import { factoryTemporalJwks } from "./temporal";

let root: string;
let operatorRoot: string;

beforeEach(async () => {
  root = await makeFactoryPrivateRoot();
  operatorRoot = join(root, "operator");
});
afterEach(async () => { await removeFactoryPrivateRoot(root); });

const text = (path: string) => readFile(path, "utf8");
const mode = async (path: string) => (await stat(path)).mode & 0o777;

/** Every file under a directory, by relative path, with its mode and content. */
async function tree(directory: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const key = path.slice(directory.length + 1);
    entries[key] = entry.isDirectory() ? `dir ${(await mode(path)).toString(8)}` : `${(await mode(path)).toString(8)} ${await text(path)}`;
  }
  return entries;
}

function recordingRunner(calls: string[]): FactoryCommandRunner {
  return async (command, args) => { calls.push(`${command} ${args[0]}`); await factorySpawnRunner(command, args); };
}

describe("factoryPlatformPaths and naming", () => {
  test("every path sits under the operator root's platform directory", () => {
    const paths = factoryPlatformPaths("/srv/op");
    expect(paths).toEqual({
      root: "/srv/op/platform",
      temporal: {
        caCertificatePath: "/srv/op/platform/temporal/ca.crt", caKeyPath: "/srv/op/platform/temporal/ca.key",
        tokenKeyPath: "/srv/op/platform/temporal/token.key", tokenKeyId: "factory-local",
        revocationsDirectory: "/srv/op/platform/temporal/revocations", revocationsPath: "/srv/op/platform/temporal/revocations/revocations.json",
        certificatePath: "/srv/op/platform/temporal/control.crt", privateKeyPath: "/srv/op/platform/temporal/control.key",
        serverDirectory: "/srv/op/platform/temporal/server", databaseEnvPath: "/srv/op/platform/temporal/database.env",
        httpTokensDirectory: "/srv/op/platform/temporal/http-tokens",
      },
      ingress: { root: "/srv/op/platform/ingress", caCertificatePath: "/srv/op/platform/ingress-ca/ca.crt", caKeyPath: "/srv/op/platform/ingress-ca/ca.key" },
    });
    expect(Object.isFrozen(paths) && Object.isFrozen(paths.temporal) && Object.isFrozen(paths.ingress)).toBe(true);
    expect(factoryPlatformPaths("relative/op").root).toBe(join(process.cwd(), "relative/op/platform"));
  });

  test("the project name is scoped by fleet", () => {
    expect(factoryPlatformProject("fleet-a")).toBe("ezcorp-factory-fleet-a-platform");
  });

  test("the nginx main config includes only the rendered routes and is unprivileged", () => {
    const config = factoryIngressMainConfig();
    expect(config.endsWith("}\n")).toBe(true);
    expect(config).toContain("pid /tmp/nginx.pid;");
    expect(config).toContain("include /etc/ezcorp-ingress/conf/*.conf;");
    expect(config).toContain("server_tokens off;");
    expect(config.match(/include /g)).toHaveLength(1);
  });
});

describe("ensureFactoryPlatformMaterial", () => {
  test("creates the Temporal and ingress authorities, the control identity, server material, and an empty revocation list", async () => {
    const paths = await ensureFactoryPlatformMaterial(operatorRoot);
    expect(paths).toEqual(factoryPlatformPaths(operatorRoot));
    const ca = new X509Certificate(await text(paths.temporal.caCertificatePath));
    expect(ca.subject).toBe("CN=factory-temporal-ca");
    expect(ca.checkPrivateKey(createPrivateKey(await text(paths.temporal.caKeyPath)))).toBe(true);
    const control = new X509Certificate(await text(paths.temporal.certificatePath));
    expect(control.subject).toBe("CN=factory-control");
    expect(control.verify(ca.publicKey)).toBe(true);
    expect(control.keyUsage).toEqual(["1.3.6.1.5.5.7.3.2"]);
    expect(control.checkPrivateKey(createPrivateKey(await text(paths.temporal.privateKeyPath)))).toBe(true);
    const env = await text(paths.temporal.databaseEnvPath);
    const [, password] = env.match(/^POSTGRES_PASSWORD=([A-Za-z0-9_-]{32})\nPOSTGRES_PWD=([A-Za-z0-9_-]{32})\n$/) ?? [];
    expect(env).toBe(`POSTGRES_PASSWORD=${password}\nPOSTGRES_PWD=${password}\n`);
    for (const path of [paths.temporal.caCertificatePath, paths.temporal.caKeyPath, paths.temporal.tokenKeyPath, paths.temporal.certificatePath, paths.temporal.privateKeyPath, paths.temporal.databaseEnvPath, paths.temporal.revocationsPath, paths.ingress.caCertificatePath, paths.ingress.caKeyPath]) expect(await mode(path)).toBe(0o600);
    expect(JSON.parse(await text(paths.temporal.revocationsPath))).toEqual({ schemaVersion: "factory.temporal-revocations.v1", subjects: [], certificateHashes: [], tokenIds: [] });
    expect(new X509Certificate(await text(paths.ingress.caCertificatePath)).subject).toBe("CN=factory-ingress-ca");
    // The gateway read-token directory exists, private, before the first namespace is provisioned.
    expect(await mode(paths.temporal.httpTokensDirectory)).toBe(0o700);
    for (const name of ["routes", "certs", "conf"]) expect(await mode(join(paths.ingress.root, name))).toBe(0o700);
    // The ingress process mounts only its own root; the authority that signs every hostname stays outside it.
    expect(paths.ingress.caKeyPath.startsWith(`${paths.ingress.root}/`)).toBe(false);
    expect((await readdir(paths.ingress.root)).sort()).toEqual(["certs", "conf", "routes"]);
    expect(await mode(join(root, "operator"))).toBe(0o700);
  });

  test("the Temporal server directory is the one readable exception: 0755 with 0644 files", async () => {
    const paths = await ensureFactoryPlatformMaterial(operatorRoot);
    const server = paths.temporal.serverDirectory;
    expect(await mode(server)).toBe(0o755);
    expect((await readdir(server)).sort()).toEqual(["ca.crt", "jwks.json", "server.crt", "server.key"]);
    for (const name of await readdir(server)) expect(await mode(join(server, name))).toBe(0o644);
    const certificate = new X509Certificate(await text(join(server, "server.crt")));
    expect(certificate.subject).toBe("CN=temporal.local");
    expect(certificate.verify(new X509Certificate(await text(paths.temporal.caCertificatePath)).publicKey)).toBe(true);
    expect(certificate.checkHost("temporal.local")).toBe("temporal.local");
    expect(certificate.checkHost("localhost")).toBe("localhost");
    expect(certificate.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(certificate.keyUsage?.sort()).toEqual(["1.3.6.1.5.5.7.3.1", "1.3.6.1.5.5.7.3.2"]);
    expect(certificate.checkPrivateKey(createPrivateKey(await text(join(server, "server.key"))))).toBe(true);
    expect(await text(join(server, "ca.crt"))).toBe(await text(paths.temporal.caCertificatePath));
    expect(JSON.parse(await text(join(server, "jwks.json")))).toEqual(factoryTemporalJwks(await text(paths.temporal.tokenKeyPath), "factory-local") as never);
    expect(await text(join(server, "jwks.json"))).not.toContain("PRIVATE");
  });

  test("a rerun changes nothing and runs no openssl command", async () => {
    await ensureFactoryPlatformMaterial(operatorRoot);
    const before = await tree(operatorRoot);
    const calls: string[] = [];
    await ensureFactoryPlatformMaterial(operatorRoot, { run: recordingRunner(calls) });
    expect(calls).toEqual([]);
    expect(await tree(operatorRoot)).toEqual(before);
  });

  test("a rerun reissues a lost server certificate with a matching key, and keeps the files 0644", async () => {
    const paths = await ensureFactoryPlatformMaterial(operatorRoot);
    const serverKey = await text(join(paths.temporal.serverDirectory, "server.key"));
    await rm(join(paths.temporal.serverDirectory, "server.crt"));
    const calls: string[] = [];
    await ensureFactoryPlatformMaterial(operatorRoot, { run: recordingRunner(calls) });
    expect(calls).toEqual(["openssl genpkey", "openssl req", "openssl x509"]);
    const server = new X509Certificate(await text(join(paths.temporal.serverDirectory, "server.crt")));
    const reissuedKey = await text(join(paths.temporal.serverDirectory, "server.key"));
    expect(reissuedKey).not.toBe(serverKey);
    expect(server.checkPrivateKey(createPrivateKey(reissuedKey))).toBe(true);
    for (const name of await readdir(paths.temporal.serverDirectory)) expect(await mode(join(paths.temporal.serverDirectory, name))).toBe(0o644);
  });

  test("an authority key a crash left without its certificate is replaced, and the rerun completes", async () => {
    const paths = factoryPlatformPaths(operatorRoot);
    await mkdir(join(paths.temporal.caCertificatePath, ".."), { recursive: true, mode: 0o700 });
    const stale = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await writeModeFile(paths.temporal.caKeyPath, stale);
    await ensureFactoryPlatformMaterial(operatorRoot);
    expect(await text(paths.temporal.caKeyPath)).not.toBe(stale);
    expect(new X509Certificate(await text(paths.temporal.caCertificatePath)).checkPrivateKey(createPrivateKey(await text(paths.temporal.caKeyPath)))).toBe(true);
  });

  test("a control key a crash left without its certificate is replaced and matches the new certificate", async () => {
    const paths = await ensureFactoryPlatformMaterial(operatorRoot);
    const oldKey = await text(paths.temporal.privateKeyPath);
    await rm(paths.temporal.certificatePath);
    await ensureFactoryPlatformMaterial(operatorRoot);
    const key = await text(paths.temporal.privateKeyPath);
    expect(key).not.toBe(oldKey);
    expect(new X509Certificate(await text(paths.temporal.certificatePath)).checkPrivateKey(createPrivateKey(key))).toBe(true);
  });

  test("an existing revocation list is kept, never reset", async () => {
    const paths = await ensureFactoryPlatformMaterial(operatorRoot);
    const revoked = `${JSON.stringify({ schemaVersion: "factory.temporal-revocations.v1", subjects: ["tenant-01.fleet-a"], certificateHashes: [] })}\n`;
    await writeModeFile(paths.temporal.revocationsPath, revoked);
    await ensureFactoryPlatformMaterial(operatorRoot);
    expect(await text(paths.temporal.revocationsPath)).toBe(revoked);
  });

  test("a failing runner stops before any authority file exists", async () => {
    const failing: FactoryCommandRunner = async () => { throw new FactoryProvisioningError("certificate_tool_unavailable", "openssl could not start"); };
    expect((await factoryRejection(ensureFactoryPlatformMaterial(operatorRoot, { run: failing }))).code).toBe("certificate_tool_unavailable");
    expect(await readdir(join(operatorRoot, "platform", "temporal"))).toEqual([]);
  });

  test("an unsafe authority key is refused, not trusted", async () => {
    const paths = await ensureFactoryPlatformMaterial(operatorRoot);
    await chmod(paths.temporal.certificatePath, 0o640);
    expect((await factoryRejection(ensureFactoryPlatformMaterial(operatorRoot))).message).toBe("Private file must be owned, private, regular, and bounded.");
  });

  test("an operator root with a world-readable owned ancestor is refused", async () => {
    await mkdir(operatorRoot, { mode: 0o755 });
    await chmod(operatorRoot, 0o755);
    expect((await factoryRejection(ensureFactoryPlatformMaterial(operatorRoot))).message).toBe("Private path has a non-private owned ancestor.");
  });
});

const settings: FactoryPlatformSettings = { fleetId: "fleet-a", operatorRoot: "/unused", repositoryRoot: "/repo", temporalPort: 17233, temporalHttpPort: 17244, ingressAddress: "127.0.0.1", ingressPort: 18443 };

describe("factoryPlatformEnvironment", () => {
  test("names the project, the operator paths, and the repository's config", () => {
    const paths = factoryPlatformPaths("/srv/op");
    const env = factoryPlatformEnvironment(settings, paths);
    expect(env).toEqual({
      EZCORP_FACTORY_PLATFORM_PROJECT: "ezcorp-factory-fleet-a-platform",
      EZCORP_FACTORY_TEMPORAL_DB_ENV: "/srv/op/platform/temporal/database.env",
      EZCORP_FACTORY_TEMPORAL_SERVER_DIR: "/srv/op/platform/temporal/server",
      EZCORP_FACTORY_TEMPORAL_REVOCATIONS_DIR: "/srv/op/platform/temporal/revocations",
      EZCORP_FACTORY_TEMPORAL_HTTP_TOKENS: "/srv/op/platform/temporal/http-tokens",
      EZCORP_FACTORY_TEMPORAL_HTTP_PORT: "17244",
      EZCORP_FACTORY_AUTHORIZER_SCRIPTS: "/repo/scripts",
      EZCORP_FACTORY_TEMPORAL_GATEWAY_CONFIG: "/repo/config/factory-temporal-gateway.yaml",
      EZCORP_FACTORY_TEMPORAL_PORT: "17233",
      EZCORP_FACTORY_INGRESS_DIR: "/srv/op/platform/ingress",
    });
    expect(Object.isFrozen(env)).toBe(true);
    expect(Object.values(env).join("\n")).not.toContain(".key");
  });
});

type Executed = { command: readonly string[]; options?: { readonly env?: Readonly<Record<string, string>>; readonly cwd?: string } };
function fakeExecutor(results: FactoryCommandResult[]): { execute: FactoryCommandExecutor; executed: Executed[] } {
  const executed: Executed[] = [];
  return {
    executed,
    execute: async (command, options) => {
      executed.push({ command, ...(options ? { options } : {}) });
      return results.shift() ?? { code: 0, stdout: "", stderr: "" };
    },
  };
}

describe("startFactoryPlatform", () => {
  const compose = { argv: ["docker", "compose"], env: { DOCKER_HOST: "unix:///run/podman.sock" } };

  test("renders nginx, the default server, and the env file, then brings the platform up", async () => {
    const paths = factoryPlatformPaths(operatorRoot);
    const { execute, executed } = fakeExecutor([{ code: 0, stdout: "", stderr: "" }]);
    await startFactoryPlatform(settings, paths, compose, execute);
    const envPath = join(paths.root, "platform.env");
    expect(executed).toEqual([{
      command: ["docker", "compose", "--project-name", "ezcorp-factory-fleet-a-platform", "--file", "/repo/deploy/factory/compose/platform.yml", "--env-file", envPath, "up", "--detach", "--remove-orphans"],
      options: { env: { DOCKER_HOST: "unix:///run/podman.sock" } },
    }]);
    expect(await text(join(paths.ingress.root, "nginx.conf"))).toBe(factoryIngressMainConfig());
    expect(await text(join(paths.ingress.root, "conf", "ezcorp-factory.conf"))).toBe("server {\n  listen 127.0.0.1:18443 ssl default_server;\n  ssl_reject_handshake on;\n}\n");
    const env = await text(envPath);
    expect(env).toBe(`${Object.entries(factoryPlatformEnvironment(settings, paths)).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
    for (const path of [envPath, join(paths.ingress.root, "nginx.conf"), join(paths.ingress.root, "conf", "ezcorp-factory.conf")]) expect(await mode(path)).toBe(0o600);
  });

  test("a rerun is idempotent and keeps the default server written first", async () => {
    const paths = factoryPlatformPaths(operatorRoot);
    const { execute, executed } = fakeExecutor([]);
    await startFactoryPlatform(settings, paths, compose, execute);
    const before = await tree(paths.root);
    await startFactoryPlatform({ ...settings, ingressPort: 19443 }, paths, compose, execute);
    expect(executed).toHaveLength(2);
    expect(await text(join(paths.ingress.root, "conf", "ezcorp-factory.conf"))).toContain("127.0.0.1:18443");
    const after = await tree(paths.root);
    expect({ ...after, "platform.env": "" }).toEqual({ ...before, "platform.env": "" });
  });

  test("a failed compose up fails by name with the last three stderr lines, bounded", async () => {
    const paths = factoryPlatformPaths(operatorRoot);
    const { execute } = fakeExecutor([{ code: 125, stdout: "", stderr: "one\ntwo\nthree\nfour\n" }]);
    const error = await factoryRejection(startFactoryPlatform(settings, paths, compose, execute));
    expect(error).toBeInstanceOf(FactoryProvisioningError);
    expect(error.code).toBe("platform_compose_failed");
    expect(error.message).toBe("platform compose up failed: two | three | four");
    const long = fakeExecutor([{ code: 1, stdout: "", stderr: "x".repeat(1_000) }]);
    const bounded = await factoryRejection(startFactoryPlatform(settings, paths, compose, long.execute));
    expect(bounded.message).toBe(`platform compose up failed: ${"x".repeat(400)}`);
  });
});

describe("factoryPodmanIngressReloader", () => {
  const test_ = ["podman", "exec", "ezcorp-factory-fleet-a-platform-ingress-1", "nginx", "-t", "-c", "/etc/ezcorp-ingress/nginx.conf"];
  const reload_ = ["podman", "exec", "ezcorp-factory-fleet-a-platform-ingress-1", "nginx", "-s", "reload", "-c", "/etc/ezcorp-ingress/nginx.conf"];

  test("tests the config, then reloads the fleet's ingress container", async () => {
    const { execute, executed } = fakeExecutor([]);
    await factoryPodmanIngressReloader("fleet-a", execute).reload();
    expect(executed).toEqual([{ command: test_ }, { command: reload_ }]);
  });

  test("uses the injected engine", async () => {
    const { execute, executed } = fakeExecutor([]);
    await factoryPodmanIngressReloader("fleet-a", execute, "docker").reload();
    expect(executed.map((entry) => entry.command[0])).toEqual(["docker", "docker"]);
  });

  test("a config nginx -t refuses is never reloaded", async () => {
    const { execute, executed } = fakeExecutor([{ code: 1, stdout: "", stderr: "a\nnginx: [emerg] unknown directive\nnginx: configuration file test failed\n" }]);
    const error = await factoryRejection(factoryPodmanIngressReloader("fleet-a", execute).reload());
    expect(error.code).toBe("ingress_config_invalid");
    expect(error.message).toBe("The rendered ingress config was refused: nginx: [emerg] unknown directive | nginx: configuration file test failed");
    expect(executed).toHaveLength(1);
  });

  test("a failed reload fails by name", async () => {
    const { execute } = fakeExecutor([{ code: 0, stdout: "", stderr: "" }, { code: 1, stdout: "", stderr: " no such container \n" }]);
    const error = await factoryRejection(factoryPodmanIngressReloader("fleet-a", execute).reload());
    expect(error.code).toBe("ingress_reload_failed");
    expect(error.message).toBe("The ingress did not reload: no such container");
  });
});

describe("waitForFactoryPlatform", () => {
  test("returns the attempt on which the platform first served, sleeping between attempts", async () => {
    const answers: (boolean | Error)[] = [new Error("connect ECONNREFUSED"), false, true];
    const slept: number[] = [];
    const attempt = await waitForFactoryPlatform(async () => { const next = answers.shift()!; if (next instanceof Error) throw next; return next; }, { attempts: 5, intervalMs: 7, sleep: async (ms) => { slept.push(ms); } });
    expect(attempt).toBe(3);
    expect(slept).toEqual([7, 7]);
  });

  test("a platform that never serves fails by name with the last reason, after the last attempt without a trailing sleep", async () => {
    const slept: number[] = [];
    const thrown = await factoryRejection(waitForFactoryPlatform(async () => { throw new Error("Failed to connect before the deadline"); }, { attempts: 3, intervalMs: 1, sleep: async (ms) => { slept.push(ms); } }));
    expect(thrown).toBeInstanceOf(FactoryProvisioningError);
    expect((thrown as FactoryProvisioningError).code).toBe("platform_not_ready");
    expect(thrown.message).toBe("The platform did not serve within 3 attempts: Failed to connect before the deadline");
    expect(slept).toEqual([1, 1]);
    const notServing = await factoryRejection(waitForFactoryPlatform(async () => false, { attempts: 1 }));
    expect(notServing.message).toBe("The platform did not serve within 1 attempts: not serving");
    const thrownValue = await factoryRejection(waitForFactoryPlatform(async () => { throw "plain"; }, { attempts: 1 }));
    expect(thrownValue.message).toBe("The platform did not serve within 1 attempts: plain");
  });

  test("the default sleep really waits between attempts", async () => {
    let calls = 0;
    const started = Date.now();
    expect(await waitForFactoryPlatform(async () => (calls += 1) === 2, { intervalMs: 20 })).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  test("startFactoryPlatform waits for the platform to serve when asked", async () => {
    const paths = factoryPlatformPaths(operatorRoot);
    const { execute } = fakeExecutor([{ code: 0, stdout: "", stderr: "" }, { code: 0, stdout: "", stderr: "" }]);
    let asked = 0;
    await startFactoryPlatform(settings, paths, { argv: ["docker", "compose"], env: {} }, execute, async () => (asked += 1) === 2, { attempts: 3, sleep: async () => undefined });
    expect(asked).toBe(2);
    const refused = await factoryRejection(startFactoryPlatform(settings, paths, { argv: ["docker", "compose"], env: {} }, execute, async () => false, { attempts: 2, sleep: async () => undefined }));
    expect((refused as FactoryProvisioningError).code).toBe("platform_not_ready");
  });
});
