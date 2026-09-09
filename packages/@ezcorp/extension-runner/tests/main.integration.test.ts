import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerClient, buildLimits, executionLimits, filesDigest } from "../src";
import { source } from "./helpers";

test("production service probes Podman and serves the complete build and invoke API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ez-runner-main-"));
  const socketPath = join(directory, "runner.sock");
  const tokenFile = join(directory, "token");
  const token = "real-runner-service-credential-for-test";
  await writeFile(tokenFile, token, { mode: 0o600 });
  const environment = {
    EZ_EXTENSION_RUNNER_SOCKET: socketPath,
    EZ_EXTENSION_RUNNER_TOKEN_FILE: tokenFile,
    EZ_EXTENSION_RUNNER_STORE: join(directory, "store"),
    EZ_EXTENSION_APP_UID: String(process.getuid!()),
    EZ_EXTENSION_RUNNER_SDK_ENTRY: process.env.EZ_RUNNER_SDK_ENTRY,
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const running = await import("../src/main");
  try {
    const client = new RunnerClient({ socketPath, token });
    const files = source("async (input,ctx)=>({value:await ctx.call('storage.get',input)})");
    const result = await client.build({ operationId: "service-build", sourceDigest: filesDigest(files), files, entrypoint: "extension.ts", limits: buildLimits });
    expect(result.diagnostics).toEqual([]);
    const context = { workerId: "service-worker", invocationId: "service-invocation", releaseId: result.artifactDigest!, principalId: "user", scopeId: "scope", token: "invocation-token", deadline: Date.now() + 30_000 };
    const worker = await client.start({ workerId: context.workerId, context, artifactDigest: result.artifactDigest!, limits: executionLimits }, async () => "stored");
    try { expect(await worker.request("extension/invoke", { name: "echo", input: {}, context })).toEqual({ value: "stored" }); } finally { await worker.close(); }
    expect((await client.inspect("service-build")).state).toBe("succeeded");
  } finally {
    let code = -1;
    await running.stopRunner(value => { code = value; });
    expect(code).toBe(0);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
