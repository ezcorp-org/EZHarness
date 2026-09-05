import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { buildFirstPartyRelease } from "../../../__tests__/helpers/first-party-release";
import { closeTestDb, mockDbConnection, setupTestDb } from "../../../__tests__/helpers/test-pglite";

mockDbConnection();
let release: Awaited<ReturnType<typeof buildFirstPartyRelease>>;
let session: Awaited<ReturnType<typeof release.session>>;
beforeAll(async () => { release = await buildFirstPartyRelease("github-stats"); }, 120_000);
beforeEach(async () => { await setupTestDb(); session = await release.session({ denyNetwork: true }); });
afterEach(async () => { await session?.close(); });
afterAll(async () => { await release?.close(); await closeTestDb(); });

async function denied(name: string, input: Record<string, unknown>) {
  const result = await session.tool(name, input);
  expect(result.isError).toBe(true);
  expect(result.content[0]?.type).toBe("text");
  expect(session.failures).toContainEqual(expect.stringContaining("Network access was not approved"));
}

for (const name of ["repo-stats", "user-profile", "repo-languages"]) {
  test(`${name} reaches the production network permission denial`, async () => {
    await denied(name, name === "user-profile" ? { username: "octocat" } : { owner: "octocat", repo: "hello-world" });
    expect(session.starts()).toBe(1);
  }, 30_000);
}

test("unknown tool cannot start a handler and a declared follow-up still works", async () => {
  await expect(session.tool("no-such-tool", {})).rejects.toMatchObject({ code: "UNDECLARED_CONTRIBUTION" });
  await denied("repo-stats", { owner: "octocat", repo: "hello-world" });
}, 30_000);

test("three sequential denied requests remain tool errors rather than transport failures", async () => {
  for (let index = 0; index < 3; index++) await denied("repo-stats", { owner: "octocat", repo: `repo-${index}` });
  expect(session.starts()).toBe(3);
  expect(session.process.inFlightCallCount).toBe(0);
}, 60_000);

test("concurrent denied requests preserve each framed result", async () => {
  await Promise.all([denied("repo-stats", { owner: "octocat", repo: "a" }), denied("user-profile", { username: "octocat" }), denied("repo-languages", { owner: "octocat", repo: "b" })]);
  expect(session.process.inFlightCallCount).toBe(0);
}, 60_000);

test("five tool-level denials do not disable later invocations", async () => {
  for (let index = 0; index < 5; index++) await denied("repo-stats", { owner: "octocat", repo: `repo-${index}` });
  expect(session.starts()).toBe(5);
  expect(session.process.inFlightCallCount).toBe(0);
  expect(await session.installed()).toMatchObject({ enabled: true, consecutiveFailures: 0 });
}, 90_000);
