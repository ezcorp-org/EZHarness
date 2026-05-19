#!/usr/bin/env bun

import {
  createToolDispatcher,
  getChannel,
  toolError,
  toolResult,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";

export interface WeatherPayload {
  _assistant_note: string;
  location: {
    name: string;
    country: string;
    admin1?: string;
    latitude: number;
    longitude: number;
    timezone: string;
  };
  units: {
    temperature: "°C" | "°F";
    windSpeed: "km/h" | "mph";
  };
  current: {
    temperature: number;
    feelsLike: number;
    windSpeed: number;
    humidity: number;
    weatherCode: number;
    condition: string;
    emoji: string;
    isDay: boolean;
  };
  daily: Array<{
    date: string;
    dayLabel: string;
    weatherCode: number;
    condition: string;
    emoji: string;
    tempMax: number;
    tempMin: number;
    precipitationChance: number;
  }>;
  hourly: Array<{
    time: string;
    label: string;
    temperature: number;
    weatherCode: number;
    condition: string;
    emoji: string;
  }>;
}

interface GeoResult {
  name: string;
  country?: string;
  admin1?: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

interface OpenMeteoGeocodeResponse {
  results?: GeoResult[];
}

interface OpenMeteoForecastResponse {
  current?: {
    temperature_2m?: number;
    apparent_temperature?: number;
    weather_code?: number;
    wind_speed_10m?: number;
    relative_humidity_2m?: number;
    is_day?: number;
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
  };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    weather_code?: number[];
  };
}

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = fetch;

export function _setFetchImplForTests(fake: FetchLike): void {
  fetchImpl = fake;
}

export function _resetBindingsForTests(): void {
  fetchImpl = fetch;
}

function weatherCodeMeta(code: number, isDay: boolean): { condition: string; emoji: string } {
  switch (code) {
    case 0:
      return { condition: "Clear sky", emoji: isDay ? "☀️" : "🌙" };
    case 1:
    case 2:
      return { condition: "Partly cloudy", emoji: isDay ? "🌤️" : "☁️" };
    case 3:
      return { condition: "Overcast", emoji: "☁️" };
    case 45:
    case 48:
      return { condition: "Fog", emoji: "🌫️" };
    case 51:
    case 53:
    case 55:
      return { condition: "Drizzle", emoji: "🌦️" };
    case 56:
    case 57:
      return { condition: "Freezing drizzle", emoji: "🧊" };
    case 61:
    case 63:
    case 65:
      return { condition: "Rain", emoji: "🌧️" };
    case 66:
    case 67:
      return { condition: "Freezing rain", emoji: "🌨️" };
    case 71:
    case 73:
    case 75:
    case 77:
      return { condition: "Snow", emoji: "❄️" };
    case 80:
    case 81:
    case 82:
      return { condition: "Rain showers", emoji: "🌦️" };
    case 85:
    case 86:
      return { condition: "Snow showers", emoji: "🌨️" };
    case 95:
      return { condition: "Thunderstorm", emoji: "⛈️" };
    case 96:
    case 99:
      return { condition: "Thunderstorm with hail", emoji: "⛈️" };
    default:
      return { condition: "Unknown conditions", emoji: "🌍" };
  }
}

function dayLabel(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(date);
}

function hourLabel(isoTime: string): string {
  const hour = Number(isoTime.slice(11, 13));
  if (!Number.isFinite(hour)) return isoTime;
  const normalized = ((hour + 11) % 12) + 1;
  return `${normalized} ${hour >= 12 ? "PM" : "AM"}`;
}

function round1(value: number | undefined): number {
  return Number((value ?? 0).toFixed(1));
}

async function searchLocation(query: string): Promise<GeoResult> {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const res = await fetchImpl(url.toString());
  if (!res.ok) throw new Error(`geocoder HTTP ${res.status}`);
  const body = await res.json() as OpenMeteoGeocodeResponse;
  const first = body.results?.[0];
  if (!first) throw new Error(`No weather location found for '${query}'`);
  return first;
}

async function fetchForecast(location: GeoResult, unit: "celsius" | "fahrenheit"): Promise<OpenMeteoForecastResponse> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set(
    "current",
    [
      "temperature_2m",
      "apparent_temperature",
      "weather_code",
      "wind_speed_10m",
      "relative_humidity_2m",
      "is_day",
    ].join(","),
  );
  url.searchParams.set(
    "daily",
    [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_probability_max",
    ].join(","),
  );
  url.searchParams.set("hourly", ["temperature_2m", "weather_code"].join(","));
  url.searchParams.set("forecast_days", "3");
  url.searchParams.set("timezone", location.timezone || "auto");
  url.searchParams.set("temperature_unit", unit === "fahrenheit" ? "fahrenheit" : "celsius");
  url.searchParams.set("wind_speed_unit", unit === "fahrenheit" ? "mph" : "kmh");

  const res = await fetchImpl(url.toString());
  if (!res.ok) throw new Error(`forecast HTTP ${res.status}`);
  return await res.json() as OpenMeteoForecastResponse;
}

export function buildWeatherPayload(
  location: GeoResult,
  forecast: OpenMeteoForecastResponse,
  unit: "celsius" | "fahrenheit",
): WeatherPayload {
  const current = forecast.current;
  const daily = forecast.daily;
  const hourly = forecast.hourly;
  if (
    !current ||
    current.temperature_2m === undefined ||
    current.apparent_temperature === undefined ||
    current.weather_code === undefined ||
    current.wind_speed_10m === undefined ||
    current.relative_humidity_2m === undefined ||
    current.is_day === undefined ||
    !daily?.time ||
    !daily.weather_code ||
    !daily.temperature_2m_max ||
    !daily.temperature_2m_min ||
    !daily.precipitation_probability_max ||
    !hourly?.time ||
    !hourly.temperature_2m ||
    !hourly.weather_code
  ) {
    throw new Error("forecast response missing required weather fields");
  }

  const currentMeta = weatherCodeMeta(current.weather_code, current.is_day === 1);
  const dailyItems = daily.time.slice(0, 3).map((date, index) => {
    const meta = weatherCodeMeta(daily.weather_code![index] ?? 0, true);
    return {
      date,
      dayLabel: index === 0 ? "Today" : dayLabel(date),
      weatherCode: daily.weather_code![index] ?? 0,
      condition: meta.condition,
      emoji: meta.emoji,
      tempMax: round1(daily.temperature_2m_max![index]),
      tempMin: round1(daily.temperature_2m_min![index]),
      precipitationChance: Math.round(daily.precipitation_probability_max![index] ?? 0),
    };
  });

  const hourlyItems = hourly.time.slice(0, 6).map((time, index) => {
    const code = hourly.weather_code![index] ?? 0;
    const meta = weatherCodeMeta(code, true);
    return {
      time,
      label: index === 0 ? "Now" : hourLabel(time),
      temperature: round1(hourly.temperature_2m![index]),
      weatherCode: code,
      condition: meta.condition,
      emoji: meta.emoji,
    };
  });

  const displayName = [location.name, location.admin1].filter(Boolean).join(", ");

  return {
    _assistant_note:
      `Weather for ${displayName}, ${location.country ?? ""} rendered inline. ` +
      `Respond with one brief weather summary and do not call this tool again unless the user asks for another location.`,
    location: {
      name: location.name,
      country: location.country ?? "",
      admin1: location.admin1,
      latitude: location.latitude,
      longitude: location.longitude,
      timezone: location.timezone,
    },
    units: {
      temperature: unit === "fahrenheit" ? "°F" : "°C",
      windSpeed: unit === "fahrenheit" ? "mph" : "km/h",
    },
    current: {
      temperature: round1(current.temperature_2m),
      feelsLike: round1(current.apparent_temperature),
      windSpeed: round1(current.wind_speed_10m),
      humidity: Math.round(current.relative_humidity_2m),
      weatherCode: current.weather_code,
      condition: currentMeta.condition,
      emoji: currentMeta.emoji,
      isDay: current.is_day === 1,
    },
    daily: dailyItems,
    hourly: hourlyItems,
  };
}

const getWeather: ToolHandler = async (args) => {
  const { location, unit } = args as { location?: unknown; unit?: unknown };
  if (typeof location !== "string" || location.trim().length === 0) {
    return toolError("'location' is required and must be a non-empty string");
  }
  if (unit !== undefined && unit !== "celsius" && unit !== "fahrenheit") {
    return toolError("'unit' must be either 'celsius' or 'fahrenheit'");
  }

  try {
    const geo = await searchLocation(location.trim());
    const forecast = await fetchForecast(geo, unit === "fahrenheit" ? "fahrenheit" : "celsius");
    const payload = buildWeatherPayload(
      geo,
      forecast,
      unit === "fahrenheit" ? "fahrenheit" : "celsius",
    );
    return toolResult(JSON.stringify(payload));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return toolError(`Failed to fetch weather for ${location}: ${msg}`);
  }
};

export const tools: Record<string, ToolHandler> = {
  get_weather: getWeather,
};

export function start(): void {
  createToolDispatcher(tools);
  getChannel().start();
}

if (import.meta.main) start();
