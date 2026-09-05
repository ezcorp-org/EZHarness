import { afterEach, expect, spyOn, test } from "bun:test";
import { mcpReleaseFixture } from "./helpers/mcp-release-fixture";
let fixture: ReturnType<typeof mcpReleaseFixture>;
afterEach(() => fixture?.cleanup());

test("MCP registry does not allocate host veth or subprocess resources and closes each runner worker", async () => {
  fixture = mcpReleaseFixture();
  const spawn = spyOn(Bun, "spawn");
  try {
    const client = await fixture.registry.getMcpClient(fixture.id);
    await client.callTool("echo", {}, fixture.meta);
    expect(fixture.starts()).toBe(1);
    expect(fixture.closed()).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(client.getChildProcess()).toBeNull();
    fixture.invoke(async () => { throw new Error("worker failed"); });
    await expect(client.callTool("echo", {}, fixture.meta)).rejects.toThrow("worker failed");
    expect(fixture.closed()).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); }
});
