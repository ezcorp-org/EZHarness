/** Explicit live-provider replay. Uses built releases, real DNS and host egress. */
import { strict as assert } from "node:assert";
import { buildFirstPartyRelease } from "../src/__tests__/helpers/first-party-release";
import { closeTestDb, mockDbConnection, setupTestDb } from "../src/__tests__/helpers/test-pglite";
import { defaultResolveHost } from "../src/search/egress";

mockDbConnection();
type Output = Record<string, unknown>;
const cases = [
  { name: "github-stats", hosts: ["api.github.com"], tool: "user-profile", input: { username: "octocat" }, check: (value: Output) => value.login === "octocat" && typeof value.publicRepos === "number" && value.publicRepos > 0 },
  { name: "weather", hosts: ["geocoding-api.open-meteo.com", "api.open-meteo.com"], tool: "get_weather", input: { location: "New York, NY", unit: "celsius" }, check: (value: Output) => Boolean(value.location && value.current && Array.isArray(value.daily) && value.daily.length > 0) },
  { name: "city-conditions", hosts: ["geocoding-api.open-meteo.com", "api.open-meteo.com", "air-quality-api.open-meteo.com", "www.atlantaallergy.com"], tool: "city_conditions", input: { city: "New York, NY", unit: "celsius" }, check: (value: Output) => value.ok === true && Boolean(value.weather && value.pollen) },
  { name: "price-chart", hosts: ["query1.finance.yahoo.com", "api.coingecko.com", "logo.clearbit.com"], tool: "get_stock_chart", input: { ticker: "MSFT" }, check: (value: Output) => Boolean(value.symbol && Array.isArray(value.points) && value.points.length > 0) },
];

const results: Array<{ extension: string; passed: boolean; error?: string }> = [];
for (const item of cases) {
  let release: Awaited<ReturnType<typeof buildFirstPartyRelease>> | undefined;
  let session: Awaited<ReturnType<NonNullable<typeof release>["session"]>> | undefined;
  try {
    await setupTestDb();
    release = await buildFirstPartyRelease(item.name);
    session = await release.session({ networkHosts: item.hosts, fetchImpl: fetch, resolveHost: defaultResolveHost });
    const result = await session.tool(item.tool, item.input);
    assert.equal(result.isError, false, JSON.stringify({ result, failures: session.failures }));
    const output = JSON.parse(result.content[0]?.text ?? "null") as Output | null;
    assert(output && item.check(output), `${item.name} returned no valid provider result`);
    results.push({ extension: item.name, passed: true });
  } catch (error) {
    results.push({ extension: item.name, passed: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await session?.close();
    await release?.close();
    await closeTestDb();
  }
}
console.log(JSON.stringify({ checks: results, passed: results.every(result => result.passed) }));
if (results.some(result => !result.passed)) process.exitCode = 1;
