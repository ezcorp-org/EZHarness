// city-conditions — tool handlers + the shared upstream/banding modules.
//
// The network is NEVER touched: every upstream call goes through the
// injected `fetch` seam in lib/open-meteo.ts. Both the happy paths and
// every failure path in the contract (bad input, city not found, upstream
// down, all-null pollen) are asserted here.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import manifest from "./ezcorp.config";
import {
  ENVELOPE_VERSION,
  _resetGooglePollenKeyResolverForTests,
  _setGooglePollenKeyResolverForTests,
  failureParts,
  resolveGooglePollenApiKey,
  tools,
} from "./index";
import {
  ConditionsError,
  MOLD_UNAVAILABLE,
  _resetBindingsForTests,
  _setFetchImplForTests,
  fetchAirQuality,
  fetchCurrentWeather,
  fetchGooglePollen,
  fetchOpenMeteoAirQuality,
  geocodeCity,
  offsetSuffix,
  parseAtlantaStationReport,
  parseGooglePollenResponse,
  toLocalTime,
  toObservedAt,
  usesAtlantaStation,
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
    time: "2026-07-28T15:00",
    alder_pollen: null,
    birch_pollen: 0.2,
    grass_pollen: 8.1,
    mugwort_pollen: null,
    olive_pollen: null,
    ragweed_pollen: 1.4,
  },
};

const GOOGLE_POLLEN_BODY = {
  regionCode: "US",
  dailyInfo: [{
    date: { year: 2026, month: 7, day: 28 },
    pollenTypeInfo: [
      { code: "TREE", displayName: "Tree", indexInfo: { code: "UPI", value: 4, category: "High" } },
      { code: "GRASS", displayName: "Grass", indexInfo: { code: "UPI", value: 2, category: "Low" } },
      { code: "WEED", displayName: "Weed", indexInfo: { code: "UPI", value: 3, category: "Moderate" } },
    ],
  }],
};

const ATLANTA_GEO_BODY = {
  results: [{
    name: "Atlanta",
    admin1: "Georgia",
    country: "United States",
    latitude: 33.749,
    longitude: -84.388,
    timezone: "America/New_York",
  }],
};

const ATLANTA_STATION_HTML = `
  <h3>Total Pollen Count for 07/29/2026:
    <span class="pollen-num"> 4 </span>
  </h3>
  <h3>Trees (Top Contributors)</h3><p>MULBERRY&nbsp;</p>
  <div><span class="low active">L=0-14</span><span class="medium">M=15-89</span></div>
  <h3>Grass</h3><p>GRASS&nbsp;</p>
  <div><span class="low active">L=0-4</span><span class="medium">M=5-19</span></div>
  <h3>Weeds (Top Contributors)</h3><p>PIGWEED, RAGWEED, PLANTAIN&nbsp;</p>
  <div><span class="low active">L=0-9</span><span class="medium">M=10-49</span></div>
  <hr>
  <h4>Mold Activity for 07/29/2026:</h4>
  <div class="gauge-segments-inner">
    <span class="low">Low</span><span class="medium">Moderate</span>
    <span class="high">High</span><span class="extreme active">Extremely High</span>
  </div>
`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

/** Route by host so a test only overrides the leg it cares about. */
function route(overrides: {
  geo?: () => Response;
  forecast?: () => Response;
  air?: () => Response;
  google?: () => Response;
  station?: () => Response;
} = {}): void {
  _setFetchImplForTests((async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("geocoding-api")) return (overrides.geo ?? (() => json(GEO_BODY)))();
    if (url.includes("atlantaallergy.com")) {
      return (overrides.station ?? (() => html(ATLANTA_STATION_HTML)))();
    }
    if (url.includes("pollen.googleapis.com")) {
      return (overrides.google ?? (() => json(GOOGLE_POLLEN_BODY)))();
    }
    if (url.includes("air-quality-api")) return (overrides.air ?? (() => json(AIR_BODY)))();
    return (overrides.forecast ?? (() => json(FORECAST_BODY)))();
  }) as unknown as typeof fetch);
}

beforeEach(() => {
  _resetBindingsForTests();
  _resetGooglePollenKeyResolverForTests();
});
afterEach(() => {
  _resetBindingsForTests();
  _resetGooglePollenKeyResolverForTests();
});

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
    }) as unknown as typeof fetch);
    const err = await geocodeCity("Austin").catch((e: unknown) => e);
    expect((err as ConditionsError).code).toBe("UPSTREAM_UNAVAILABLE");
    expect((err as ConditionsError).message).toContain("ENOTFOUND");
  });

  test("a non-Error transport throw still surfaces a readable reason", async () => {
    _setFetchImplForTests((async () => {
      throw "socket closed";
    }) as unknown as typeof fetch);
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
    }) as unknown as typeof fetch);
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

describe("Google Pollen API key resolution", () => {
  test("reads and trims the encrypted per-user Storage value", async () => {
    const key = await resolveGooglePollenApiKey({
      get: async () => ({ exists: true, value: "  google-key  " }),
    });
    expect(key).toBe("google-key");
  });

  test("missing, blank, or inaccessible Storage returns no configured key", async () => {
    expect(await resolveGooglePollenApiKey({
      get: async () => ({ exists: false, value: null }),
    })).toBeNull();
    expect(await resolveGooglePollenApiKey({
      get: async () => ({ exists: true, value: "   " }),
    })).toBeNull();
    expect(await resolveGooglePollenApiKey({
      get: async () => { throw new Error("storage denied"); },
    })).toBeNull();
  });
});

describe("allergen providers", () => {
  test("parses Google UPI categories without labeling the index as grains/m³", () => {
    const air = parseGooglePollenResponse(GOOGLE_POLLEN_BODY);
    expect(air.pollen).toMatchObject({
      available: true,
      total: 4,
      unit: "UPI",
      band: "high",
      grains: null,
      observedAt: "2026-07-28",
      source: { id: "google-pollen", kind: "modeled" },
    });
    expect(air.pollen.categories).toEqual([
      { key: "trees", label: "Tree", value: 4, band: "high", contributors: [] },
      { key: "grass", label: "Grass", value: 2, band: "low", contributors: [] },
      { key: "weeds", label: "Weed", value: 3, band: "moderate", contributors: [] },
    ]);
  });

  test("requests Google with coordinates, one day, and the configured key", async () => {
    let seen = "";
    _setFetchImplForTests((async (input: string | URL | Request) => {
      seen = String(input);
      return json(GOOGLE_POLLEN_BODY);
    }) as unknown as typeof fetch);
    await fetchGooglePollen(30.267, -97.743, "secret-key");
    const url = new URL(seen);
    expect(url.hostname).toBe("pollen.googleapis.com");
    expect(url.searchParams.get("key")).toBe("secret-key");
    expect(url.searchParams.get("location.latitude")).toBe("30.267");
    expect(url.searchParams.get("location.longitude")).toBe("-97.743");
    expect(url.searchParams.get("days")).toBe("1");
  });

  test("an empty Google forecast is unavailable rather than zero", () => {
    const air = parseGooglePollenResponse({ dailyInfo: [] });
    expect(air.pollen).toMatchObject({
      available: false,
      total: null,
      unit: "UPI",
      band: "none",
      source: { id: "google-pollen" },
    });
    expect(air.pollen.reason).toContain("no Universal Pollen Index value");
  });

  test("a configured key selects Google before Open-Meteo", async () => {
    let openMeteoCalled = false;
    route({ air: () => { openMeteoCalled = true; return json(AIR_BODY); } });
    const air = await fetchAirQuality(30.267, -97.743, "google-key");
    expect(air.pollen.source?.id).toBe("google-pollen");
    expect(air.pollen.unit).toBe("UPI");
    expect(openMeteoCalled).toBe(false);
  });

  test("a Google outage falls back to available Open-Meteo pollen", async () => {
    route({ google: () => json({}, 503) });
    const air = await fetchAirQuality(30.267, -97.743, "google-key");
    expect(air.pollen.available).toBe(true);
    expect(air.pollen.source?.id).toBe("open-meteo");
  });

  test("Google and Open-Meteo gaps preserve both reasons", async () => {
    route({
      google: () => json({ dailyInfo: [] }),
      air: () => json({ current: { time: "2026-07-28T15:00" } }),
    });
    const air = await fetchAirQuality(30.267, -97.743, "google-key");
    expect(air.pollen.available).toBe(false);
    expect(air.pollen.reason).toContain("Google Pollen API reported no Universal Pollen Index");
    expect(air.pollen.reason).toContain("Open-Meteo pollen is available only in Europe");
  });

  test("keeps missing Open-Meteo grains null, uses grains/m³, and records provenance", async () => {
    route();
    const air = await fetchAirQuality(30.267, -97.743);
    expect(air.pollen.grains).toEqual({
      alder: null, birch: 0.2, grass: 8.1, mugwort: null, olive: null, ragweed: 1.4,
    });
    expect(air.pollen.total).toBe(9.7);
    expect(air.pollen.unit).toBe("grains/m³");
    expect(air.pollen.band).toBe("moderate");
    expect(air.pollen.source?.id).toBe("open-meteo");
    expect(air.pollen.observedAt).toBe("2026-07-28T15:00");
  });

  test("an all-null U.S. grid result is unavailable, never zero", async () => {
    route({ air: () => json({ current: { time: "2026-07-28T15:00" } }) });
    const air = await fetchAirQuality(1, 2);
    expect(air.pollen.available).toBe(false);
    expect(air.pollen.total).toBeNull();
    expect(air.pollen.band).toBe("none");
    expect(air.pollen.reason).toContain("only in Europe during pollen season");
    expect(Object.values(air.pollen.grains ?? {}).every((value) => value === null)).toBe(true);
  });

  test("outside a station area, mold carries a precise unavailable reason", async () => {
    route();
    const air = await fetchAirQuality(1, 2);
    expect(air.mold).toEqual(MOLD_UNAVAILABLE);
    expect(air.mold.available).toBe(false);
    expect(air.mold.count).toBeNull();
    expect(air.mold.reason).toContain("No configured National Allergy Bureau reporting station");
  });

  test("the raw Open-Meteo reader fails loudly on a malformed response", async () => {
    route({ air: () => json({}) });
    await expect(fetchOpenMeteoAirQuality(1, 2)).rejects.toThrow(/"current"/);
  });

  test("a pollen outage degrades the health fields without erasing weather", async () => {
    route({ air: () => json({}, 503) });
    const air = await fetchAirQuality(1, 2);
    expect(air.pollen.available).toBe(false);
    expect(air.pollen.reason).toContain("HTTP 503");
    expect(air.mold.available).toBe(false);
  });

  test("uses the local station only inside the Atlanta metro radius", () => {
    expect(usesAtlantaStation(33.749, -84.388)).toBe(true);
    expect(usesAtlantaStation(33.95, -84.55)).toBe(true);
    expect(usesAtlantaStation(30.267, -97.743)).toBe(false);
  });

  test("parses the NAB-certified Atlanta total, categories, and band-only mold reading", () => {
    const air = parseAtlantaStationReport(ATLANTA_STATION_HTML);
    expect(air.pollen).toMatchObject({
      available: true,
      total: 4,
      unit: "grains/m³",
      band: "low",
      observedAt: "2026-07-29",
      source: { id: "atlanta-allergy", kind: "observed" },
    });
    expect(air.pollen.categories).toEqual([
      { key: "trees", label: "Trees", band: "low", contributors: ["MULBERRY"] },
      { key: "grass", label: "Grass", band: "low", contributors: ["GRASS"] },
      { key: "weeds", label: "Weeds", band: "low", contributors: ["PIGWEED", "RAGWEED", "PLANTAIN"] },
    ]);
    expect(air.mold).toMatchObject({
      available: true,
      count: null,
      band: "very-high",
      observedAt: "2026-07-29",
      source: { id: "atlanta-allergy", kind: "observed" },
    });
    expect(air.mold.reason).toContain("activity band");
  });

  test("rejects a station page with neither report instead of inventing data", () => {
    expect(() => parseAtlantaStationReport("<html>No report today</html>")).toThrow(
      /did not contain a pollen total or mold activity band/,
    );
  });

  test("a partial Atlanta station report keeps pollen and explains missing mold", () => {
    const air = parseAtlantaStationReport(`
      <h3>Total Pollen Count for 07/30/2026:
        <span class="pollen-num"> 12 </span>
      </h3>
      <h3>Trees (Top Contributors)</h3><p>OAK&nbsp;</p>
      <div><span class="low">L=0-14</span><span class="medium active">M=15-89</span></div>
    `);
    expect(air.pollen).toMatchObject({
      available: true,
      total: 12,
      unit: "grains/m³",
      band: "moderate",
      observedAt: "2026-07-30",
      source: { id: "atlanta-allergy" },
    });
    expect(air.mold).toMatchObject({
      available: false,
      count: null,
      band: null,
      observedAt: null,
      source: { id: "atlanta-allergy" },
    });
    expect(air.mold.reason).toContain("did not publish a mold activity band");
  });

  test("Atlanta station failure falls back to Open-Meteo and preserves the reason", async () => {
    route({ station: () => html("down", 503) });
    const air = await fetchAirQuality(33.749, -84.388);
    expect(air.pollen.available).toBe(true);
    expect(air.pollen.source?.id).toBe("open-meteo");
    expect(air.mold.reason).toContain("Atlanta station unavailable");
    expect(air.mold.reason).toContain("HTTP 503");
  });

  test("Atlanta station failure plus all-null Open-Meteo stays unavailable with both reasons", async () => {
    route({
      station: () => html("down", 503),
      air: () => json({ current: { time: "2026-07-30T10:00" } }),
    });
    const air = await fetchAirQuality(33.749, -84.388);
    expect(air.pollen.available).toBe(false);
    expect(air.pollen.source?.id).toBe("open-meteo");
    expect(air.pollen.reason).toContain("Atlanta station unavailable");
    expect(air.pollen.reason).toContain("HTTP 503");
    expect(air.pollen.reason).toContain("only in Europe during pollen season");
    expect(air.mold.available).toBe(false);
    expect(air.mold.reason).toContain("Atlanta station unavailable");
  });

  test("an Atlanta allowlist failure tells the user to approve Website access", async () => {
    route({
      station: () => {
        throw new Error(
          "Extension sandbox: hostname 'www.atlantaallergy.com' is not in the granted network allowlist",
        );
      },
      air: () => json({ current: { time: "2026-07-30T10:00" } }),
    });
    const air = await fetchAirQuality(33.749, -84.388);
    expect(air.pollen.available).toBe(false);
    expect(air.pollen.reason).toContain("Website access to www.atlantaallergy.com is not approved");
    expect(air.pollen.reason).toContain("city-conditions extension's Website access permission");
    expect(air.pollen.reason).toContain("only in Europe during pollen season");
    expect(air.mold.reason).toContain("Website access to www.atlantaallergy.com is not approved");
  });

  test("station plus unconfigured Google plus Open-Meteo failure stays explicit", async () => {
    route({ station: () => html("down", 503), air: () => json({}, 502) });
    const air = await fetchAirQuality(33.749, -84.388);
    expect(air.pollen.available).toBe(false);
    expect(air.mold.available).toBe(false);
    expect(air.pollen.reason).toContain("Pollen providers unavailable");
    expect(air.pollen.reason).toContain("HTTP 503");
    expect(air.pollen.reason).toContain("HTTP 502");
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
        available: true,
        grains: { alder: null, birch: 0.2, grass: 8.1, mugwort: null, olive: null, ragweed: 1.4 },
        total: 9.7,
        unit: "grains/m³",
        band: "moderate",
        categories: [],
        observedAt: "2026-07-28T15:00",
        source: {
          id: "open-meteo",
          name: "Open-Meteo / CAMS",
          url: "https://air-quality-api.open-meteo.com/v1/air-quality",
          kind: "modeled",
        },
        reason: null,
      },
      mold: MOLD_UNAVAILABLE,
    });
  });

  test("a configured Google key gives a U.S. city modeled UPI categories", async () => {
    route();
    _setGooglePollenKeyResolverForTests(async () => "google-key");
    const env = envelope(await tools.city_conditions!({ city: "Austin" }));
    expect(env.ok).toBe(true);
    expect(env.pollen).toMatchObject({
      available: true,
      total: 4,
      unit: "UPI",
      band: "high",
      source: { id: "google-pollen", kind: "modeled" },
    });
    expect((env.pollen as { categories: unknown[] }).categories).toHaveLength(3);
  });

  test("a throwing key resolver degrades pollen instead of failing the whole card", async () => {
    // A revoked or unapproved Storage grant makes the resolver throw. That
    // must not erase valid weather — the card falls through to the keyless
    // provider and reports why Google was skipped.
    route();
    _setGooglePollenKeyResolverForTests(async () => {
      throw new Error("storage grant revoked");
    });
    const env = envelope(await tools.city_conditions!({ city: "Austin" }));
    expect(env.ok).toBe(true);
    expect(env.weather).toMatchObject({ tempC: expect.any(Number) });
    expect(env.pollen).toMatchObject({
      available: true,
      unit: "grains/m³",
      source: { id: "open-meteo" },
    });
  });

  test("Atlanta gets observed station pollen and mold activity instead of Google/CAMS", async () => {
    let airGridCalled = false;
    route({
      geo: () => json(ATLANTA_GEO_BODY),
      air: () => {
        airGridCalled = true;
        return json(AIR_BODY);
      },
    });
    const env = envelope(await tools.city_conditions!({ city: "Atlanta" }));
    expect(env.ok).toBe(true);
    expect(airGridCalled).toBe(false);
    expect(env.pollen).toMatchObject({
      available: true,
      total: 4,
      unit: "grains/m³",
      band: "low",
      source: { id: "atlanta-allergy", kind: "observed" },
    });
    expect(env.mold).toMatchObject({
      available: true,
      count: null,
      band: "very-high",
      source: { id: "atlanta-allergy", kind: "observed" },
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
    }) as unknown as typeof fetch);
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

  test("a dead allergen upstream preserves weather and explains the partial gap", async () => {
    route({ air: () => json({}, 500) });
    const env = envelope(await tools.city_conditions!({ city: "Austin" }));
    expect(env.ok).toBe(true);
    expect((env.weather as { tempC: number }).tempC).toBe(34.2);
    expect(env.pollen).toMatchObject({ available: false, total: null, band: "none" });
    expect((env.pollen as { reason: string }).reason).toContain("HTTP 500");
    expect(env.mold).toMatchObject({ available: false, count: null });
  });

  test("an unexpected throw still becomes a structured failure", async () => {
    const hostile = {
      get ok(): boolean {
        throw "socket detached";
      },
    } as unknown as Response;
    _setFetchImplForTests((async () => hostile) as unknown as typeof fetch);
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
    const pollen = env.pollen as { available: boolean; total: number | null; band: string; reason: string };
    expect(pollen.available).toBe(false);
    expect(pollen.total).toBeNull();
    expect(pollen.band).toBe("none");
    expect(pollen.reason).toContain("only in Europe");
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

  test("allowlists only Open-Meteo, Google Pollen, and the Atlanta station", () => {
    expect([...(manifest.permissions?.network ?? [])].sort()).toEqual([
      "air-quality-api.open-meteo.com",
      "api.open-meteo.com",
      "geocoding-api.open-meteo.com",
      "pollen.googleapis.com",
      "www.atlantaallergy.com",
    ]);
  });

  test("uses Storage for the encrypted Google key, with no shell/filesystem/env", () => {
    const perms = manifest.permissions ?? {};
    expect(perms.storage).toBe(true);
    expect(perms.shell).toBeUndefined();
    expect(perms.filesystem).toBeUndefined();
    expect(perms.env).toBeUndefined();
    expect(manifest.settings?.google_pollen_api_key).toMatchObject({
      type: "secret",
      storageKey: "google-pollen-api-key",
    });
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
