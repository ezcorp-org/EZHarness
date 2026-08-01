/**
 * Unit tests for city-conditions-card-logic.
 *
 * The card exists to stop a health figure rendering as a blank, so the
 * assertions below are weighted at the honesty rules rather than the
 * happy path:
 *   - `null` grain (provider has no value) vs `0` grain (measured zero);
 *   - `totalIndex: null` is "Not reported", never 0;
 *   - mold `available:false` always carries a reason;
 *   - the place-LOCAL clock is used verbatim, and its absence is stated
 *     rather than papered over with the viewer's clock;
 *   - `ok:false` produces a readable failure view, while an UNUSABLE
 *     envelope produces null so the router falls back to DefaultCard.
 */
import { describe, expect, test } from "vitest";
import {
	bandIdOf,
	bandLabelOf,
	buildCityConditionsView,
	buildMoldView,
	buildPollenView,
	convertTemperature,
	convertWind,
	extractCityConditionsObject,
	FAILURE_FALLBACK_MESSAGE,
	formatHumidity,
	formatPlaceLine,
	formatTemperature,
	formatWind,
	LOCAL_TIME_UNAVAILABLE,
	MOLD_FALLBACK_REASON,
	NOT_REPORTED,
	POLLEN_FALLBACK_REASON,
	POLLEN_GRAIN_KEYS,
	resolveUnit,
	type CityConditionsOkView,
} from "./city-conditions-card-logic.js";

/** The contract's worked example (tasks/city-conditions-contract.md). */
const ENVELOPE = {
	v: 1,
	ok: true,
	place: {
		name: "Austin",
		admin1: "Texas",
		country: "United States",
		latitude: 30.267,
		longitude: -97.743,
		timezone: "America/Chicago",
	},
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
		grains: {
			alder: null,
			birch: 0.2,
			grass: 8.1,
			mugwort: null,
			olive: null,
			ragweed: 1.4,
		},
		totalIndex: 9.7,
		band: "moderate",
	},
	mold: {
		available: false,
		reason: "No keyless provider. Open-Meteo does not publish mold spore counts.",
		count: null,
		band: null,
	},
};

/** Narrow to the ok view, failing loudly instead of returning null. */
function okView(output: unknown, input?: unknown): CityConditionsOkView {
	const view = buildCityConditionsView(output, input);
	expect(view).not.toBeNull();
	expect(view?.kind).toBe("ok");
	return view as CityConditionsOkView;
}

describe("extractCityConditionsObject", () => {
	test("accepts a JSON string, a raw object, and an MCP content envelope", () => {
		expect(extractCityConditionsObject(JSON.stringify({ ok: true }))).toEqual({ ok: true });
		expect(extractCityConditionsObject({ ok: false })).toEqual({ ok: false });
		expect(
			extractCityConditionsObject({
				content: [{ type: "text", text: JSON.stringify({ ok: true, v: 1 }) }],
			}),
		).toEqual({ ok: true, v: 1 });
	});

	test("an MCP envelope whose parts carry no text falls back to the outer object", () => {
		const outer = { content: [{ type: "image" }], ok: true };
		expect(extractCityConditionsObject(outer)).toBe(outer);
	});

	test("returns null for nothing usable (null, blank, broken JSON, scalar, array)", () => {
		expect(extractCityConditionsObject(null)).toBeNull();
		expect(extractCityConditionsObject(undefined)).toBeNull();
		expect(extractCityConditionsObject("   ")).toBeNull();
		expect(extractCityConditionsObject("{not json")).toBeNull();
		expect(extractCityConditionsObject("42")).toBeNull();
		expect(extractCityConditionsObject(7)).toBeNull();
		expect(extractCityConditionsObject([1, 2])).toBeNull();
	});
});

describe("resolveUnit — the unit comes from the tool INPUT, not the payload", () => {
	test("explicit fahrenheit wins; everything else is the celsius default", () => {
		expect(resolveUnit({ unit: "fahrenheit" })).toBe("fahrenheit");
		expect(resolveUnit({ unit: "celsius" })).toBe("celsius");
		expect(resolveUnit({ city: "Austin" })).toBe("celsius");
		expect(resolveUnit({ unit: "kelvin" })).toBe("celsius");
		expect(resolveUnit(undefined)).toBe("celsius");
		expect(resolveUnit("fahrenheit")).toBe("celsius");
	});
});

describe("conversion + formatting", () => {
	test("celsius passes through; fahrenheit converts", () => {
		expect(convertTemperature(34.2, "celsius")).toBe(34.2);
		expect(convertTemperature(0, "fahrenheit")).toBe(32);
		expect(convertTemperature(100, "fahrenheit")).toBe(212);
	});

	test("wind travels with the unit system (km/h ↔ mph)", () => {
		expect(convertWind(12.4, "celsius")).toBe(12.4);
		expect(convertWind(100, "fahrenheit")).toBeCloseTo(62.1371, 4);
	});

	test("temperature renders 1dp with the right suffix", () => {
		expect(formatTemperature(34.2, "celsius")).toBe("34.2 °C");
		expect(formatTemperature(34.2, "fahrenheit")).toBe("93.6 °F");
	});

	test("wind renders 1dp with the right suffix", () => {
		expect(formatWind(12.4, "celsius")).toBe("12.4 km/h");
		expect(formatWind(12.4, "fahrenheit")).toBe("7.7 mph");
	});

	test("humidity rounds to a whole percent", () => {
		expect(formatHumidity(55)).toBe("55%");
		expect(formatHumidity(55.4)).toBe("55%");
	});

	test("a MEASURED zero formats as a number — it is data, not a gap", () => {
		expect(formatTemperature(0, "celsius")).toBe("0.0 °C");
		expect(formatWind(0, "celsius")).toBe("0.0 km/h");
		expect(formatHumidity(0)).toBe("0%");
	});

	test("a MISSING value says so instead of rendering as zero", () => {
		expect(formatTemperature(null, "celsius")).toBe(NOT_REPORTED);
		expect(formatWind(null, "celsius")).toBe(NOT_REPORTED);
		expect(formatHumidity(null)).toBe(NOT_REPORTED);
	});

	test("place line drops absent parts instead of padding them", () => {
		expect(
			formatPlaceLine({ name: "Austin", admin1: "Texas", country: "United States" }),
		).toBe("Austin, Texas, United States");
		expect(formatPlaceLine({ name: "Singapore", country: "Singapore" })).toBe(
			"Singapore, Singapore",
		);
		expect(formatPlaceLine({ name: "Austin", admin1: "", country: "" })).toBe("Austin");
	});
});

describe("pollen bands are mapped, never re-derived", () => {
	test("the five contract bands map to their labels", () => {
		expect(bandLabelOf(bandIdOf("none"))).toBe(NOT_REPORTED);
		expect(bandLabelOf(bandIdOf("low"))).toBe("Low");
		expect(bandLabelOf(bandIdOf("moderate"))).toBe("Moderate");
		expect(bandLabelOf(bandIdOf("high"))).toBe("High");
		expect(bandLabelOf(bandIdOf("very-high"))).toBe("Very high");
	});

	test("an unrecognised or absent band is 'unknown', not a guess", () => {
		expect(bandIdOf("extreme")).toBe("unknown");
		expect(bandIdOf("unknown")).toBe("unknown");
		expect(bandIdOf(undefined)).toBe("unknown");
		expect(bandIdOf(3)).toBe("unknown");
		expect(bandLabelOf("unknown")).toBe("Unknown");
	});
});

describe("buildPollenView — null grain vs measured zero", () => {
	test("all six grains render in contract order", () => {
		const view = buildPollenView(ENVELOPE.pollen);
		expect(view.grains.map((g) => g.key)).toEqual([...POLLEN_GRAIN_KEYS]);
		expect(view.grains.map((g) => g.label)).toEqual([
			"Alder",
			"Birch",
			"Grass",
			"Mugwort",
			"Olive",
			"Ragweed",
		]);
	});

	test("a null grain is flagged unreported and reads as words, not a number", () => {
		const view = buildPollenView(ENVELOPE.pollen);
		const alder = view.grains.find((g) => g.key === "alder");
		expect(alder?.reported).toBe(false);
		expect(alder?.text).toBe(NOT_REPORTED);
	});

	test("a MEASURED zero is reported and renders as 0.0 — distinct from null", () => {
		const view = buildPollenView({
			grains: { alder: 0, birch: null, grass: 0, mugwort: 0, olive: 0, ragweed: 0 },
			totalIndex: 0,
			band: "low",
		});
		const alder = view.grains.find((g) => g.key === "alder");
		const birch = view.grains.find((g) => g.key === "birch");
		expect(alder).toMatchObject({ reported: true, text: "0.0" });
		expect(birch).toMatchObject({ reported: false, text: NOT_REPORTED });
		// The two states differ in BOTH the flag and the text.
		expect(alder?.text).not.toBe(birch?.text);
		// A measured-zero total is a real reading, not a gap.
		expect(view.totalReported).toBe(true);
		expect(view.totalText).toBe("0.0");
		expect(view.bandId).toBe("low");
	});

	test("totalIndex null (every grain null) reads as Not reported, never 0", () => {
		const view = buildPollenView({
			grains: {
				alder: null,
				birch: null,
				grass: null,
				mugwort: null,
				olive: null,
				ragweed: null,
			},
			totalIndex: null,
			band: "none",
		});
		expect(view.grains.every((g) => !g.reported)).toBe(true);
		expect(view.totalReported).toBe(false);
		expect(view.totalText).toBe(NOT_REPORTED);
		expect(view.bandLabel).toBe(NOT_REPORTED);
	});

	test("a missing/garbage pollen block degrades to six unreported grains", () => {
		for (const raw of [undefined, null, "nope", { grains: "nope" }]) {
			const view = buildPollenView(raw);
			expect(view.grains).toHaveLength(6);
			expect(view.grains.every((g) => g.text === NOT_REPORTED)).toBe(true);
			expect(view.totalReported).toBe(false);
			expect(view.bandId).toBe("unknown");
		}
	});

	test("available:false with no reason still explains pollen unavailability", () => {
		for (const raw of [{ available: false }, { available: false, reason: "  " }, undefined]) {
			const view = buildPollenView(raw);
			expect(view.available).toBe(false);
			expect(view.reason).toBe(POLLEN_FALLBACK_REASON);
			expect(view.reason.length).toBeGreaterThan(0);
		}
	});

	test("station categories, correct units, source, and report date render without fake grain counts", () => {
		const view = buildPollenView({
			available: true,
			grains: null,
			total: 4,
			unit: "grains/m³",
			band: "low",
			categories: [
				{ key: "trees", label: "Trees", band: "low", contributors: ["MULBERRY"] },
				{ key: "weeds", label: "Weeds", band: "moderate", contributors: ["RAGWEED", "PLANTAIN"] },
			],
			observedAt: "2026-07-29",
			source: {
				name: "Atlanta Allergy & Asthma",
				kind: "observed",
				certification: "National Allergy Bureau-certified station",
			},
		});
		expect(view.available).toBe(true);
		expect(view.showCategories).toBe(true);
		expect(view.totalText).toBe("4.0");
		expect(view.unit).toBe("grains/m³");
		expect(view.categories[1]).toMatchObject({
			key: "weeds",
			bandLabel: "Moderate",
			contributorsText: "RAGWEED, PLANTAIN",
		});
		expect(view.grains.every((grain) => !grain.reported)).toBe(true);
		expect(view.sourceLine).toBe(
			"Observed by Atlanta Allergy & Asthma · National Allergy Bureau-certified station · Reported 07/29/2026",
		);
	});

	test("a non-finite grain is treated as unreported, not as NaN on screen", () => {
		const view = buildPollenView({
			grains: { alder: Number.NaN, birch: "8.1", grass: Number.POSITIVE_INFINITY },
			totalIndex: Number.NaN,
			band: "low",
		});
		expect(view.grains.every((g) => g.text === NOT_REPORTED)).toBe(true);
		expect(view.totalText).toBe(NOT_REPORTED);
	});
});

describe("buildMoldView — the figure that must never render blank", () => {
	test("available:false carries the producer's reason verbatim", () => {
		const view = buildMoldView(ENVELOPE.mold);
		expect(view.available).toBe(false);
		expect(view.reason).toBe(ENVELOPE.mold.reason);
		// Never a blank, a zero, or a bare dash.
		expect(view.countText).toBe(NOT_REPORTED);
		expect(view.bandText).toBe(NOT_REPORTED);
	});

	test("available:false with no reason still explains itself", () => {
		for (const raw of [{ available: false }, { available: false, reason: "  " }, undefined, {}]) {
			const view = buildMoldView(raw);
			expect(view.available).toBe(false);
			expect(view.reason).toBe(MOLD_FALLBACK_REASON);
			expect(view.reason.length).toBeGreaterThan(0);
		}
	});

	test("available:true with a count renders a spore count and its band", () => {
		const view = buildMoldView({
			available: true,
			count: 1240.5,
			unit: "spores/m³",
			band: "high",
			reason: null,
		});
		expect(view.available).toBe(true);
		expect(view.countReported).toBe(true);
		expect(view.countText).toBe("1240.5 spores/m³");
		expect(view.bandText).toBe("High");
		expect(view.reason).toBe("");
	});

	test("a station activity band is available without pretending it is a count", () => {
		const view = buildMoldView({
			available: true,
			count: null,
			band: "very-high",
			reason: "The station publishes a mold activity band, not a numeric spore count.",
			observedAt: "2026-07-29",
			source: {
				name: "Atlanta Allergy & Asthma",
				kind: "observed",
				certification: "National Allergy Bureau-certified station",
			},
		});
		expect(view.available).toBe(true);
		expect(view.countReported).toBe(false);
		expect(view.countText).toBe("Count not published");
		expect(view.bandText).toBe("Very high");
		expect(view.reason).toContain("activity band");
		expect(view.sourceLine).toContain("Observed by Atlanta Allergy & Asthma");
		expect(view.sourceLine).toContain("Reported 07/29/2026");
	});

	test("available:true with a count but no band names the gap", () => {
		const view = buildMoldView({ available: true, count: 12, band: null });
		expect(view.bandText).toBe(NOT_REPORTED);
	});

	test("available:true with NO count or band degrades with a reason", () => {
		const view = buildMoldView({ available: true, count: null });
		expect(view.available).toBe(false);
		expect(view.reason).toContain("no count or activity band");
	});

	test("available:true with no count uses the producer's reason when it sent one", () => {
		const view = buildMoldView({ available: true, count: null, reason: "Sensor offline." });
		expect(view.available).toBe(false);
		expect(view.reason).toBe("Sensor offline.");
	});
});

describe("buildCityConditionsView — the contract envelope", () => {
	test("renders the worked example in celsius by default", () => {
		const view = okView(JSON.stringify(ENVELOPE));
		expect(view.placeLine).toBe("Austin, Texas, United States");
		expect(view.placeName).toBe("Austin");
		expect(view.timezone).toBe("America/Chicago");
		expect(view.condition).toBe("Partly cloudy");
		expect(view.isDay).toBe(true);
		expect(view.temperature).toBe("34.2 °C");
		expect(view.feelsLike).toBe("38.1 °C");
		expect(view.humidity).toBe("55%");
		expect(view.wind).toBe("12.4 km/h");
		expect(view.pollen.totalText).toBe("9.7");
		expect(view.pollen.bandLabel).toBe("Moderate");
		expect(view.mold.available).toBe(false);
	});

	test("unit:fahrenheit converts temperature, feels-like and wind", () => {
		const view = okView(ENVELOPE, { city: "Austin", unit: "fahrenheit" });
		expect(view.temperature).toBe("93.6 °F");
		expect(view.feelsLike).toBe("100.6 °F");
		expect(view.wind).toBe("7.7 mph");
		// Humidity is unitless — unchanged.
		expect(view.humidity).toBe("55%");
	});

	test("the clock is the PLACE's preformatted local time, used verbatim", () => {
		const view = okView(ENVELOPE);
		expect(view.localTime).toBe("3:04 PM");
		expect(view.localTimeReported).toBe(true);
	});

	test("a missing local time is stated, never replaced by the viewer's clock", () => {
		const view = okView({ ...ENVELOPE, localTime: "" });
		expect(view.localTimeReported).toBe(false);
		expect(view.localTime).toBe(LOCAL_TIME_UNAVAILABLE);
	});

	test("isDay:false is carried through for the night treatment", () => {
		const view = okView({ ...ENVELOPE, weather: { ...ENVELOPE.weather, isDay: false } });
		expect(view.isDay).toBe(false);
	});

	test("a partial ok:true body degrades per-field instead of failing", () => {
		const view = okView({
			v: 1,
			ok: true,
			place: { name: "Reykjavík" },
			weather: { tempC: 4 },
		});
		expect(view.placeLine).toBe("Reykjavík");
		expect(view.timezone).toBe("");
		expect(view.temperature).toBe("4.0 °C");
		expect(view.condition).toBe(NOT_REPORTED);
		expect(view.feelsLike).toBe(NOT_REPORTED);
		expect(view.humidity).toBe(NOT_REPORTED);
		expect(view.wind).toBe(NOT_REPORTED);
		expect(view.localTime).toBe(LOCAL_TIME_UNAVAILABLE);
		expect(view.pollen.grains).toHaveLength(6);
		expect(view.mold.reason).toBe(MOLD_FALLBACK_REASON);
		// isDay defaults to day only when not explicitly false.
		expect(view.isDay).toBe(true);
	});
});

describe("buildCityConditionsView — ok:false renders, unusable degrades", () => {
	test("ok:false surfaces the code and the message", () => {
		const view = buildCityConditionsView({
			v: 1,
			ok: false,
			code: "CITY_NOT_FOUND",
			error: 'No match for "Attlantis".',
		});
		expect(view).toEqual({
			kind: "failed",
			code: "CITY_NOT_FOUND",
			message: 'No match for "Attlantis".',
		});
	});

	test("every contract failure code passes through", () => {
		for (const code of ["CITY_NOT_FOUND", "UPSTREAM_UNAVAILABLE", "BAD_INPUT"]) {
			const view = buildCityConditionsView({ v: 1, ok: false, code, error: "boom" });
			expect(view).toMatchObject({ kind: "failed", code });
		}
	});

	test("ok:false with no code/message still says something readable", () => {
		const view = buildCityConditionsView({ v: 1, ok: false });
		expect(view).toEqual({
			kind: "failed",
			code: "UNKNOWN",
			message: FAILURE_FALLBACK_MESSAGE,
		});
	});

	test("an UNUSABLE envelope returns null so the router falls back to DefaultCard", () => {
		// Mirrors parseInstallCardResult's degradation contract.
		expect(buildCityConditionsView(null)).toBeNull();
		expect(buildCityConditionsView("")).toBeNull();
		expect(buildCityConditionsView("{broken json")).toBeNull();
		// No `ok` discriminant — not this card's envelope at all.
		expect(buildCityConditionsView({ place: { name: "Austin" } })).toBeNull();
		expect(buildCityConditionsView({ ok: "yes" })).toBeNull();
		// ok:true but no place name / no temperature: there is no honest
		// card to draw, and a blank one is the failure we are killing.
		expect(buildCityConditionsView({ ok: true, weather: { tempC: 4 } })).toBeNull();
		expect(
			buildCityConditionsView({ ok: true, place: { name: "  " }, weather: { tempC: 4 } }),
		).toBeNull();
		expect(buildCityConditionsView({ ok: true, place: { name: "Austin" } })).toBeNull();
		expect(
			buildCityConditionsView({ ok: true, place: { name: "Austin" }, weather: { tempC: "hot" } }),
		).toBeNull();
	});
});
