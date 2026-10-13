import { describe, expect, test } from "bun:test";
import { MCP_BRIDGE_SOURCE, MCP_BRIDGE_TEST_SOURCE, type ExtensionManifestV4, type Runner, type RunnerCapabilities, type WorkspaceFiles } from "@ezcorp/extension-contract";
import { filesDigest } from "@ezcorp/extension-runner";
import { releaseProcessSpawn, requireProcessSpawnEnforcement, SHELL_GRANT } from "./process-spawn-policy";

const stdioManifest = { schemaVersion: 4, name: "files-mcp", version: "1.0.0", description: "MCP", author: { name: "admin" }, kind: "mcp", permissions: {}, mcpServers: [{ name: "files", transport: "stdio", command: "files-server" }], tools: [] } as unknown as ExtensionManifestV4;
const toolManifest = { schemaVersion: 4, name: "tool", version: "1.0.0", description: "Tool", author: { name: "admin" }, permissions: {}, tools: [] } as unknown as ExtensionManifestV4;

function artifact(sources: WorkspaceFiles, entrypoint = "extension.ts"): WorkspaceFiles {
  return { ...sources, ".runner/extension.js": "bundle", ".runner/recipe.json": JSON.stringify({ entrypoint }) };
}
const bridgeArtifact = artifact({ "extension.ts": MCP_BRIDGE_SOURCE, "mcp.manifest.json": JSON.stringify(stdioManifest), "metadata.test.ts": MCP_BRIDGE_TEST_SOURCE });
const customArtifact = artifact({ "extension.ts": `${MCP_BRIDGE_SOURCE}// the author's own code\n`, "mcp.manifest.json": JSON.stringify(stdioManifest) });

function runner(capabilities: RunnerCapabilities | undefined, files: WorkspaceFiles = {}): Runner & { collected: number; asked: number } {
  const fake = {
    collected: 0,
    asked: 0,
    build: async () => { throw new Error("unused"); },
    start: async () => { throw new Error("unused"); },
    cancel: async () => {},
    inspect: async (id: string) => ({ id, state: "unknown" as const, diagnostics: [] }),
    collectArtifacts: async () => { fake.collected++; return files; },
    ...(capabilities ? { capabilities: async () => { fake.asked++; return capabilities; } } : {}),
  };
  return fake;
}
const enforcing = { processSpawnEnforcement: true };

describe("releaseProcessSpawn", () => {
  test("the shell grant allows spawning and needs no enforcement", async () => {
    const legacy = runner(undefined);
    expect(await releaseProcessSpawn(legacy, { artifactDigest: "a".repeat(64), manifest: toolManifest }, true)).toBe("allow");
    expect(legacy.collected).toBe(0);
    expect(SHELL_GRANT).toBe('["shell",true]');
  });

  test("an ordinary extension without the grant is denied on a runner that enforces it", async () => {
    const target = runner(enforcing);
    expect(await releaseProcessSpawn(target, { artifactDigest: "b".repeat(64), manifest: toolManifest }, false)).toBe("deny");
    expect(target.asked).toBe(1);
    expect(target.collected).toBe(0);
  });

  test("a runner that does not advertise enforcement, or reports it missing, refuses the non-shell start", async () => {
    for (const target of [runner(undefined), runner({ processSpawnEnforcement: false })]) {
      await expect(releaseProcessSpawn(target, { artifactDigest: "c".repeat(64), manifest: toolManifest }, false)).rejects.toMatchObject({ code: "PROCESS_SPAWN_UNENFORCED" });
    }
  });

  test("a pure SDK MCP bridge release may start its stdio server, read once per artifact digest", async () => {
    const target = runner(undefined, bridgeArtifact);
    const release = { artifactDigest: filesDigest(bridgeArtifact), manifest: stdioManifest };
    expect(await releaseProcessSpawn(target, release, false)).toBe("allow");
    expect(await releaseProcessSpawn(target, release, false)).toBe("allow");
    expect(target.collected).toBe(1);
  });

  test("custom code beside a stdio MCP entry needs the shell grant", async () => {
    const release = { artifactDigest: filesDigest(customArtifact), manifest: stdioManifest };
    expect(await releaseProcessSpawn(runner(enforcing, customArtifact), release, false)).toBe("deny");
    expect(await releaseProcessSpawn(runner(enforcing, customArtifact), release, true)).toBe("allow");
  });

  test("an artifact that does not match its digest is refused, never judged", async () => {
    const tampered = runner(enforcing, { ...bridgeArtifact, "extra.ts": "x" });
    await expect(releaseProcessSpawn(tampered, { artifactDigest: "d".repeat(64), manifest: stdioManifest }, false)).rejects.toMatchObject({ code: "ARTIFACT_CORRUPT" });
  });
});

test("requireProcessSpawnEnforcement never asks for an allow start", async () => {
  const target = runner(enforcing);
  await requireProcessSpawnEnforcement(target, "allow");
  expect(target.asked).toBe(0);
});
