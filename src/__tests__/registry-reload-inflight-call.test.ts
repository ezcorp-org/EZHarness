import { afterEach, expect, test } from "bun:test";
import { mcpReleaseFixture } from "./helpers/mcp-release-fixture";
let fixture: ReturnType<typeof mcpReleaseFixture>;
afterEach(() => fixture?.cleanup());

async function parkedCall() {
  fixture = mcpReleaseFixture();
  const entered = Promise.withResolvers<void>();
  const result = Promise.withResolvers<unknown>();
  fixture.invoke(async () => { entered.resolve(); return result.promise; });
  const process = await fixture.registry.getProcess(fixture.id);
  const call = process.callTool("echo", {}, fixture.meta);
  await entered.promise;
  return { process, call, result };
}

test("an unrelated registry reload does not kill an in-flight isolated call", async () => {
  const { process, call, result } = await parkedCall();
  fixture.registry.loadFromDb = async () => {};
  await fixture.registry.reload();
  expect(process.inFlightCallCount).toBe(1);
  expect(fixture.closed()).toBe(0);
  result.resolve({ content: [{ type: "text", text: "released" }], isError: false });
  expect(await call).toMatchObject({ content: [{ type: "text", text: "released" }] });
  await process.whenCallsSettled();
  expect(process.inFlightCallCount).toBe(0);
  expect(fixture.closed()).toBe(1);
});

test("release changes fence a parked response and still reclaim its worker", async () => {
  const { process, call, result } = await parkedCall();
  const outcome = Promise.allSettled([call]);
  fixture.snapshot.installation.generation++;
  fixture.snapshot.installation.acknowledgedGeneration++;
  fixture.registry.loadFromDb = async () => { fixture.registry.setManifestForTest(fixture.id, { ...fixture.manifest, version: "2.0.0" }); };
  await fixture.registry.reload();
  result.resolve({ content: [{ type: "text", text: "stale" }], isError: false });
  expect((await outcome)[0]?.status).toBe("rejected");
  await process.whenCallsSettled();
  expect(process.inFlightCallCount).toBe(0);
  expect(fixture.closed()).toBe(1);
});
