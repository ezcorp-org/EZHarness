import { afterEach, expect, test } from "bun:test";
import { mcpReleaseFixture } from "./helpers/mcp-release-fixture";
let fixture: ReturnType<typeof mcpReleaseFixture>;
afterEach(() => fixture?.cleanup());

test("closed MCP descriptors cannot resurrect workers; reconnect creates a new descriptor", async () => {
  fixture = mcpReleaseFixture();
  const first = await fixture.registry.getMcpClient(fixture.id);
  expect(await first.callTool("echo", {}, fixture.meta)).toMatchObject({ isError: false });
  await first.close();
  await expect(first.callTool("echo", {}, fixture.meta)).rejects.toThrow("closed");
  const second = await fixture.registry.getMcpClient(fixture.id);
  expect(second).not.toBe(first);
  expect(await second.callTool("echo", {}, fixture.meta)).toMatchObject({ isError: false });
  expect(fixture.starts()).toBe(2);
  expect(fixture.closed()).toBe(2);
});

test("late close of an old MCP descriptor cannot evict its replacement", async () => {
  fixture = mcpReleaseFixture();
  const first = await fixture.registry.getMcpClient(fixture.id);
  await first.close();
  const replacement = await fixture.registry.getMcpClient(fixture.id);
  await first.close();
  expect(await fixture.registry.getMcpClient(fixture.id)).toBe(replacement);
  expect(await replacement.callTool("echo", {}, fixture.meta)).toMatchObject({ isError: false });
  expect(fixture.closed()).toBe(1);
});
