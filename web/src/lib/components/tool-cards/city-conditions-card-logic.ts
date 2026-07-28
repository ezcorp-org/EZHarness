/**
 * Pure logic for CityConditionsCard — envelope parsing, unit conversion,
 * and every display string the card renders.
 *
 * Input: the `city-conditions__city_conditions` result envelope
 * (`cardType: "city-conditions"`), pinned by
 * `tasks/city-conditions-contract.md`. It arrives on
 * `ToolCallState.output` as a JSON string, a raw object, or an MCP
 * `{content:[{type:"text"}]}` envelope. The requested `unit` is NOT in
 * the envelope — the payload is ALWAYS celsius and the card converts —
 * so it is read from the tool call's INPUT.
 *
 * Everything lives here rather than in the `.svelte` file on purpose:
 * a failure-message bug once hid in an untestable component template.
 * `buildCityConditionsView` returns a fully-formatted view model, so the
 * template only branches on precomputed booleans and iterates
 * precomputed arrays.
 *
 * Honesty rules this module encodes (the reason the card exists):
 *   - a pollen grain the provider has NO value for (`null`) is "Not
 *     reported" — never rendered as 0, a dash, or a blank;
 *   - a MEASURED zero renders as the number 0.0, distinct from the
 *     above, and is flagged `reported: true` so the template can style
 *     the two differently;
 *   - `totalIndex: null` (every grain null) is "Not reported", not 0;
 *   - mold ships `available: false` with a reason and renders as an
 *     explicit not-available block carrying that reason;
 *   - the clock is the PLACE's preformatted local time, never the
 *     viewer's — if it is missing the card says so instead of
 *     substituting the browser's clock.
 *
 * Pollen BANDS are computed host-side (single source of truth, per the
 * contract) and shipped in the payload. This module never re-derives
 * them from `totalIndex`; it only maps the shipped band onto a label and
 * a style tone.
 */

// ── Envelope types (mirror tasks/city-conditions-contract.md) ────────

export interface CityConditionsPlace {
	name: string;
	admin1?: string;
	country?: string;
	latitude?: number;
	longitude?: number;
	timezone?: string;
}

export interface CityConditionsWeather {
	tempC: number;
	feelsLikeC: number | null;
	humidityPct: number | null;
	windKph: number | null;
	code: number | null;
	label: string;
	isDay: boolean;
}

/** The six grains the contract's air-quality call requests, in render order. */
export const POLLEN_GRAIN_KEYS = [
	"alder",
	"birch",
	"grass",
	"mugwort",
	"olive",
	"ragweed",
] as const;

export type PollenGrainKey = (typeof POLLEN_GRAIN_KEYS)[number];

const GRAIN_LABELS: Record<PollenGrainKey, string> = {
	alder: "Alder",
	birch: "Birch",
	grass: "Grass",
	mugwort: "Mugwort",
	olive: "Olive",
	ragweed: "Ragweed",
};

/** `none|low|moderate|high|very-high` per the contract, plus the
 *  `unknown` slot for a band string the card does not recognise. */
export type PollenBandId = "none" | "low" | "moderate" | "high" | "very-high" | "unknown";

/**
 * Band → user-facing label. `none` is the contract's band for a NULL
 * totalIndex (every grain unreported), so it reads as missing data, not
 * as "zero pollen" — a measured zero lands in `low` (`< 1`).
 */
const BAND_LABELS: Record<PollenBandId, string> = {
	none: "Not reported",
	low: "Low",
	moderate: "Moderate",
	high: "High",
	"very-high": "Very high",
	unknown: "Unknown",
};

export type TemperatureUnit = "celsius" | "fahrenheit";

export const NOT_REPORTED = "Not reported";

/** Shown when mold is unavailable and the producer sent no reason. */
export const MOLD_FALLBACK_REASON =
	"No provider reported mold spore data for this location.";

/** Shown when the envelope carries no place-local clock. The viewer's
 *  own clock is NEVER substituted — it would be a different time. */
export const LOCAL_TIME_UNAVAILABLE = "Local time not reported";

// ── View model (what the template renders, already formatted) ────────

export interface PollenGrainView {
	key: PollenGrainKey;
	label: string;
	/** false ⇒ the provider had no value here (payload `null`). */
	reported: boolean;
	/** "0.2" for a value (1dp), "Not reported" when `reported` is false. */
	text: string;
}

export interface PollenView {
	grains: PollenGrainView[];
	/** false ⇒ `totalIndex: null` (every grain null) — NOT a zero. */
	totalReported: boolean;
	totalText: string;
	bandId: PollenBandId;
	bandLabel: string;
}

export interface MoldView {
	available: boolean;
	/** Formatted count; only meaningful when `available` is true. */
	countText: string;
	bandText: string;
	/** Why there is no figure. Always non-empty when `available` is false. */
	reason: string;
}

export interface CityConditionsOkView {
	kind: "ok";
	/** "Austin, Texas, United States" — absent parts dropped. */
	placeLine: string;
	placeName: string;
	/** The PLACE's preformatted local time, or LOCAL_TIME_UNAVAILABLE. */
	localTime: string;
	localTimeReported: boolean;
	/** IANA zone, or "" when the payload omitted it. */
	timezone: string;
	isDay: boolean;
	condition: string;
	temperature: string;
	feelsLike: string;
	humidity: string;
	wind: string;
	pollen: PollenView;
	mold: MoldView;
}

export interface CityConditionsFailedView {
	kind: "failed";
	code: string;
	message: string;
}

export type CityConditionsView = CityConditionsOkView | CityConditionsFailedView;

/** Fallback text for an `ok:false` envelope that carried no `error`. */
export const FAILURE_FALLBACK_MESSAGE =
	"The city-conditions tool reported a failure but sent no message.";

const FAILURE_FALLBACK_CODE = "UNKNOWN";

// ── Parsing helpers ──────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pull a plain object out of a tool `output` that may be a JSON string,
 * an already-parsed object, or an MCP `{content:[{text}]}` envelope.
 * Returns null when nothing usable is there — the router then falls
 * through to DefaultCard rather than rendering an empty card.
 */
export function extractCityConditionsObject(output: unknown): Record<string, unknown> | null {
	if (output == null) return null;
	if (typeof output === "string") {
		const trimmed = output.trim();
		if (trimmed === "") return null;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			return isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}
	if (!isRecord(output)) return null;
	const content = output.content;
	if (Array.isArray(content)) {
		const text = content
			.map((part) =>
				isRecord(part) && typeof part.text === "string" ? part.text : "",
			)
			.join("");
		if (text !== "") return extractCityConditionsObject(text);
	}
	return output;
}

function finiteOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string {
	return typeof value === "string" && value.trim() !== "" ? value : "";
}

/**
 * The requested unit, read from the tool call's INPUT (the envelope
 * never carries it). Anything other than an explicit `"fahrenheit"`
 * means celsius — matching the contract's default.
 */
export function resolveUnit(input: unknown): TemperatureUnit {
	if (isRecord(input) && input.unit === "fahrenheit") return "fahrenheit";
	return "celsius";
}

// ── Formatting ───────────────────────────────────────────────────────

/** Celsius → the requested unit. The payload is always celsius. */
export function convertTemperature(celsius: number, unit: TemperatureUnit): number {
	return unit === "fahrenheit" ? celsius * 1.8 + 32 : celsius;
}

/** km/h → mph. Fahrenheit implies US units for the whole card, so wind
 *  travels with the temperature rather than mixing the two systems. */
export function convertWind(kph: number, unit: TemperatureUnit): number {
	return unit === "fahrenheit" ? kph * 0.621371 : kph;
}

/** "34.2 °C" / "93.6 °F"; NOT_REPORTED for a missing value (never 0). */
export function formatTemperature(celsius: number | null, unit: TemperatureUnit): string {
	if (celsius === null) return NOT_REPORTED;
	const suffix = unit === "fahrenheit" ? "°F" : "°C";
	return `${convertTemperature(celsius, unit).toFixed(1)} ${suffix}`;
}

/** "12.4 km/h" / "7.7 mph"; NOT_REPORTED for a missing value. */
export function formatWind(kph: number | null, unit: TemperatureUnit): string {
	if (kph === null) return NOT_REPORTED;
	const suffix = unit === "fahrenheit" ? "mph" : "km/h";
	return `${convertWind(kph, unit).toFixed(1)} ${suffix}`;
}

/** "55%"; NOT_REPORTED for a missing value (never a bare 0%). */
export function formatHumidity(pct: number | null): string {
	if (pct === null) return NOT_REPORTED;
	return `${Math.round(pct)}%`;
}

/** "Austin, Texas, United States" — blank parts are dropped, not padded. */
export function formatPlaceLine(place: CityConditionsPlace): string {
	return [place.name, place.admin1, place.country]
		.map((part) => nonEmptyString(part))
		.filter((part) => part !== "")
		.join(", ");
}

/** Map the host-computed band onto its label. Never re-derives the band. */
export function bandIdOf(raw: unknown): PollenBandId {
	if (typeof raw === "string" && raw in BAND_LABELS && raw !== "unknown") {
		return raw as PollenBandId;
	}
	return "unknown";
}

export function bandLabelOf(band: PollenBandId): string {
	return BAND_LABELS[band];
}

// ── Section builders ─────────────────────────────────────────────────

/**
 * Build the six grain rows plus the total. A `null` grain is
 * `reported: false` / "Not reported"; a measured 0 is `reported: true` /
 * "0.0" — the two are never collapsed into the same rendering.
 */
export function buildPollenView(raw: unknown): PollenView {
	const pollen = isRecord(raw) ? raw : {};
	const grainSource = isRecord(pollen.grains) ? pollen.grains : {};
	const grains = POLLEN_GRAIN_KEYS.map<PollenGrainView>((key) => {
		const value = finiteOrNull(grainSource[key]);
		return {
			key,
			label: GRAIN_LABELS[key],
			reported: value !== null,
			text: value === null ? NOT_REPORTED : value.toFixed(1),
		};
	});
	const total = finiteOrNull(pollen.totalIndex);
	return {
		grains,
		totalReported: total !== null,
		totalText: total === null ? NOT_REPORTED : total.toFixed(1),
		bandId: bandIdOf(pollen.band),
		bandLabel: bandLabelOf(bandIdOf(pollen.band)),
	};
}

/**
 * Build the mold block. The contract ships `available: false` plus a
 * reason today, and the card must SAY so rather than render a blank, a
 * zero, or a dash that reads like a measurement.
 *
 * `available: true` with no usable count is treated as unavailable with
 * an explicit reason: claiming availability and then showing nothing is
 * the same lie in a different costume.
 */
export function buildMoldView(raw: unknown): MoldView {
	const mold = isRecord(raw) ? raw : {};
	const count = finiteOrNull(mold.count);
	const reason = nonEmptyString(mold.reason);
	if (mold.available === true && count !== null) {
		const band = nonEmptyString(mold.band);
		return {
			available: true,
			countText: `${count.toFixed(1)} grains/m³`,
			bandText: band === "" ? NOT_REPORTED : band,
			reason: "",
		};
	}
	if (mold.available === true) {
		return {
			available: false,
			countText: NOT_REPORTED,
			bandText: NOT_REPORTED,
			reason:
				reason === ""
					? "The provider reported mold as available but sent no spore count."
					: reason,
		};
	}
	return {
		available: false,
		countText: NOT_REPORTED,
		bandText: NOT_REPORTED,
		reason: reason === "" ? MOLD_FALLBACK_REASON : reason,
	};
}

// ── Entry point ──────────────────────────────────────────────────────

/**
 * Build the card's view model from a tool call's `output` + `input`.
 *
 * Returns null ONLY when the envelope is unusable (unparseable, not an
 * object, no `ok` discriminant, or an `ok:true` body with no place name
 * or temperature). The router then renders DefaultCard — the same
 * degradation `parseInstallCardResult` uses — so a streaming or
 * malformed result never becomes a blank-but-successful card.
 *
 * A PARTIAL `ok:true` body does not return null: missing pollen, mold,
 * clock or secondary readings each degrade to their own honest
 * "Not reported" state inside the card.
 */
export function buildCityConditionsView(output: unknown, input?: unknown): CityConditionsView | null {
	const obj = extractCityConditionsObject(output);
	if (!obj) return null;
	if (typeof obj.ok !== "boolean") return null;

	if (!obj.ok) {
		const code = nonEmptyString(obj.code);
		const message = nonEmptyString(obj.error);
		return {
			kind: "failed",
			code: code === "" ? FAILURE_FALLBACK_CODE : code,
			message: message === "" ? FAILURE_FALLBACK_MESSAGE : message,
		};
	}

	const rawPlace = isRecord(obj.place) ? obj.place : {};
	const placeName = nonEmptyString(rawPlace.name);
	if (placeName === "") return null;

	const rawWeather = isRecord(obj.weather) ? obj.weather : {};
	const tempC = finiteOrNull(rawWeather.tempC);
	if (tempC === null) return null;

	const unit = resolveUnit(input);
	const timezone = nonEmptyString(rawPlace.timezone);
	const place: CityConditionsPlace = {
		name: placeName,
		admin1: nonEmptyString(rawPlace.admin1),
		country: nonEmptyString(rawPlace.country),
		timezone,
	};
	const localTime = nonEmptyString(obj.localTime);
	const condition = nonEmptyString(rawWeather.label);

	return {
		kind: "ok",
		placeLine: formatPlaceLine(place),
		placeName,
		localTime: localTime === "" ? LOCAL_TIME_UNAVAILABLE : localTime,
		localTimeReported: localTime !== "",
		timezone,
		isDay: rawWeather.isDay !== false,
		condition: condition === "" ? NOT_REPORTED : condition,
		temperature: formatTemperature(tempC, unit),
		feelsLike: formatTemperature(finiteOrNull(rawWeather.feelsLikeC), unit),
		humidity: formatHumidity(finiteOrNull(rawWeather.humidityPct)),
		wind: formatWind(finiteOrNull(rawWeather.windKph), unit),
		pollen: buildPollenView(obj.pollen),
		mold: buildMoldView(obj.mold),
	};
}
