import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson, sealPublishedRelease, validatePublishedRelease, workspaceFileBytes } from "@ezcorp/extension-contract";
import { snapshotExtensionSource } from "../../../../scripts/migrate-extension-v4";
import { PodmanRunner, buildLimits, executionLimits, filesDigest } from "../src";
import { provision, source } from "./helpers";

test("PNG and executable assets survive source import, isolated build, invocation and publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "binary-extension-"));
  const directory = join(root, "extension");
  const marker = join(root, "host-executed");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const script = "#!/bin/sh\nprintf isolated-asset\n";
  const runner = new PodmanRunner({ root: join(root, "runner"), ...await provision() });
  try {
    await mkdir(join(directory, "assets"), { recursive: true });
    await mkdir(join(directory, "bin"));
    const files = source(`async () => {
      const proc = Bun.spawn(['./bin/helper'], {stdout:'pipe',stderr:'pipe'});
      const output = await new Response(proc.stdout).text();
      if (await proc.exited !== 0) throw new Error('Asset execution failed');
      const fs = await import('node:fs/promises');
      return {png:Buffer.from(await Bun.file('assets/pixel.png').arrayBuffer()).toString('base64'),output,mode:(await fs.stat('bin/helper')).mode & 0o777,assetMode:(await fs.stat('assets/pixel.png')).mode & 0o777};
    }`);
    delete files["assets/greeting.txt"];
    files["feature.test.ts"] = "import {test,expect} from 'bun:test';import {encodeWorkspaceFile,workspaceFileBytes} from '@ezcorp/extension-contract/files';test('browser-safe codec subpath is packaged',()=>expect([...workspaceFileBytes(encodeWorkspaceFile(new Uint8Array([137,80,0])))]).toEqual([137,80,0]));";
    for (const [path, value] of Object.entries(files)) await writeFile(join(directory, path), workspaceFileBytes(value));
    await writeFile(join(directory, "assets/pixel.png"), png);
    await writeFile(join(directory, "bin/helper"), script);
    await chmod(join(directory, "bin/helper"), 0o755);
    await writeFile(join(directory, "never-run"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    await chmod(join(directory, "never-run"), 0o755);
    const snapshot = await snapshotExtensionSource(root, { name: "binary-test", directory: "extension", entrypoint: "extension.ts" });
    expect(snapshot.files["assets/pixel.png"]).toEqual({ encoding: "base64", data: png.toString("base64"), executable: false });
    expect(snapshot.files["bin/helper"]).toMatchObject({ encoding: "base64", executable: true });
    const build = await runner.build({ operationId: crypto.randomUUID(), files: snapshot.files, sourceDigest: filesDigest(snapshot.files), entrypoint: "extension.ts", limits: buildLimits });
    expect(build.diagnostics).toEqual([]);
    expect(build.state).toBe("succeeded");
    const artifacts = await runner.collectArtifacts(build.artifactDigest!);
    expect(workspaceFileBytes(artifacts["assets/pixel.png"]!)).toEqual(new Uint8Array(png));
    const published = await sealPublishedRelease(build, artifacts);
    expect((await validatePublishedRelease(JSON.parse(canonicalJson(published)))).sourceFiles).toEqual(snapshot.files);
    expect(filesDigest({ ...snapshot.files, "bin/helper": { encoding: "base64", data: Buffer.from(script).toString("base64"), executable: false } })).not.toBe(build.sourceDigest);
    const workerId = crypto.randomUUID();
    const context = { workerId, invocationId: crypto.randomUUID(), releaseId: build.artifactDigest!, principalId: "owner", scopeId: "test", token: "test", deadline: Date.now() + 30_000 };
    const worker = await runner.start({ workerId, artifactDigest: build.artifactDigest!, context, limits: executionLimits }, async () => { throw new Error("No host capabilities are declared"); });
    try { expect(await worker.request("extension/invoke", { name: "echo", input: {}, context })).toEqual({ png: png.toString("base64"), output: "isolated-asset", mode: 0o555, assetMode: 0o444 }); }
    finally { await worker.close(); }
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally { await runner.close(); await rm(root, { recursive: true, force: true }); }
}, 120_000);
