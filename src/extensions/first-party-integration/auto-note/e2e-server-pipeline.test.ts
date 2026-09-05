import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { buildFirstPartyRelease } from "../../../__tests__/helpers/first-party-release";
import { closeTestDb, mockDbConnection, setupTestDb } from "../../../__tests__/helpers/test-pglite";

mockDbConnection();
let release: Awaited<ReturnType<typeof buildFirstPartyRelease>>;
let session: Awaited<ReturnType<typeof release.session>>;
beforeAll(async () => { release = await buildFirstPartyRelease("auto-note"); }, 120_000);
beforeEach(async () => { await setupTestDb(); session = await release.session(); });
afterEach(async () => { await session?.close(); });
afterAll(async () => { await release?.close(); await closeTestDb(); });

async function capture(text: string) {
  const result = await session.tool("capture", { text, mode: "yolo" });
  expect({ result, failures: session.failures }).toMatchObject({ result: { isError: false } });
  expect(result.content[0]?.text).toContain("Done!");
}

test("three retries use fresh isolated workers and preserve the vault", async () => {
  for (let index = 0; index < 3; index++) await capture(`retry-${index} test capture`);
  expect(session.starts()).toBe(3);
  expect(session.process.inFlightCallCount).toBe(0);
}, 60_000);

test("lifecycle dispatch followed by a tool call keeps framed transport aligned", async () => {
  expect((await session.tool("vault-tree", {})).isError).toBe(false);
  await session.call("lifecycle/run:start", {});
  await capture("post-lifecycle capture");
}, 60_000);

test("panel state emitted by lifecycle does not desynchronize the next tool result", async () => {
  await session.call("lifecycle/run:start", {});
  expect(session.notifications.some(notification => notification.method === "ezcorp/state")).toBe(true);
  await capture("after-panel-state");
}, 60_000);

test("ten sequential captures preserve state across isolated workers", async () => {
  for (let index = 0; index < 10; index++) await capture(`sequential note ${index} #bulk`);
  expect(session.starts()).toBe(10);
  expect(session.process.inFlightCallCount).toBe(0);
}, 120_000);

test("concurrent captures complete without cross-wiring results", async () => {
  await Promise.all(["concurrent A #race", "concurrent B #race", "concurrent C #race"].map(capture));
  expect(session.starts()).toBe(3);
  expect(session.process.inFlightCallCount).toBe(0);
}, 60_000);

test("schema-invalid input is rejected without preventing a valid follow-up", async () => {
  await expect(session.tool("capture", {})).rejects.toThrow();
  await capture("recovery note");
}, 60_000);

test("lifecycle panel notification retains the declared state shape", async () => {
  await session.call("lifecycle/run:start", {});
  const state = session.notifications.find(notification => notification.method === "ezcorp/state")?.params;
  expect(state).toBeDefined();
  expect(typeof state?.title).toBe("string");
  expect(Array.isArray(state?.components)).toBe(true);
}, 60_000);
