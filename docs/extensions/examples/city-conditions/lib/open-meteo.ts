/**
 * Upstream layer for city-conditions.
 *
 * Weather and general pollen coverage come from Open-Meteo. For the Atlanta
 * metro, allergen observations come from Atlanta Allergy & Asthma's
 * National Allergy Bureau-certified station. That station is both more local
 * than a forecast grid and the only keyless source in this provider set that
 * publishes a mold activity reading.
 *
 * Provider policy:
 *   - weather/geocoding failures are fatal because a conditions card cannot
 *     identify the place or render its primary reading;
 *   - allergen failures are data-level unavailability, not card-level
 *     failures. Weather still renders with a precise reason for each missing
 *     health field;
 *   - no missing number is converted to zero, and a mold activity band is
 *     never presented as a measured spore count.
 */
import {
  POLLEN_GRAINS,
  type PollenBand,
  type PollenGrain,
  type PollenGrains,
  pollenBand,
  totalPollenIndex,
} from "./pollen-bands";

// ── Upstream endpoints ───────────────────────────────────────────────

export const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
export const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
export const AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
export const ATLANTA_STATION_URL = "https://www.atlantaallergy.com/pollen_counts";

export const ATLANTA_STATION = {
  latitude: 33.749,
  longitude: -84.388,
  /** Roughly 50 miles: the source describes this as the Atlanta-area station. */
  coverageRadiusKm: 80,
} as const;

/** The three failure codes the result envelope may carry. */
export type FailureCode = "CITY_NOT_FOUND" | "UPSTREAM_UNAVAILABLE" | "BAD_INPUT";

/** An upstream/input failure with the contract code already decided. */
export class ConditionsError extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode, message: string) {
    super(message);
    this.name = "ConditionsError";
    this.code = code;
  }
}

// ── Envelope pieces ──────────────────────────────────────────────────

export interface Place {
  name: string;
  admin1?: string;
  country: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

export interface WeatherReading {
  /** ALWAYS celsius. Display conversion is the card's job. */
  tempC: number;
  feelsLikeC: number;
  humidityPct: number;
  windKph: number;
  /** WMO weather-interpretation code. */
  code: number;
  label: string;
  isDay: boolean;
}

export interface WeatherObservation {
  /** ISO 8601 with the PLACE's UTC offset, not the server's. */
  observedAt: string;
  /** Preformatted place-local clock time, e.g. `3:04 PM`. */
  localTime: string;
  weather: WeatherReading;
}

export interface AllergenSource {
  id: "open-meteo" | "atlanta-allergy";
  name: string;
  url: string;
  kind: "modeled" | "observed";
  certification?: string;
}

export interface PollenCategoryReading {
  key: "trees" | "grass" | "weeds";
  label: string;
  band: PollenBand;
  contributors: string[];
}

export interface PollenReading {
  available: boolean;
  /** Per-grain values when the provider publishes them; null for station totals. */
  grains: PollenGrains | null;
  /** A concentration/count, never a provider-specific normalized index. */
  total: number | null;
  unit: "grains/m³";
  band: PollenBand;
  categories: PollenCategoryReading[];
  /** Provider-local observation/model timestamp. */
  observedAt: string | null;
  source: AllergenSource | null;
  reason: string | null;
}

export interface MoldReading {
  available: boolean;
  reason: string | null;
  /** Null when a source publishes only an activity band. */
  count: number | null;
  unit: "spores/m³" | null;
  band: PollenBand | null;
  observedAt: string | null;
  source: AllergenSource | null;
}

export interface AirObservation {
  pollen: PollenReading;
  mold: MoldReading;
}

export const OPEN_METEO_SOURCE: AllergenSource = {
  id: "open-meteo",
  name: "Open-Meteo / CAMS",
  url: AIR_QUALITY_URL,
  kind: "modeled",
};

export const ATLANTA_ALLERGY_SOURCE: AllergenSource = {
  id: "atlanta-allergy",
  name: "Atlanta Allergy & Asthma",
  url: ATLANTA_STATION_URL,
  kind: "observed",
  certification: "National Allergy Bureau-certified station",
};

const OPEN_METEO_COVERAGE_REASON =
  "Open-Meteo pollen is available only in Europe during pollen season; it reported no value for this location and time.";
const ATLANTA_STATION_PERMISSION_REASON =
  "Website access to www.atlantaallergy.com is not approved. Approve the city-conditions extension's Website access permission, then retry.";
const NO_LOCAL_MOLD_REASON =
  "No reporting-station mold source is configured for this location; forecast APIs do not provide a measured mold-spore count.";
const STATION_BAND_ONLY_REASON =
  "The station publishes a mold activity band, not a numeric spore count.";

function emptyGrains(): PollenGrains {
  return Object.fromEntries(POLLEN_GRAINS.map((grain) => [grain, null])) as PollenGrains;
}

function unavailablePollen(reason: string, source: AllergenSource | null): PollenReading {
  return {
    available: false,
    grains: emptyGrains(),
    total: null,
    unit: "grains/m³",
    band: "none",
    categories: [],
    observedAt: null,
    source,
    reason,
  };
}

function unavailableMold(reason: string, source: AllergenSource | null = null): MoldReading {
  return {
    available: false,
    reason,
    count: null,
    unit: null,
    band: null,
    observedAt: null,
    source,
  };
}

/** Honest default used when no station mold reading is available. */
export const MOLD_UNAVAILABLE: MoldReading = unavailableMold(NO_LOCAL_MOLD_REASON);

// ── Test seam ────────────────────────────────────────────────────────

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = fetch;

/** Redirect upstream calls in unit tests. The suite never hits the network. */
export function _setFetchImplForTests(fake: FetchLike): void {
  fetchImpl = fake;
}

/** Restore the real (sandbox-wrapped) global fetch. */
export function _resetBindingsForTests(): void {
  fetchImpl = fetch;
}

// ── WMO weather codes → human label ──────────────────────────────────

const WMO_LABELS: Record<number, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  56: "Light freezing drizzle", 57: "Dense freezing drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snowfall", 73: "Moderate snowfall", 75: "Heavy snowfall", 77: "Snow grains",
  80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
  85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
};

/** Label for a WMO code. Unknown codes are named as such, never guessed. */
export function wmoLabel(code: number): string {
  return WMO_LABELS[code] ?? "Unknown conditions";
}

// ── Small pure helpers ───────────────────────────────────────────────

/** `-18000` → `-05:00`. The offset the PLACE is on, from the provider. */
export function offsetSuffix(utcOffsetSeconds: number): string {
  const sign = utcOffsetSeconds < 0 ? "-" : "+";
  const abs = Math.abs(utcOffsetSeconds);
  const hours = String(Math.floor(abs / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((abs % 3600) / 60)).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

/** Attach the place's UTC offset to Open-Meteo's zone-local timestamp. */
export function toObservedAt(localIso: string, utcOffsetSeconds: number): string {
  const withSeconds = localIso.length === 16 ? `${localIso}:00` : localIso;
  return `${withSeconds}${offsetSuffix(utcOffsetSeconds)}`;
}

/** `2026-07-28T15:04` → `3:04 PM`. */
export function toLocalTime(localIso: string): string {
  const hour = Number(localIso.slice(11, 13));
  const minute = localIso.slice(14, 16);
  const twelve = ((hour + 11) % 12) + 1;
  return `${twelve}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
}

/** Great-circle distance used to keep the local station fallback local. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function usesAtlantaStation(latitude: number, longitude: number): boolean {
  return distanceKm(
    latitude,
    longitude,
    ATLANTA_STATION.latitude,
    ATLANTA_STATION.longitude,
  ) <= ATLANTA_STATION.coverageRadiusKm;
}

// ── Response readers ─────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function requireNumber(source: Record<string, unknown>, field: string, what: string): number {
  const raw = source[field];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new ConditionsError("UPSTREAM_UNAVAILABLE", `${what} response is missing a usable "${field}"`);
  }
  return raw;
}

/** A grain reading, or `null` when the provider published nothing for it. */
function readGrain(current: Record<string, unknown>, grain: PollenGrain): number | null {
  const raw = current[`${grain}_pollen`];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

async function request(url: string, what: string, accept: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        Accept: accept,
        "User-Agent": "EZCorp city-conditions/0.2",
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConditionsError("UPSTREAM_UNAVAILABLE", `${what} request failed: ${detail}`);
  }
  if (!res.ok) {
    throw new ConditionsError("UPSTREAM_UNAVAILABLE", `${what} returned HTTP ${res.status}`);
  }
  return res;
}

async function getJson(url: URL, what: string): Promise<Record<string, unknown>> {
  const res = await request(url.toString(), what, "application/json");
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConditionsError("UPSTREAM_UNAVAILABLE", `${what} returned unreadable JSON: ${detail}`);
  }
  const record = asRecord(body);
  if (!record) {
    throw new ConditionsError("UPSTREAM_UNAVAILABLE", `${what} returned a non-object payload`);
  }
  return record;
}

async function getText(url: string, what: string): Promise<string> {
  const res = await request(url, what, "text/html");
  try {
    return await res.text();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConditionsError("UPSTREAM_UNAVAILABLE", `${what} returned unreadable text: ${detail}`);
  }
}

// ── Atlanta station HTML parser ──────────────────────────────────────

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function usDateToIso(value: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return `${match[3]}-${match[1]}-${match[2]}`;
}

function activeBand(fragment: string): PollenBand | null {
  const spans = fragment.matchAll(/<span\s+class=["']([^"']*\bactive\b[^"']*)["'][^>]*>([\s\S]*?)<\/span>/gi);
  for (const match of spans) {
    const className = (match[1] ?? "").toLowerCase();
    const text = decodeHtml(match[2] ?? "").toLowerCase();
    if (/\bextreme\b/.test(className) || text.includes("extremely")) return "very-high";
    if (/\bhigh\b/.test(className)) return "high";
    if (/\bmedium\b|\bmoderate\b/.test(className)) return "moderate";
    if (/\blow\b/.test(className)) return "low";
  }
  return null;
}

function categorySection(
  html: string,
  key: PollenCategoryReading["key"],
  label: string,
  heading: RegExp,
): PollenCategoryReading | null {
  const start = html.search(heading);
  if (start < 0) return null;
  const tail = html.slice(start);
  const paragraph = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(tail);
  const boundary = tail.slice(1).search(/<h3\b|<hr\b/i);
  const fragment = boundary < 0 ? tail : tail.slice(0, boundary + 1);
  const band = activeBand(fragment);
  if (!band) return null;
  const contributors = paragraph
    ? decodeHtml(paragraph[1] ?? "").split(",").map((item) => item.trim()).filter(Boolean)
    : [];
  return { key, label, band, contributors };
}

function maxCategoryBand(categories: PollenCategoryReading[]): PollenBand {
  const rank: Record<PollenBand, number> = {
    none: 0,
    unknown: 0,
    low: 1,
    moderate: 2,
    high: 3,
    "very-high": 4,
  };
  return categories.reduce<PollenBand>(
    (highest, category) => rank[category.band] > rank[highest] ? category.band : highest,
    "unknown",
  );
}

/** Parse the server-rendered, robots-allowed Atlanta station report. */
export function parseAtlantaStationReport(html: string): AirObservation {
  const totalMatch = /Total Pollen Count for\s+(\d{2}\/\d{2}\/\d{4}):[\s\S]*?class=["']pollen-num["'][^>]*>\s*([\d,.]+)\s*</i.exec(html);
  const categories = [
    categorySection(html, "trees", "Trees", /<h3[^>]*>\s*Trees(?:\s*\(Top Contributors\))?\s*<\/h3>/i),
    categorySection(html, "grass", "Grass", /<h3[^>]*>\s*Grass\s*<\/h3>/i),
    categorySection(html, "weeds", "Weeds", /<h3[^>]*>\s*Weeds(?:\s*\(Top Contributors\))?\s*<\/h3>/i),
  ].filter((value): value is PollenCategoryReading => value !== null);

  const totalRaw = totalMatch?.[2];
  const pollenDateRaw = totalMatch?.[1];
  const total = totalRaw === undefined ? null : Number(totalRaw.replaceAll(",", ""));
  const pollenDate = pollenDateRaw === undefined ? null : usDateToIso(pollenDateRaw);
  const pollenAvailable = total !== null && Number.isFinite(total);

  const moldMatch = /Mold Activity for\s+(\d{2}\/\d{2}\/\d{4}):[\s\S]*?<div\s+class=["']gauge-segments-inner["'][^>]*>([\s\S]*?)<\/div>/i.exec(html);
  const moldFragment = moldMatch?.[2];
  const moldDateRaw = moldMatch?.[1];
  const moldBand = moldFragment === undefined ? null : activeBand(moldFragment);
  const moldDate = moldDateRaw === undefined ? null : usDateToIso(moldDateRaw);

  if (!pollenAvailable && !moldBand) {
    throw new ConditionsError(
      "UPSTREAM_UNAVAILABLE",
      "Atlanta station page did not contain a pollen total or mold activity band",
    );
  }

  return {
    pollen: pollenAvailable
      ? {
          available: true,
          grains: null,
          total,
          unit: "grains/m³",
          band: maxCategoryBand(categories),
          categories,
          observedAt: pollenDate,
          source: ATLANTA_ALLERGY_SOURCE,
          reason: null,
        }
      : unavailablePollen("The Atlanta station did not publish a pollen total for this report.", ATLANTA_ALLERGY_SOURCE),
    mold: moldBand
      ? {
          available: true,
          reason: STATION_BAND_ONLY_REASON,
          count: null,
          unit: null,
          band: moldBand,
          observedAt: moldDate,
          source: ATLANTA_ALLERGY_SOURCE,
        }
      : unavailableMold("The Atlanta station did not publish a mold activity band for this report.", ATLANTA_ALLERGY_SOURCE),
  };
}

export async function fetchAtlantaStation(): Promise<AirObservation> {
  return parseAtlantaStationReport(await getText(ATLANTA_STATION_URL, "Atlanta allergen station"));
}

// ── The upstream calls ───────────────────────────────────────────────

/** Resolve a free-text city to a place. Throws `CITY_NOT_FOUND` on a miss. */
export async function geocodeCity(city: string): Promise<Place> {
  const url = new URL(GEOCODE_URL);
  url.searchParams.set("name", city);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const body = await getJson(url, "geocoder");
  const results = body.results;
  const first = Array.isArray(results) ? asRecord(results[0]) : null;
  if (!first) {
    throw new ConditionsError("CITY_NOT_FOUND", `No place matched "${city}".`);
  }

  const name = first.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new ConditionsError("UPSTREAM_UNAVAILABLE", 'geocoder response is missing a usable "name"');
  }
  const timezone = first.timezone;
  if (typeof timezone !== "string" || timezone.trim() === "") {
    throw new ConditionsError("UPSTREAM_UNAVAILABLE", 'geocoder response is missing a usable "timezone"');
  }
  const admin1 = typeof first.admin1 === "string" ? first.admin1 : undefined;

  return {
    name,
    ...(admin1 === undefined ? {} : { admin1 }),
    country: typeof first.country === "string" ? first.country : "",
    latitude: requireNumber(first, "latitude", "geocoder"),
    longitude: requireNumber(first, "longitude", "geocoder"),
    timezone,
  };
}

/** Current weather for a coordinate. Temperatures are ALWAYS celsius. */
export async function fetchCurrentWeather(
  latitude: number,
  longitude: number,
): Promise<WeatherObservation> {
  const url = new URL(FORECAST_URL);
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day",
  );
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("temperature_unit", "celsius");
  url.searchParams.set("wind_speed_unit", "kmh");

  const body = await getJson(url, "forecast");
  const current = asRecord(body.current);
  if (!current) {
    throw new ConditionsError("UPSTREAM_UNAVAILABLE", 'forecast response is missing "current"');
  }
  const time = current.time;
  if (typeof time !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(time)) {
    throw new ConditionsError("UPSTREAM_UNAVAILABLE", 'forecast response is missing a usable "current.time"');
  }
  const offsetSeconds = requireNumber(body, "utc_offset_seconds", "forecast");
  const code = requireNumber(current, "weather_code", "forecast");
  const isDay = requireNumber(current, "is_day", "forecast");

  return {
    observedAt: toObservedAt(time, offsetSeconds),
    localTime: toLocalTime(time),
    weather: {
      tempC: requireNumber(current, "temperature_2m", "forecast"),
      feelsLikeC: requireNumber(current, "apparent_temperature", "forecast"),
      humidityPct: Math.round(requireNumber(current, "relative_humidity_2m", "forecast")),
      windKph: requireNumber(current, "wind_speed_10m", "forecast"),
      code,
      label: wmoLabel(code),
      isDay: isDay === 1,
    },
  };
}

/** Open-Meteo's modeled pollen result. Exported for focused provider tests. */
export async function fetchOpenMeteoAirQuality(
  latitude: number,
  longitude: number,
): Promise<AirObservation> {
  const url = new URL(AIR_QUALITY_URL);
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("current", POLLEN_GRAINS.map((g) => `${g}_pollen`).join(","));
  url.searchParams.set("timezone", "auto");

  const body = await getJson(url, "air-quality");
  const current = asRecord(body.current);
  if (!current) {
    throw new ConditionsError("UPSTREAM_UNAVAILABLE", 'air-quality response is missing "current"');
  }

  const grains = {} as PollenGrains;
  for (const grain of POLLEN_GRAINS) grains[grain] = readGrain(current, grain);
  const total = totalPollenIndex(grains);
  const observedAt = typeof current.time === "string" ? current.time : null;

  return {
    pollen: total === null
      ? {
          ...unavailablePollen(OPEN_METEO_COVERAGE_REASON, OPEN_METEO_SOURCE),
          grains,
          observedAt,
        }
      : {
          available: true,
          grains,
          total,
          unit: "grains/m³",
          band: pollenBand(total),
          categories: [],
          observedAt,
          source: OPEN_METEO_SOURCE,
          reason: null,
        },
    mold: unavailableMold(NO_LOCAL_MOLD_REASON),
  };
}

/**
 * Best allergen source for a coordinate.
 *
 * The NAB-certified Atlanta station wins inside its documented metro-area
 * scope. A station outage falls back to Open-Meteo for pollen, while carrying
 * the local failure in both unavailable reasons. Outside Atlanta, Open-Meteo
 * is used directly. Any allergen outage degrades only these fields; it never
 * erases an otherwise valid weather card.
 */
function describeAtlantaStationFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const lower = detail.toLowerCase();
  if (lower.includes("www.atlantaallergy.com") && lower.includes("allowlist")) {
    return `${ATLANTA_STATION_PERMISSION_REASON} Original error: ${detail}`;
  }
  return detail;
}

export async function fetchAirQuality(
  latitude: number,
  longitude: number,
): Promise<AirObservation> {
  if (usesAtlantaStation(latitude, longitude)) {
    try {
      return await fetchAtlantaStation();
    } catch (stationError) {
      const stationReason = describeAtlantaStationFailure(stationError);
      try {
        const fallback = await fetchOpenMeteoAirQuality(latitude, longitude);
        if (!fallback.pollen.available) {
          fallback.pollen.reason = `Atlanta station unavailable (${stationReason}). ${fallback.pollen.reason}`;
        }
        fallback.mold.reason = `Atlanta station unavailable (${stationReason}). ${fallback.mold.reason}`;
        return fallback;
      } catch (openMeteoError) {
        const openMeteoReason = openMeteoError instanceof Error
          ? openMeteoError.message
          : String(openMeteoError);
        const reason = `Allergen providers unavailable: Atlanta station (${stationReason}); Open-Meteo (${openMeteoReason}).`;
        return {
          pollen: unavailablePollen(reason, null),
          mold: unavailableMold(reason),
        };
      }
    }
  }

  try {
    return await fetchOpenMeteoAirQuality(latitude, longitude);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      pollen: unavailablePollen(`Pollen provider unavailable: ${detail}`, OPEN_METEO_SOURCE),
      mold: unavailableMold(NO_LOCAL_MOLD_REASON),
    };
  }
}
