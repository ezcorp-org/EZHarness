import { afterAll, expect, test } from "bun:test";
import { buildFirstPartyRelease } from "../../__tests__/helpers/first-party-release";
import { closeTestDb, mockDbConnection, setupTestDb } from "../../__tests__/helpers/test-pglite";

mockDbConnection();
afterAll(closeTestDb);

const geo = { results: [{ name: "Austin", admin1: "Texas", country: "United States", latitude: 30.267, longitude: -97.743, timezone: "America/Chicago" }] };
const weather = { utc_offset_seconds: -18000, current: { time: "2026-07-28T15:04", temperature_2m: 34.2, apparent_temperature: 38.1, relative_humidity_2m: 54.6, wind_speed_10m: 12.4, weather_code: 2, is_day: 1 }, daily: { time: ["2026-07-28"], weather_code: [2], temperature_2m_max: [36], temperature_2m_min: [25], precipitation_probability_max: [10] }, hourly: { time: ["2026-07-28T15:00"], temperature_2m: [34.2], weather_code: [2] } };
const air = { current: { time: "2026-07-28T15:00", alder_pollen: null, birch_pollen: 0.2, grass_pollen: 8.1, mugwort_pollen: null, olive_pollen: null, ragweed_pollen: 1.4 } };

function provider(input: string | URL | Request): Promise<Response> {
  const path = new URL(String(input)).pathname;
  const body = path.includes("search") ? geo : path.includes("air-quality") ? air : weather;
  return Promise.resolve(Response.json(body));
}

for (const probe of [
  { name: "weather", hosts: ["geocoding-api.open-meteo.com", "api.open-meteo.com"], tool: "get_weather", input: { location: "Austin", unit: "celsius" }, valid: (value: any) => value.location?.name === "Austin" && value.current?.temperature === 34.2 },
  { name: "city-conditions", hosts: ["geocoding-api.open-meteo.com", "api.open-meteo.com", "air-quality-api.open-meteo.com", "www.atlantaallergy.com"], tool: "city_conditions", input: { city: "Austin", unit: "celsius" }, valid: (value: any) => value.ok === true && value.weather?.tempC === 34.2 },
]) test(`${probe.name} uses current sandbox fetch authority and recovers after denial`, async () => {
  await setupTestDb();
  const release = await buildFirstPartyRelease(probe.name);
  let denyNetwork = true;
  const session = await release.session({ denyNetwork: () => denyNetwork, networkHosts: probe.hosts, fetchImpl: provider as typeof fetch });
  try {
    const denied = await session.tool(probe.tool, probe.input);
    expect(denied.isError || JSON.parse(denied.content[0]!.text!).ok === false).toBe(true);
    expect(session.failures.some((failure) => failure.startsWith("ezcorp/network.fetch:"))).toBe(true);

    denyNetwork = false;
    const allowed = await session.tool(probe.tool, probe.input);
    expect(allowed.isError).toBe(false);
    expect(probe.valid(JSON.parse(allowed.content[0]!.text!))).toBe(true);
  } finally {
    await session.close();
    await release.close();
  }
}, 180_000);
