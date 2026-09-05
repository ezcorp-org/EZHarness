import { afterEach, expect, test } from "bun:test";
import { mcpReleaseFixture } from "./helpers/mcp-release-fixture";
let fixture: ReturnType<typeof mcpReleaseFixture>;
afterEach(() => fixture?.cleanup());

test("MCP execution uses the isolated runner rather than a host seccomp soak fallback", async () => {
  const source = await Bun.file(new URL("../extensions/registry.ts", import.meta.url)).text();
  for (const legacy of ["buildSandboxedMcpSpec(", "runMcpSeccompSoakReader(", "getChildProcess()", "releaseVethSlot("]) expect(source).not.toContain(legacy);
  fixture = mcpReleaseFixture();
  const client = await fixture.registry.getMcpClient(fixture.id);
  expect(fixture.starts()).toBe(0);
  await client.callTool("echo", {}, fixture.meta);
  expect(fixture.starts()).toBe(1);
  expect(fixture.closed()).toBe(1);
  fixture.snapshot.installation.enabled = false;
  await expect(client.callTool("echo", {}, fixture.meta)).rejects.toThrow();
  expect(fixture.starts()).toBe(1);
});
