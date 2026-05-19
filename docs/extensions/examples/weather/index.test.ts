import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _resetBindingsForTests,
  _setFetchImplForTests,
  buildWeatherPayload,
  tools,
} from "./index";

function expectText(out: unknown): string {
  const first = (out as { content?: Array<{ type: string; text: string }> }).content?.[0];
  if (!first || first.type !== "text") throw new Error("tool-result missing text content");
  return first.text;
}

function expectIsError(out: unknown): boolean {
  return (out as { isError?: boolean }).isError === true;
}

beforeEach(() => {
  _resetBindingsForTests();
});

afterEach(() => {
  _resetBindingsForTests();
});

describe("weather extension", () => {
  test("rejects missing location", async () => {
    const out = await tools.get_weather!({});
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toMatch(/location/i);
  });

  test("rejects invalid unit", async () => {
    const out = await tools.get_weather!({ location: "Paris", unit: "kelvin" });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toMatch(/unit/i);
  });

  test("returns structured weather payload in celsius", async () => {
    let call = 0;
    _setFetchImplForTests((async (input: string | URL | Request) => {
      const url = String(input);
      call += 1;
      if (url.includes("geocoding-api.open-meteo.com")) {
        return new Response(JSON.stringify({
          results: [{
            name: "Paris",
            country: "France",
            admin1: "Ile-de-France",
            latitude: 48.85,
            longitude: 2.35,
            timezone: "Europe/Paris",
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        current: {
          temperature_2m: 19.2,
          apparent_temperature: 18.6,
          weather_code: 2,
          wind_speed_10m: 11.4,
          relative_humidity_2m: 57,
          is_day: 1,
        },
        daily: {
          time: ["2026-06-01", "2026-06-02", "2026-06-03"],
          weather_code: [2, 61, 3],
          temperature_2m_max: [22.1, 20.5, 18.9],
          temperature_2m_min: [14.2, 13.4, 12.8],
          precipitation_probability_max: [10, 80, 20],
        },
        hourly: {
          time: [
            "2026-06-01T10:00",
            "2026-06-01T11:00",
            "2026-06-01T12:00",
            "2026-06-01T13:00",
            "2026-06-01T14:00",
            "2026-06-01T15:00",
          ],
          temperature_2m: [19.2, 19.8, 20.3, 20.7, 21.0, 21.2],
          weather_code: [2, 2, 1, 1, 3, 61],
        },
      }), { status: 200 });
    }) as typeof fetch);

    const out = await tools.get_weather!({ location: "Paris" });
    expect(expectIsError(out)).toBe(false);
    expect(call).toBe(2);

    const payload = JSON.parse(expectText(out));
    expect(payload.location.name).toBe("Paris");
    expect(payload.location.country).toBe("France");
    expect(payload.units.temperature).toBe("°C");
    expect(payload.current.temperature).toBe(19.2);
    expect(payload.current.condition).toBe("Partly cloudy");
    expect(payload.daily).toHaveLength(3);
    expect(payload.daily[0].dayLabel).toBe("Today");
    expect(payload.hourly[0].label).toBe("Now");
    expect(payload._assistant_note).toMatch(/rendered inline/i);
  });

  test("supports fahrenheit units", async () => {
    _setFetchImplForTests((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("geocoding-api.open-meteo.com")) {
        return new Response(JSON.stringify({
          results: [{
            name: "Austin",
            country: "United States",
            admin1: "Texas",
            latitude: 30.26,
            longitude: -97.74,
            timezone: "America/Chicago",
          }],
        }), { status: 200 });
      }
      expect(url).toContain("temperature_unit=fahrenheit");
      expect(url).toContain("wind_speed_unit=mph");
      return new Response(JSON.stringify({
        current: {
          temperature_2m: 79.3,
          apparent_temperature: 81.0,
          weather_code: 0,
          wind_speed_10m: 9.4,
          relative_humidity_2m: 48,
          is_day: 1,
        },
        daily: {
          time: ["2026-06-01", "2026-06-02", "2026-06-03"],
          weather_code: [0, 1, 2],
          temperature_2m_max: [88.1, 90.4, 91.2],
          temperature_2m_min: [71.6, 72.1, 73.0],
          precipitation_probability_max: [0, 10, 20],
        },
        hourly: {
          time: [
            "2026-06-01T10:00",
            "2026-06-01T11:00",
            "2026-06-01T12:00",
            "2026-06-01T13:00",
            "2026-06-01T14:00",
            "2026-06-01T15:00",
          ],
          temperature_2m: [79.3, 80.1, 81.4, 82.0, 82.7, 83.1],
          weather_code: [0, 0, 1, 1, 2, 2],
        },
      }), { status: 200 });
    }) as typeof fetch);

    const out = await tools.get_weather!({ location: "Austin", unit: "fahrenheit" });
    const payload = JSON.parse(expectText(out));
    expect(payload.units.temperature).toBe("°F");
    expect(payload.units.windSpeed).toBe("mph");
    expect(payload.current.condition).toBe("Clear sky");
  });

  test("surfaces geocoder miss as toolError", async () => {
    _setFetchImplForTests((async () => {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as typeof fetch);

    const out = await tools.get_weather!({ location: "Atlantis" });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toMatch(/Atlantis/);
  });
});

describe("buildWeatherPayload", () => {
  test("throws when required forecast fields are missing", () => {
    expect(() => buildWeatherPayload(
      {
        name: "Paris",
        country: "France",
        latitude: 48.85,
        longitude: 2.35,
        timezone: "Europe/Paris",
      },
      {},
      "celsius",
    )).toThrow(/missing required weather fields/);
  });
});
