import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listFirstPartyExtensionSources, snapshotFirstPartyExtension } from "./migrate-extension-v4";

export interface FirstPartyVerificationResult {
  name: string;
  sourceFiles: number;
  sourceBytes: number;
  artifactDigest?: string;
  manifest?: Record<string, unknown>;
  error?: string;
}

export async function verifyFirstPartyExtensions(projectRoot: string, image: string): Promise<FirstPartyVerificationResult[]> {
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(image)) throw new Error("Use the full digest of a locally installed Bun runtime image");
  const directory = await mkdtemp(join(tmpdir(), "extension-v4-verification-"));
  const results: FirstPartyVerificationResult[] = [];
  try {
    for (const source of await listFirstPartyExtensionSources(projectRoot)) {
      const snapshot = await snapshotFirstPartyExtension(projectRoot, source.name);
      const result: FirstPartyVerificationResult = { name: source.name, sourceFiles: Object.keys(snapshot.files).length, sourceBytes: snapshot.bytes };
      results.push(result);
      try {
        const build = await Bun.build({ entrypoints: [join(projectRoot, source.directory, source.entrypoint)], target: "bun", packages: "bundle" });
        if (!build.success || build.outputs.length !== 1) throw new Error(build.logs.map(String).join("\n") || "Build did not produce one runtime artifact");
        const bytes = new Uint8Array(await build.outputs[0]!.arrayBuffer());
        result.artifactDigest = createHash("sha256").update(bytes).digest("hex");
        const artifact = join(directory, `${source.name}.js`);
        await writeFile(artifact, bytes, { mode: 0o444 });
        const containerName = `extension-v4-check-${randomUUID()}`;
        const child = Bun.spawn(["podman", "run", "--name", containerName, "--rm", "--pull=never", "-i", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=65534:65534", "--memory=512m", "--memory-swap=512m", "--cpus=1", "--pids-limit=64", "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m", `--mount=type=bind,source=${artifact},destination=/extension.ts,ro`, "--entrypoint=bun", image, "/extension.ts"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "extension/discover", params: {} })}\n`);
        child.stdin.end();
        const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
        async function boundedOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of stream) {
            size += chunk.byteLength;
            if (size > 1024 * 1024) {
              child.kill("SIGKILL");
              throw new Error("Runtime output exceeded its limit");
            }
            chunks.push(chunk);
          }
          return Buffer.concat(chunks).toString("utf8");
        }
        try {
          const [stdout, stderr, exitCode] = await Promise.all([boundedOutput(child.stdout), boundedOutput(child.stderr), child.exited]);
          if (exitCode !== 0) throw new Error(stderr.slice(0, 4000) || `Runtime exited ${exitCode}`);
          if (Buffer.byteLength(stdout) > 1024 * 1024) throw new Error("Metadata exceeded the control frame limit");
          const response = JSON.parse(stdout.trim());
          if (response.jsonrpc !== "2.0" || response.id !== 1 || response.error || response.result?.schemaVersion !== 4) throw new Error("Runtime did not return v4 metadata");
          result.manifest = response.result;
        } finally {
          clearTimeout(timer);
          child.kill("SIGKILL");
          const cleanup = Bun.spawn(["podman", "rm", "--force", "--ignore", containerName], { stdout: "ignore", stderr: "ignore" });
          await cleanup.exited;
        }
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      }
    }
    return results;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const image = process.env.EXTENSION_RUNNER_IMAGE;
  if (!image) throw new Error("Set EXTENSION_RUNNER_IMAGE to a locally installed Bun image digest");
  const results = await verifyFirstPartyExtensions(resolve(dirname(import.meta.path), ".."), image);
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  if (results.some((result) => result.error)) process.exitCode = 1;
}
