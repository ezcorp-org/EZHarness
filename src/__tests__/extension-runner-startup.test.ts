import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { UNSANDBOXED_ACK_SENTENCE } from "../extensions/runner-mode";

const root = resolve(import.meta.dir, "../..");
const entrypoint = join(root, "deploy/extension-runner/app-entrypoint.sh");
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("EZCORP_EXTENSION_RUNNER") && key !== "EZCORP_EXTENSIONS_UNSANDBOXED_ACK"));

async function run(env: Record<string, string> = {}, command = ["sh", "-c", "echo APP_STARTED; exit 17"]) {
  const child = Bun.spawn(["sh", entrypoint, ...command], { cwd: root, env: { ...cleanEnv, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", ...env }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

describe("default Compose runner connection", () => {
  test("both stacks inherit the same isolated connection and preserve app commands", async () => {
    for (const path of ["docker-compose.yml", "compose.prod.yml"]) {
      const config = Bun.YAML.parse(await Bun.file(join(root, path)).text()) as { services: { app: { extends: { file: string; service: string } } } };
      expect(config.services.app.extends).toEqual({ file: `${"$"}{EZCORP_RUNNER_COMPOSE_FILE:-deploy/extension-runner/compose.runner.yml}`, service: "app" });
    }
    const connection = Bun.YAML.parse(await Bun.file(join(root, "deploy/extension-runner/compose.runner.yml")).text()) as { services: { app: { environment: Record<string, string>; volumes: { target: string; read_only: boolean; bind: { create_host_path: boolean } }[] } } };
    const app = connection.services.app;
    expect(app.volumes.map((mount) => mount.target)).toEqual(["/run/ez-extension-runner", app.environment.EZCORP_EXTENSION_RUNNER_TOKEN_FILE!]);
    expect(app.environment.EZCORP_EXTENSION_RUNNER_SOCKET).toBe("/run/ez-extension-runner/runner.sock");
    expect(app.volumes.every((mount) => mount.read_only && !mount.bind.create_host_path)).toBe(true);
    const launch = Bun.YAML.parse(await Bun.file(join(root, "deploy/extension-runner/compose.app.yml")).text()) as { services: { app: { entrypoint: string[]; command: string[] } } };
    expect(launch.services.app.entrypoint).toEqual(["/bin/sh", "/app/deploy/extension-runner/app-entrypoint.sh"]);
    expect(launch.services.app.command).toEqual(["bun", "run", "web/build/index.js"]);
  });

  test("missing settings stop startup and name the setup guide", async () => {
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("APP_STARTED");
    expect(result.stderr).toContain("deploy/extension-runner/README.md");
  });

  test("only an authenticated runner reply permits startup; failures never expose the token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-startup-"));
    const socket = join(directory, "runner.sock");
    const tokenFile = join(directory, "token");
    const token = crypto.randomUUID();
    await writeFile(tokenFile, token, { mode: 0o600 });
    let status = 200;
    let state = "unknown";
    const requests: unknown[] = [];
    const server = Bun.serve({ unix: socket, async fetch(request) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
      requests.push({ path: new URL(request.url).pathname, body: await request.json() });
      return Response.json({ state }, { status });
    } });
    const env = { EZCORP_EXTENSION_RUNNER_SOCKET: socket, EZCORP_EXTENSION_RUNNER_TOKEN_FILE: tokenFile };
    try {
      const accepted = await run(env);
      expect(accepted.code).toBe(17);
      expect(accepted.stdout).toContain("APP_STARTED");
      expect(requests).toEqual([{ path: "/v4/inspect", body: { id: "app-startup-probe" } }]);
      for (const response of [{ status: 401, state: "unknown" }, { status: 200, state: "invalid" }]) {
        ({ status, state } = response);
        const rejected = await run(env);
        expect(rejected.code).toBe(1);
        expect(rejected.stdout).not.toContain("APP_STARTED");
        expect(rejected.stderr).not.toContain(token);
      }
      server.stop(true);
      const stopped = await run(env);
      expect(stopped.code).toBe(1);
      expect(stopped.stdout).not.toContain("APP_STARTED");
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("trusted-local requires its explicit mode and acknowledgement", async () => {
    const rejected = await run({ EZCORP_EXTENSION_RUNNER: "trusted-local" });
    expect(rejected.code).toBe(1);
    expect(rejected.stdout).not.toContain("APP_STARTED");
    const accepted = await run({ EZCORP_EXTENSION_RUNNER: "trusted-local", EZCORP_EXTENSIONS_UNSANDBOXED_ACK: UNSANDBOXED_ACK_SENTENCE });
    expect(accepted.code).toBe(17);
    expect(accepted.stdout).toContain("APP_STARTED");
  });

  test("a runner that never replies cannot leave startup waiting forever", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-stalled-"));
    const socket = join(directory, "runner.sock");
    const reply = Promise.withResolvers<Response>();
    const server = Bun.serve({ unix: socket, fetch: () => reply.promise });
    try {
      const result = await run({ EZCORP_EXTENSION_RUNNER_SOCKET: socket, EZCORP_EXTENSION_RUNNER_TOKEN: crypto.randomUUID() });
      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain("APP_STARTED");
      expect(result.stderr).toContain("Extension runner is not ready");
    } finally {
      reply.resolve(new Response());
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});
