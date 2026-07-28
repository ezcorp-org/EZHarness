/**
 * The ONE upstream layer for city-conditions.
 *
 * Every tool this extension ships — the chat tool `city_conditions` and
 * the three granular tools the shipped workflow's steps call — goes
 * through these three functions. There is no second copy of the
 * Open-Meteo wiring: the chat tool composes `geocodeCity` +
 * `fetchCurrentWeather` + `fetchAirQuality` in-process, and the workflow
 * composes the same three as declarative steps.
 *
 * All three endpoints are keyless (no auth, no credential), which is why
 * this extension declares no `permissions.env` at all and therefore never
 * goes near the env-key-leak install gate.
 *
 * Failure policy: every upstream problem throws a {@link ConditionsError}
 * carrying one of the three contract codes. Nothing is swallowed, and no
 * value is ever invented to fill a hole — a missing reading stays `null`
 * and a broken response fails loudly.
 */
import {
  POLLEN_GRAINS,
  type PollenBand,
  type PollenGrain,
  type PollenGrains,
  pollenBand,
  totalPollenIndex,
} from "./pollen-bands";

// ── Upstream endpoints (keyless; the only three hosts we allowlist) ──

export const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
export const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
export const AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";

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

// ── Envelope pieces (see tasks/city-conditions-contract.md) ──────────

export interface Place {
  name: string;
  /** Absent when the provider has no first-level admin division. */
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

export interface PollenReading {
  grains: PollenGrains;
  totalIndex: number | null;
  band: PollenBand;
}

export interface MoldReading {
  available: false;
  reason: string;
  count: null;
  band: null;
}

export interface AirObservation {
  pollen: PollenReading;
  mold: MoldReading;
}

/**
 * Mold ships as an explicit "not available", never as a number.
 *
 * Open-Meteo publishes no mold spore data, and every source that does
 * (NAB, Ambee, BreezoMeter, Tomorrow.io) requires a credential. A keyed
 * provider could not take that credential as an env grant anyway — the
 * install gate refuses any `permissions.env` name ending in
 * `_API_KEY`/`TOKEN`/`SECRET` — so it would have to be a per-call tool
 * input, which is a different product decision than this extension makes.
 *
 * So the field is present, honest, and carries its reason. Fabricating a
 * count, or dropping the key so the card renders a blank where a health
 * figure belongs, are both the same lie.
 */
export const MOLD_UNAVAILABLE: MoldReading = {
  available: false,
  reason: "No keyless provider. Open-Meteo does not publish mold spore counts.",
  count: null,
  band: null,
};

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

// ── Small pure helpers (exported so they are testable in isolation) ──

/** `-18000` → `-05:00`. The offset the PLACE is on, from the provider. */
export function offsetSuffix(utcOffsetSeconds: number): string {
  const sign = utcOffsetSeconds < 0 ? "-" : "+";
  const abs = Math.abs(utcOffsetSeconds);
  const hours = String(Math.floor(abs / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((abs % 3600) / 60)).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

/**
 * Open-Meteo returns `current.time` as a zone-local `YYYY-MM-DDTHH:MM`
 * with no offset. Pin the place's offset onto it so the consumer can
 * never mistake it for UTC or for the server's own zone.
 */
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

/**
 * GET a URL and parse JSON, mapping every transport/status/parse problem
 * onto `UPSTREAM_UNAVAILABLE`. `what` names the endpoint so the message a
 * user eventually reads says which upstream broke.
 */
async function getJson(url: URL, what: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(url.toString());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConditionsError("UPSTREAM_UNAVAILABLE", `${what} request failed: ${detail}`);
  }
  if (!res.ok) {
    throw new ConditionsError("UPSTREAM_UNAVAILABLE", `${what} returned HTTP ${res.status}`);
  }
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

// ── The three upstream calls ─────────────────────────────────────────

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
  // `timezone=auto` makes `current.time` + `utc_offset_seconds` describe
  // the PLACE, which is what `observedAt` / `localTime` are built from.
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

/**
 * Pollen for a coordinate, plus the constant mold "not available" block.
 *
 * Mold lives here rather than in the chat tool so the shipped workflow's
 * `air` step produces the same complete air/health picture the card gets
 * — one implementation, two callers.
 */
export async function fetchAirQuality(
  latitude: number,
  longitude: number,
): Promise<AirObservation> {
  const url = new URL(AIR_QUALITY_URL);
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("current", POLLEN_GRAINS.map((g) => `${g}_pollen`).join(","));

  const body = await getJson(url, "air-quality");
  const current = asRecord(body.current);
  if (!current) {
    throw new ConditionsError("UPSTREAM_UNAVAILABLE", 'air-quality response is missing "current"');
  }

  const grains = {} as PollenGrains;
  for (const grain of POLLEN_GRAINS) grains[grain] = readGrain(current, grain);
  const totalIndex = totalPollenIndex(grains);

  return {
    pollen: { grains, totalIndex, band: pollenBand(totalIndex) },
    mold: MOLD_UNAVAILABLE,
  };
}
