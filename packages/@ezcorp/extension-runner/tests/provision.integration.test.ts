import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { provisionToolchain } from "../src/provision";
import { RunnerClient } from "../src/client";
import { buildLimits, filesDigest } from "../src";
import { source } from "./helpers";

test("runner provision preserves type-only exports and their declaration closure", async () => {
  const { sdkFiles } = await provisionToolchain();
  const metadata = JSON.parse(sdkFiles["node_modules/@ezcorp/extension-contract/package.json"]!);
  for (const name of ["types", "legacy"]) {
    expect(metadata.exports[`./${name}`]).toEqual({ types: `./src/${name}.d.ts` });
    expect(sdkFiles[`node_modules/@ezcorp/extension-contract/src/${name}.d.ts`]).toBeDefined();
    expect(sdkFiles[`node_modules/@ezcorp/extension-contract/src/${name}.js`]).toBeUndefined();
  }
  expect(sdkFiles["node_modules/@ezcorp/extension-contract/dist/entities.d.ts"]).toBeDefined();
});

test("production runner entrypoint starts and builds a source with public declaration imports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runner-declaration-start-"));
  const socketPath = join(directory, "runner.sock");
  const tokenFile = join(directory, "token");
  const child = Bun.spawn(["bash", "scripts/start-extension-runner-e2e.sh"], {
    cwd: resolve(import.meta.dir, "../../../.."),
    env: { ...process.env, EZ_EXTENSION_RUNNER_SOCKET: socketPath, EZ_EXTENSION_RUNNER_TOKEN_FILE: tokenFile, EZ_EXTENSION_RUNNER_STORE: join(directory, "store"), EZ_EXTENSION_APP_UID: String(process.getuid!()) },
    stdout: "pipe", stderr: "pipe",
  });
  const diagnostics = new Response(child.stderr).text();
  try {
    const deadline = Date.now() + 15_000;
    while (!(await stat(socketPath).catch(() => null))?.isSocket()) {
      if (child.exitCode !== null) throw new Error(`Runner startup failed: ${await diagnostics}`);
      if (Date.now() > deadline) throw new Error("Runner startup deadline exceeded");
      await Bun.sleep(20);
    }
    const client = new RunnerClient({ socketPath, token: (await readFile(tokenFile, "utf8")).trim() });
    const files = source();
    files["declarations.ts"] = "import type {ExtensionManifestV2} from '@ezcorp/extension-contract/legacy';import type {HostApiPermission} from '@ezcorp/extension-contract/types';import type {EntityDeclaration} from '@ezcorp/extension-contract/entities';export type Contract={legacy:ExtensionManifestV2;api:HostApiPermission;entity:EntityDeclaration};";
    const result = await client.build({ operationId: crypto.randomUUID(), sourceDigest: filesDigest(files), files, entrypoint: "extension.ts", limits: buildLimits });
    expect(result.diagnostics).toEqual([]);
    expect(result.state).toBe("succeeded");
    expect(result.evidence.tests.some(entry => entry.name === "typecheck" && entry.passed)).toBe(true);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    await diagnostics;
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
