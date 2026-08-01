#!/usr/bin/env bun
/**
 * city-conditions — tool handlers.
 *
 * Four tools, ONE implementation. `lib/open-meteo.ts` owns every upstream
 * call; `lib/pollen-bands.ts` owns the banding. Nothing here re-implements
 * either.
 *
 *   city_conditions  — the chat tool. Geocodes, then fetches weather and
 *                      air quality CONCURRENTLY, and returns the full
 *                      envelope the `city-conditions` card renders.
 *   geocode          — city → place
 *   current_weather  — coordinate → observation
 *   air_quality      — coordinate → pollen + mold
 *
 * The three granular tools exist so `conditions.workflow.yaml` can express
 * the same aggregation as a declarative graph, with `current_weather` and
 * `air_quality` in one parallel batch. The chat tool does NOT run that
 * workflow — `ezcorp/workflows` is fire-and-forget and `workflow:*` events
 * are not extension-subscribable, so a tool physically cannot await a
 * workflow and render its aggregate. Both paths compose the same helpers
 * instead.
 *
 * ── Failure shape: deliberately different per audience ───────────────
 *
 * `city_conditions` NEVER returns `isError`. Its failures come back as the
 * contract's `{v:1, ok:false, code, error}` envelope with `isError:false`,
 * because the card is the thing that must render them — an `isError`
 * result would strand the reason in a generic error row, and a card
 * showing nothing is a failure pretending to be a success.
 *
 * The granular tools DO return `isError` on failure. Their caller is a
 * workflow step, and `runToolStep` turns an `isError` result into a
 * thrown, named step failure carrying the full message — strictly more
 * informative than a downstream gate reporting that a field is missing.
 *
 * Either way the failure is structured and explained. Nothing is
 * swallowed; no upstream problem is ever converted into a success.
 */

import {
  createToolDispatcher,
  getChannel,
  toolError,
  toolResult,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";
import {
  ConditionsError,
  type FailureCode,
  fetchAirQuality,
  fetchCurrentWeather,
  geocodeCity,
} from "./lib/open-meteo";

/** Envelope schema version. v2 adds provider provenance, correct units, and station bands. */
export const ENVELOPE_VERSION = 2;

/** Display unit the caller asked for. Readings stay celsius regardless. */
export type Unit = "celsius" | "fahrenheit";

// ── Input validation ─────────────────────────────────────────────────

function requireCity(args: Record<string, unknown>): string {
  const city = args.city;
  if (typeof city !== "string" || city.trim() === "") {
    throw new ConditionsError("BAD_INPUT", "'city' is required and must be a non-empty string");
  }
  return city.trim();
}

function requireUnit(args: Record<string, unknown>): Unit {
  const unit = args.unit;
  if (unit === undefined) return "celsius";
  if (unit !== "celsius" && unit !== "fahrenheit") {
    throw new ConditionsError("BAD_INPUT", "'unit' must be either 'celsius' or 'fahrenheit'");
  }
  return unit;
}

function requireCoordinate(args: Record<string, unknown>, field: string, limit: number): number {
  const raw = args[field];
  if (typeof raw !== "number" || !Number.isFinite(raw) || Math.abs(raw) > limit) {
    throw new ConditionsError(
      "BAD_INPUT",
      `'${field}' is required and must be a number between -${limit} and ${limit}`,
    );
  }
  return raw;
}

// ── Failure projection ───────────────────────────────────────────────

/** Split any thrown value into the contract's `{code, error}` pair. */
export function failureParts(err: unknown): { code: FailureCode; error: string } {
  if (err instanceof ConditionsError) return { code: err.code, error: err.message };
  return {
    code: "UPSTREAM_UNAVAILABLE",
    error: err instanceof Error ? err.message : String(err),
  };
}

/** The card's failure envelope — a successful RESULT carrying a failure. */
function failureEnvelope(err: unknown): ReturnType<typeof toolResult> {
  const { code, error } = failureParts(err);
  return toolResult(JSON.stringify({ v: ENVELOPE_VERSION, ok: false, code, error }));
}

/** A workflow step's failure — loud, so `runToolStep` throws with the reason. */
function stepFailure(err: unknown): ReturnType<typeof toolError> {
  const { code, error } = failureParts(err);
  return toolError(`[${code}] ${error}`, code);
}

// ── Tools ────────────────────────────────────────────────────────────

/**
 * The chat tool. Weather and air quality are fetched with `Promise.all`
 * — the in-process twin of the workflow's parallel batch.
 */
const cityConditions: ToolHandler = async (args) => {
  try {
    const city = requireCity(args);
    const unit = requireUnit(args);
    const place = await geocodeCity(city);
    const [observation, air] = await Promise.all([
      fetchCurrentWeather(place.latitude, place.longitude),
      fetchAirQuality(place.latitude, place.longitude),
    ]);
    return toolResult(JSON.stringify({
      v: ENVELOPE_VERSION,
      ok: true,
      place,
      unit,
      observedAt: observation.observedAt,
      localTime: observation.localTime,
      weather: observation.weather,
      pollen: air.pollen,
      mold: air.mold,
    }));
  } catch (err) {
    return failureEnvelope(err);
  }
};

const geocode: ToolHandler = async (args) => {
  try {
    const place = await geocodeCity(requireCity(args));
    return toolResult(JSON.stringify({ v: ENVELOPE_VERSION, ok: true, place }));
  } catch (err) {
    return stepFailure(err);
  }
};

const currentWeather: ToolHandler = async (args) => {
  try {
    const latitude = requireCoordinate(args, "latitude", 90);
    const longitude = requireCoordinate(args, "longitude", 180);
    const observation = await fetchCurrentWeather(latitude, longitude);
    return toolResult(JSON.stringify({ v: ENVELOPE_VERSION, ok: true, ...observation }));
  } catch (err) {
    return stepFailure(err);
  }
};

const airQuality: ToolHandler = async (args) => {
  try {
    const latitude = requireCoordinate(args, "latitude", 90);
    const longitude = requireCoordinate(args, "longitude", 180);
    const air = await fetchAirQuality(latitude, longitude);
    return toolResult(JSON.stringify({ v: ENVELOPE_VERSION, ok: true, ...air }));
  } catch (err) {
    return stepFailure(err);
  }
};

export const tools: Record<string, ToolHandler> = {
  city_conditions: cityConditions,
  geocode,
  current_weather: currentWeather,
  air_quality: airQuality,
};

/**
 * Production boot: mount the dispatcher and start the channel read loop.
 *
 * ORDER MATTERS. `getChannel()` must be CALLED before
 * `createToolDispatcher` — channel.ts has zero top-level side effects by
 * design, and arms rpc.ts's `_register` lazily from
 * `ensureDispatcherRegistered()` on the first `getChannel()` call.
 * Importing `getChannel` is not enough. Dispatching first hits the
 * default register, which throws "channel not ready" and kills the
 * subprocess at spawn — every tool call then fails as a crash.
 * `price-chart` holds the same `const ch = getChannel()` shape.
 */
export function start(): void {
  const ch = getChannel();
  createToolDispatcher(tools);
  ch.start();
}

// Gated on `import.meta.main` so test imports don't open stdin.
if (import.meta.main) start();
