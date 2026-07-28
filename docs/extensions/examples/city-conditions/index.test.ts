// city-conditions — tool handlers + the shared upstream/banding modules.
//
// The network is NEVER touched: every upstream call goes through the
// injected `fetch` seam in lib/open-meteo.ts. Both the happy paths and
// every failure path in the contract (bad input, city not found, upstream
// down, all-null pollen) are asserted here.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import manifest from "./ezcorp.config";
import { ENVELOPE_VERSION, failureParts, tools } from "./index";
import {
  ConditionsError,
  MOLD_UNAVAILABLE,
  _resetBindingsForTests,
  _setFetchImplForTests,
  fetchAirQuality,
  fetchCurrentWeather,
  geocodeCity,
  offsetSuffix,
  toLocalTime,
  toObservedAt,
  wmoLabel,
} from "./lib/open-meteo";
import { pollenBand, totalPollenIndex } from "./lib/pollen-bands";

// ── Helpers ──────────────────────────────────────────────────────────

interface ToolOut {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function text(out: unknown): string {
  const first = (out as ToolOut).content?.[0];
  if (!first || first.type !== "text") throw new Error("tool result had no text content");
  return first.text;
}

function isError(out: unknown): boolean {
  return (out as ToolOut).isError === true;
}

function envelope(out: unknown): Record<string, unknown> {
  return JSON.parse(text(out)) as Record<string, unknown>;
}

const GEO_BODY = {
  results: [{
    name: "Austin",
    admin1: "Texas",
    country: "United States",
    latitude: 30.267,
    longitude: -97.743,
    timezone: "America/Chicago",
  }],
};

const FORECAST_BODY = {
  utc_offset_seconds: -18000,
  current: {
    time: "2026-07-28T15:04",
    temperature_2m: 34.2,
    apparent_temperature: 38.1,
    relative_humidity_2m: 54.6,
    wind_speed_10m: 12.4,
    weather_code: 2,
    is_day: 1,
  },
};

const AIR_BODY = {
  current: {
    alder_pollen: null,
    birch_pollen: 0.2,
    grass_pollen: 8.1,
    mugwort_pollen: null,
    olive_pollen: null,
    ragweed_pollen: 1.4,
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Route by host so a test only overrides the leg it cares about. */
function route(overrides: {
  geo?: () => Response;
  forecast?: () => Response;
  air?: () => Response;
} = {}): void {
  _setFetchImplForTests((async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("geocoding-api")) return (overrides.geo ?? (() => json(GEO_BODY)))();
    if (url.includes("air-quality-api")) return (overrides.air ?? (() => json(AIR_BODY)))();
    return (overrides.forecast ?? (() => json(FORECAST_BODY)))();
  }) as typeof fetch);
}

beforeEach(() => _resetBindingsForTests());
afterEach(() => _resetBindingsForTests());

// ── lib/pollen-bands.ts ──────────────────────────────────────────────

describe("pollen banding", () => {
  test("totals only the non-null grains, to 1dp", () => {
    const total = totalPollenIndex({
      alder: null, birch: 0.25, grass: 8.1, mugwort: null, olive: null, ragweed: 1.4,
    });
    expect(total).toBe(9.8);
  });

  test("an all-null reading totals to null, not zero", () => {
    const total = totalPollenIndex({
      alder: null, birch: null, grass: null, mugwort: null, olive: null, ragweed: null,
    });
    expect(total).toBeNull();
  });

  test("maps every band boundary", () => {
    expect(pollenBand(null)).toBe("none");
    expect(pollenBand(0)).toBe("low");
    expect(pollenBand(0.99)).toBe("low");
    expect(pollenBand(1)).toBe("moderate");
    expect(pollenBand(19.9)).toBe("moderate");
    expect(pollenBand(20)).toBe("high");
    expect(pollenBand(99.9)).toBe("high");
    expect(pollenBand(100)).toBe("very-high");
    expect(pollenBand(5000)).toBe("very-high");
  });
});

// ── lib/open-meteo.ts — pure helpers ─────────────────────────────────

describe("time + label helpers", () => {
  test("wmoLabel names known codes and refuses to guess unknown ones", () => {
    expect(wmoLabel(0)).toBe("Clear sky");
    expect(wmoLabel(2)).toBe("Partly cloudy");
    expect(wmoLabel(99)).toBe("Thunderstorm with heavy hail");
    expect(wmoLabel(4242)).toBe("Unknown conditions");
  });

  test("offsetSuffix formats both signs and sub-hour offsets", () => {
    expect(offsetSuffix(-18000)).toBe("-05:00");
    expect(offsetSuffix(0)).toBe("+00:00");
    expect(offsetSuffix(19800)).toBe("+05:30");
  });

  test("toObservedAt pins the place's offset onto a zone-local stamp", () => {
    expect(toObservedAt("2026-07-28T15:04", -18000)).toBe("2026-07-28T15:04:00-05:00");
    // Already carries seconds — must not gain a second `:00`.
    expect(toObservedAt("2026-07-28T15:04:30", -18000)).toBe("2026-07-28T15:04:30-05:00");
  });

  test("toLocalTime renders a 12-hour clock", () => {
    expect(toLocalTime("2026-07-28T15:04")).toBe("3:04 PM");
    expect(toLocalTime("2026-07-28T00:07")).toBe("12:07 AM");
    expect(toLocalTime("2026-07-28T12:00")).toBe("12:00 PM");
    expect(toLocalTime("2026-07-28T09:30")).toBe("9:30 AM");
  });
});

// ── lib/open-meteo.ts — upstream calls ───────────────────────────────

describe("geocodeCity", () => {
  test("returns the first match", async () => {
    route();
    const place = await geocodeCity("Austin");
    expect(place).toEqual({
      name: "Austin",
      admin1: "Texas",
      country: "United States",
      latitude: 30.267,
      longitude: -97.743,
      timezone: "America/Chicago",
    });
  });

  test("omits admin1 entirely when the provider has none, and defaults a missing country", async () => {
    route({
      geo: () => json({
        results: [{ name: "Tokyo", latitude: 35.6, longitude: 139.7, timezone: "Asia/Tokyo" }],
      }),
    });
    const place = await geocodeCity("Tokyo");
    expect("admin1" in place).toBe(false);
    expect(place.country).toBe("");
  });

  test("an empty result set is CITY_NOT_FOUND, naming the query", async () => {
    route({ geo: () => json({ results: [] }) });
    const err = await geocodeCity("Atlantis").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConditionsError);
    expect((err as ConditionsError).code).toBe("CITY_NOT_FOUND");
    expect((err as ConditionsError).message).toContain("Atlantis");
  });

  test("a missing results key is CITY_NOT_FOUND", async () => {
    route({ geo: () => json({}) });
    const err = await geocodeCity("Nowhere").catch((e: unknown) => e);
    expect((err as ConditionsError).code).toBe("CITY_NOT_FOUND");
  });

  test("a non-2xx status is UPSTREAM_UNAVAILABLE and reports the status", async () => {
    route({ geo: () => json({}, 503) });
    const err = await geocodeCity("Austin").catch((e: unknown) => e);
    expect((err as ConditionsError).code).toBe("UPSTREAM_UNAVAILABLE");
    expect((err as ConditionsError).message).toContain("503");
  });

  test("a transport failure is UPSTREAM_UNAVAILABLE and keeps the cause", async () => {
    _setFetchImplForTests((async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch);
    const err = await geocodeCity("Austin").catch((e: unknown) => e);
    expect((err as ConditionsError).code).toBe("UPSTREAM_UNAVAILABLE");
    expect((err as ConditionsError).message).toContain("ENOTFOUND");
  });

  test("a non-Error transport throw still surfaces a readable reason", async () => {
    _setFetchImplForTests((async () => {
      throw "socket closed";
    }) as typeof fetch);
    const err = await geocodeCity("Austin").catch((e: unknown) => e);
    expect((err as ConditionsError).message).toContain("socket closed");
  });

  test("unparseable JSON is UPSTREAM_UNAVAILABLE", async () => {
    route({ geo: () => new Response("<html>502</html>", { status: 200 }) });
    const err = await geocodeCity("Austin").catch((e: unknown) => e);
    expect((err as ConditionsError).code).toBe("UPSTREAM_UNAVAILABLE");
    expect((err as ConditionsError).message).toContain("unreadable JSON");
  });

  test("a non-object payload is UPSTREAM_UNAVAILABLE", async () => {
    route({ geo: () => json([1, 2, 3]) });
    const err = await geocodeCity("Austin").catch((e: unknown) => e);
    expect((err as ConditionsError).message).toContain("non-object payload");
  });

  test("a match missing its name / timezone / latitude fails loudly", async () => {
    route({ geo: () => json({ results: [{ latitude: 1, longitude: 2, timezone: "UTC" }] }) });
    await expect(geocodeCity("x")).rejects.toThrow(/"name"/);

    route({ geo: () => json({ results: [{ name: "X", latitude: 1, longitude: 2 }] }) });
    await expect(geocodeCity("x")).rejects.toThrow(/"timezone"/);

    route({ geo: () => json({ results: [{ name: "X", timezone: "UTC", longitude: 2 }] }) });
    await expect(geocodeCity("x")).rejects.toThrow(/"latitude"/);
  });
});

describe("fetchCurrentWeather", () => {
  test("builds the observation with a place-local timestamp", async () => {
    route();
    const observed = await fetchCurrentWeather(30.267, -97.743);
    expect(observed).toEqual({
      observedAt: "2026-07-28T15:04:00-05:00",
      localTime: "3:04 PM",
      weather: {
        tempC: 34.2,
        feelsLikeC: 38.1,
        humidityPct: 55,
        windKph: 12.4,
        code: 2,
        label: "Partly cloudy",
        isDay: true,
      },
    });
  });

  test("requests celsius and km/h regardless of any display preference", async () => {
    let seen = "";
    _setFetchImplForTests((async (input: string | URL | Request) => {
      seen = String(input);
      return json(FORECAST_BODY);
    }) as typeof fetch);
    await fetchCurrentWeather(1, 2);
    expect(seen).toContain("temperature_unit=celsius");
    expect(seen).toContain("wind_speed_unit=kmh");
    expect(seen).toContain("timezone=auto");
  });

  test("is_day 0 reads as night", async () => {
    const body = { ...FORECAST_BODY, current: { ...FORECAST_BODY.current, is_day: 0 } };
    route({ forecast: () => json(body) });
    const observed = await fetchCurrentWeather(1, 2);
    expect(observed.weather.isDay).toBe(false);
  });

  test("a response without `current` fails loudly", async () => {
    route({ forecast: () => json({ utc_offset_seconds: 0 }) });
    await expect(fetchCurrentWeather(1, 2)).rejects.toThrow(/"current"/);
  });

  test("a malformed `current.time` fails loudly", async () => {
    const body = { ...FORECAST_BODY, current: { ...FORECAST_BODY.current, time: "soon" } };
    route({ forecast: () => json(body) });
    await expect(fetchCurrentWeather(1, 2)).rejects.toThrow(/current\.time/);
  });

  test("a missing utc offset fails loudly rather than assuming UTC", async () => {
    route({ forecast: () => json({ current: FORECAST_BODY.current }) });
    await expect(fetchCurrentWeather(1, 2)).rejects.toThrow(/utc_offset_seconds/);
  });
});

describe("fetchAirQuality", () => {
  test("keeps missing grains null and bands the measured total", async () => {
    route();
    const air = await fetchAirQuality(30.267, -97.743);
    expect(air.pollen.grains).toEqual({
      alder: null, birch: 0.2, grass: 8.1, mugwort: null, olive: null, ragweed: 1.4,
    });
    expect(air.pollen.totalIndex).toBe(9.7);
    expect(air.pollen.band).toBe("moderate");
  });

  test("an all-null reading yields totalIndex null and band none — never a zero", async () => {
    route({ air: () => json({ current: { time: "2026-07-28T15:00" } }) });
    const air = await fetchAirQuality(1, 2);
    expect(air.pollen.totalIndex).toBeNull();
    expect(air.pollen.band).toBe("none");
    expect(Object.values(air.pollen.grains).every((v) => v === null)).toBe(true);
  });

  test("always carries the mold block, present and honest", async () => {
    route();
    const air = await fetchAirQuality(1, 2);
    expect(air.mold).toEqual(MOLD_UNAVAILABLE);
    expect(air.mold.available).toBe(false);
    expect(air.mold.count).toBeNull();
    expect(air.mold.reason).toContain("Open-Meteo does not publish mold spore counts");
  });

  test("a response without `current` fails loudly", async () => {
    route({ air: () => json({}) });
    await expect(fetchAirQuality(1, 2)).rejects.toThrow(/"current"/);
  });
});

// ── index.ts — the chat tool ─────────────────────────────────────────

describe("city_conditions", () => {
  test("returns the full envelope for a city", async () => {
    route();
    const out = await tools.city_conditions!({ city: "  Austin  " });
    expect(isError(out)).toBe(false);
    expect(envelope(out)).toEqual({
      v: ENVELOPE_VERSION,
      ok: true,
      place: {
        name: "Austin",
        admin1: "Texas",
        country: "United States",
        latitude: 30.267,
        longitude: -97.743,
        timezone: "America/Chicago",
      },
      unit: "celsius",
      observedAt: "2026-07-28T15:04:00-05:00",
      localTime: "3:04 PM",
      weather: {
        tempC: 34.2,
        feelsLikeC: 38.1,
        humidityPct: 55,
        windKph: 12.4,
        code: 2,
        label: "Partly cloudy",
        isDay: true,
      },
      pollen: {
        grains: { alder: null, birch: 0.2, grass: 8.1, mugwort: null, olive: null, ragweed: 1.4 },
        totalIndex: 9.7,
        band: "moderate",
      },
      mold: {
        available: false,
        reason: "No keyless provider. Open-Meteo does not publish mold spore counts.",
        count: null,
        band: null,
      },
    });
  });

  test("fahrenheit selects the DISPLAY unit only — readings stay celsius", async () => {
    route();
    const env = envelope(await tools.city_conditions!({ city: "Austin", unit: "fahrenheit" }));
    expect(env.unit).toBe("fahrenheit");
    expect((env.weather as { tempC: number }).tempC).toBe(34.2);
  });

  test("fetches weather and air quality concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    _setFetchImplForTests((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("geocoding-api")) return json(GEO_BODY);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return json(url.includes("air-quality-api") ? AIR_BODY : FORECAST_BODY);
    }) as typeof fetch);
    await tools.city_conditions!({ city: "Austin" });
    expect(maxInFlight).toBe(2);
  });

  test("a missing city is a RENDERABLE BAD_INPUT envelope, not an error result", async () => {
    route();
    const out = await tools.city_conditions!({});
    expect(isError(out)).toBe(false);
    expect(envelope(out)).toEqual({
      v: ENVELOPE_VERSION,
      ok: false,
      code: "BAD_INPUT",
      error: "'city' is required and must be a non-empty string",
    });
  });

  test("a blank city is BAD_INPUT (the smokeTest's exact round trip)", async () => {
    route();
    const out = await tools.city_conditions!({ city: "   " });
    expect(isError(out)).toBe(false);
    expect(text(out)).toContain('"code":"BAD_INPUT"');
  });

  test("an unsupported unit is BAD_INPUT", async () => {
    route();
    const env = envelope(await tools.city_conditions!({ city: "Austin", unit: "kelvin" }));
    expect(env.ok).toBe(false);
    expect(env.code).toBe("BAD_INPUT");
    expect(env.error).toContain("unit");
  });

  test("an unknown city is a CITY_NOT_FOUND envelope", async () => {
    route({ geo: () => json({ results: [] }) });
    const env = envelope(await tools.city_conditions!({ city: "Atlantis" }));
    expect(env.ok).toBe(false);
    expect(env.code).toBe("CITY_NOT_FOUND");
  });

  test("a dead upstream is an UPSTREAM_UNAVAILABLE envelope, never a blank success", async () => {
    route({ air: () => json({}, 500) });
    const env = envelope(await tools.city_conditions!({ city: "Austin" }));
    expect(env.ok).toBe(false);
    expect(env.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(env.error).toContain("air-quality");
    // The failure envelope carries NO half-filled readings.
    expect(env.weather).toBeUndefined();
    expect(env.pollen).toBeUndefined();
  });

  test("an unexpected throw still becomes a structured failure", async () => {
    const hostile = {
      get ok(): boolean {
        throw "socket detached";
      },
    } as unknown as Response;
    _setFetchImplForTests((async () => hostile) as typeof fetch);
    const env = envelope(await tools.city_conditions!({ city: "Austin" }));
    expect(env.ok).toBe(false);
    expect(env.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(env.error).toBe("socket detached");
  });
});

describe("failureParts", () => {
  test("keeps a ConditionsError's own code", () => {
    expect(failureParts(new ConditionsError("CITY_NOT_FOUND", "nope"))).toEqual({
      code: "CITY_NOT_FOUND",
      error: "nope",
    });
  });

  test("falls back to UPSTREAM_UNAVAILABLE for anything else", () => {
    expect(failureParts(new Error("boom"))).toEqual({
      code: "UPSTREAM_UNAVAILABLE",
      error: "boom",
    });
  });
});

// ── index.ts — the granular workflow tools ───────────────────────────

describe("granular workflow tools", () => {
  test("geocode returns a place envelope", async () => {
    route();
    const out = await tools.geocode!({ city: "Austin" });
    expect(isError(out)).toBe(false);
    const env = envelope(out);
    expect(env.ok).toBe(true);
    expect((env.place as { name: string }).name).toBe("Austin");
  });

  test("geocode FAILS LOUDLY so a workflow step throws with the reason", async () => {
    route({ geo: () => json({ results: [] }) });
    const out = await tools.geocode!({ city: "Atlantis" });
    expect(isError(out)).toBe(true);
    expect(text(out)).toContain("[CITY_NOT_FOUND]");
    expect(text(out)).toContain("Atlantis");
  });

  test("geocode rejects a missing city", async () => {
    const out = await tools.geocode!({});
    expect(isError(out)).toBe(true);
    expect(text(out)).toContain("[BAD_INPUT]");
  });

  test("current_weather returns the observation the report step maps", async () => {
    route();
    const env = envelope(await tools.current_weather!({ latitude: 30.267, longitude: -97.743 }));
    expect(env.ok).toBe(true);
    expect(env.localTime).toBe("3:04 PM");
    expect((env.weather as { label: string }).label).toBe("Partly cloudy");
  });

  test("current_weather rejects out-of-range or non-numeric coordinates", async () => {
    const noLat = await tools.current_weather!({ longitude: 1 });
    expect(isError(noLat)).toBe(true);
    expect(text(noLat)).toContain("latitude");

    const badLat = await tools.current_weather!({ latitude: 91, longitude: 1 });
    expect(text(badLat)).toContain("latitude");

    const badLon = await tools.current_weather!({ latitude: 1, longitude: 181 });
    expect(text(badLon)).toContain("longitude");
  });

  test("current_weather surfaces an upstream failure as a step failure", async () => {
    route({ forecast: () => json({}, 502) });
    const out = await tools.current_weather!({ latitude: 1, longitude: 2 });
    expect(isError(out)).toBe(true);
    expect(text(out)).toContain("[UPSTREAM_UNAVAILABLE]");
  });

  test("air_quality returns pollen plus the mold block", async () => {
    route();
    const env = envelope(await tools.air_quality!({ latitude: 30.267, longitude: -97.743 }));
    expect(env.ok).toBe(true);
    expect((env.pollen as { band: string }).band).toBe("moderate");
    expect((env.mold as { available: boolean }).available).toBe(false);
  });

  test("air_quality reports an all-null reading honestly", async () => {
    route({ air: () => json({ current: {} }) });
    const env = envelope(await tools.air_quality!({ latitude: 1, longitude: 2 }));
    const pollen = env.pollen as { totalIndex: number | null; band: string };
    expect(pollen.totalIndex).toBeNull();
    expect(pollen.band).toBe("none");
  });

  test("air_quality rejects a bad coordinate", async () => {
    const out = await tools.air_quality!({ latitude: 1 });
    expect(isError(out)).toBe(true);
    expect(text(out)).toContain("longitude");
  });
});

// ── Manifest ↔ implementation ────────────────────────────────────────

describe("manifest", () => {
  test("declares exactly the four implemented tools", () => {
    const declared = (manifest.tools ?? []).map((t) => t.name).sort();
    expect(declared).toEqual(["air_quality", "city_conditions", "current_weather", "geocode"]);
    expect(Object.keys(tools).sort()).toEqual(declared);
  });

  test("allowlists exactly the three Open-Meteo hosts and nothing else", () => {
    expect([...(manifest.permissions?.network ?? [])].sort()).toEqual([
      "air-quality-api.open-meteo.com",
      "api.open-meteo.com",
      "geocoding-api.open-meteo.com",
    ]);
  });

  test("takes no shell, filesystem, env or storage", () => {
    const perms = manifest.permissions ?? {};
    expect(perms.shell).toBeUndefined();
    expect(perms.filesystem).toBeUndefined();
    expect(perms.env).toBeUndefined();
    expect(perms.storage).toBeUndefined();
  });

  test("declares the shipped workflow so it is triggerable", () => {
    expect(manifest.permissions?.workflows).toEqual({
      names: ["conditions"],
      maxRunsPerHour: 12,
    });
  });

  test("the smokeTest names a real tool and round-trips a real result", async () => {
    const smoke = manifest.smokeTest;
    expect(smoke).toBeDefined();
    expect(Object.keys(tools)).toContain(smoke!.tool);
    const out = await tools[smoke!.tool]!(smoke!.input);
    expect(isError(out)).toBe(smoke!.expect.isError === true);
    expect(text(out)).toContain(smoke!.expect.textIncludes!);
  });

  test("routes the chat tool to the city-conditions card", () => {
    const chat = (manifest.tools ?? []).find((t) => t.name === "city_conditions");
    expect(chat?.cardType).toBe("city-conditions");
  });
});
