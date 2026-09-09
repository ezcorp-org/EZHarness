import { afterEach, expect, test } from "bun:test";
import { mcpReleaseFixture } from "./helpers/mcp-release-fixture";
let fixture: ReturnType<typeof mcpReleaseFixture>;
afterEach(() => fixture?.cleanup());

test("catalog drift is rejected without changing the approved registry catalog", async () => {
  fixture = mcpReleaseFixture();
  fixture.discover(() => ({ ...fixture.manifest, tools: [] }));
  const client = await fixture.registry.getMcpClient(fixture.id);
  await expect(client.callTool("echo", {}, fixture.meta)).rejects.toThrow();
  expect((await client.listTools()).map(tool => tool.name)).toEqual(["echo"]);
  expect(fixture.registry.getManifest(fixture.id)?.tools?.map(tool => tool.name)).toEqual(["echo"]);
  expect(fixture.closed()).toBe(1);
});

test("concurrent catalog drift rejects every invocation and closes every isolated worker", async () => {
  fixture = mcpReleaseFixture();
  fixture.discover(() => ({ ...fixture.manifest, description: "Changed" }));
  const client = await fixture.registry.getMcpClient(fixture.id);
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => client.callTool("echo", {}, fixture.meta)));
  expect(results.every(result => result.status === "rejected")).toBe(true);
  expect(fixture.starts()).toBe(12);
  expect(fixture.closed()).toBe(12);
});

test("failed discovery does not poison a later worker with the approved catalog", async () => {
  fixture = mcpReleaseFixture();
  fixture.discover(() => { throw new Error("discovery failed"); });
  const client = await fixture.registry.getMcpClient(fixture.id);
  await expect(client.callTool("echo", {}, fixture.meta)).rejects.toThrow("discovery failed");
  fixture.discover(() => fixture.manifest);
  expect(await client.callTool("echo", {}, fixture.meta)).toMatchObject({ isError: false });
  expect(fixture.closed()).toBe(2);
});

test("refresh reads only approved catalog and never starts an unapproved discovery process", async () => {
  fixture = mcpReleaseFixture();
  for (let count = 0; count < 25; count++) expect((await fixture.registry.refreshMcpTools(fixture.id)).map(tool => tool.name)).toEqual(["echo"]);
  expect(fixture.starts()).toBe(0);
});

test("killAll retires MCP descriptors so stale handles cannot start workers", async () => {
  fixture = mcpReleaseFixture();
  const client = await fixture.registry.getMcpClient(fixture.id);
  fixture.registry.killAll();
  await expect(client.callTool("echo", {}, fixture.meta)).rejects.toThrow();
  expect(fixture.starts()).toBe(0);
});

test("disabled releases cannot list or invoke their previously approved tools", async () => {
  fixture = mcpReleaseFixture();
  const client = await fixture.registry.getMcpClient(fixture.id);
  fixture.snapshot.installation.enabled = false;
  await expect(client.listTools()).rejects.toThrow();
  await expect(client.callTool("echo", {}, fixture.meta)).rejects.toThrow();
  expect(fixture.starts()).toBe(0);
});
