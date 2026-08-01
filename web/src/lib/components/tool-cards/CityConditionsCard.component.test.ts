/**
 * DOM tests for CityConditionsCard.svelte.
 *
 * The component is template-only (all derivation lives in
 * city-conditions-card-logic.ts), so these tests assert what a user can
 * SEE — which is where the failure this card exists to prevent lives:
 *   - mold's "not available" block shows the REASON, not a blank/0/dash;
 *   - an unreported pollen grain and a measured zero render differently
 *     (different text AND a different style hook), so a gap can never be
 *     misread as a measurement;
 *   - the clock shown is the place's local time;
 *   - `ok:false` renders a readable failure block, never an empty card.
 */
import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, test } from "vitest";
import "@testing-library/jest-dom/vitest";
import CityConditionsCard from "./CityConditionsCard.svelte";
import {
	buildCityConditionsView,
	type CityConditionsView,
} from "./city-conditions-card-logic.js";

afterEach(() => cleanup());

const MOLD_REASON =
	"No keyless provider. Open-Meteo does not publish mold spore counts.";

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
		grains: { alder: null, birch: 0.2, grass: 8.1, mugwort: null, olive: null, ragweed: 1.4 },
		totalIndex: 9.7,
		band: "moderate",
	},
	mold: { available: false, reason: MOLD_REASON, count: null, band: null },
};

/** Build the view the router would pass in; fails loudly on null. */
function viewFor(output: unknown, input?: unknown): CityConditionsView {
	const view = buildCityConditionsView(output, input);
	expect(view).not.toBeNull();
	return view as CityConditionsView;
}

function renderCard(output: unknown, input?: unknown) {
	return render(CityConditionsCard, { view: viewFor(output, input) });
}

describe("CityConditionsCard — the full contract payload", () => {
	test("renders place, region/country and the PLACE-local time", () => {
		const { getByTestId } = renderCard(ENVELOPE);
		expect(getByTestId("city-conditions-place")).toHaveTextContent(
			"Austin, Texas, United States",
		);
		expect(getByTestId("city-conditions-timezone")).toHaveTextContent("America/Chicago");
		const clock = getByTestId("city-conditions-local-time");
		expect(clock).toHaveTextContent("3:04 PM");
		expect(clock).toHaveAttribute("data-reported", "true");
	});

	test("renders the current reading in celsius by default", () => {
		const { getByTestId } = renderCard(ENVELOPE);
		expect(getByTestId("city-conditions-temp")).toHaveTextContent("34.2 °C");
		expect(getByTestId("city-conditions-condition")).toHaveTextContent("Partly cloudy");
		expect(getByTestId("city-conditions-feels-like")).toHaveTextContent("38.1 °C");
		expect(getByTestId("city-conditions-humidity")).toHaveTextContent("55%");
		expect(getByTestId("city-conditions-wind")).toHaveTextContent("12.4 km/h");
	});

	test("unit:fahrenheit is honoured — the payload stays celsius, the card converts", () => {
		const { getByTestId } = renderCard(ENVELOPE, { city: "Austin", unit: "fahrenheit" });
		expect(getByTestId("city-conditions-temp")).toHaveTextContent("93.6 °F");
		expect(getByTestId("city-conditions-feels-like")).toHaveTextContent("100.6 °F");
		expect(getByTestId("city-conditions-wind")).toHaveTextContent("7.7 mph");
	});

	test("renders all six grains with the total index and its band", () => {
		const { getByTestId, getAllByTestId } = renderCard(ENVELOPE);
		const grains = getAllByTestId("city-conditions-grain");
		expect(grains.map((g) => g.getAttribute("data-grain"))).toEqual([
			"alder",
			"birch",
			"grass",
			"mugwort",
			"olive",
			"ragweed",
		]);
		expect(getByTestId("city-conditions-pollen-total")).toHaveTextContent("9.7");
		const band = getByTestId("city-conditions-pollen-band");
		expect(band).toHaveTextContent("Moderate");
		expect(band).toHaveAttribute("data-band", "moderate");
	});

	test("the band pill restyles when the reading changes (band-* class tracks the band)", async () => {
		const { getByTestId, rerender } = renderCard(ENVELOPE);
		const band = getByTestId("city-conditions-pollen-band");
		expect(band.classList.contains("band-moderate")).toBe(true);
		await rerender({
			view: viewFor({
				...ENVELOPE,
				pollen: { ...ENVELOPE.pollen, totalIndex: 140.2, band: "very-high" },
			}),
		});
		expect(band.classList.contains("band-very-high")).toBe(true);
		expect(band.classList.contains("band-moderate")).toBe(false);
		expect(band).toHaveTextContent("Very high");
		expect(getByTestId("city-conditions-pollen-total")).toHaveTextContent("140.2");
	});

	test("night payloads get the night treatment without changing the reading", () => {
		const { getByTestId } = renderCard({
			...ENVELOPE,
			weather: { ...ENVELOPE.weather, isDay: false },
		});
		const card = getByTestId("city-conditions-card");
		expect(card.classList.contains("night")).toBe(true);
		expect(getByTestId("city-conditions-temp")).toHaveTextContent("34.2 °C");
	});

	test("a payload with no timezone simply omits the zone label", () => {
		const { queryByTestId, getByTestId } = renderCard({
			...ENVELOPE,
			place: { name: "Austin", country: "United States" },
		});
		expect(queryByTestId("city-conditions-timezone")).toBeNull();
		expect(getByTestId("city-conditions-place")).toHaveTextContent("Austin, United States");
	});

	test("a missing local time says so — the viewer's clock is never substituted", () => {
		const { getByTestId } = renderCard({ ...ENVELOPE, localTime: "" });
		const clock = getByTestId("city-conditions-local-time");
		expect(clock).toHaveTextContent("Local time not reported");
		expect(clock).toHaveAttribute("data-reported", "false");
		expect(clock.classList.contains("unreported")).toBe(true);
	});
});

describe("CityConditionsCard — a gap never looks like a measurement", () => {
	test("an unreported grain and a MEASURED zero render differently", () => {
		const { getAllByTestId } = renderCard({
			...ENVELOPE,
			pollen: {
				grains: { alder: null, birch: 0, grass: 8.1, mugwort: null, olive: null, ragweed: 1.4 },
				totalIndex: 9.7,
				band: "moderate",
			},
		});
		const values = getAllByTestId("city-conditions-grain-value");
		const alder = values[0]!; // null — the provider has no value here
		const birch = values[1]!; // 0 — a real, measured zero

		expect(alder).toHaveTextContent("Not reported");
		expect(alder).toHaveAttribute("data-reported", "false");
		expect(alder.classList.contains("unreported")).toBe(true);

		expect(birch).toHaveTextContent("0.0");
		expect(birch).toHaveAttribute("data-reported", "true");
		expect(birch.classList.contains("unreported")).toBe(false);

		// Distinct in text AND in style hook — neither alone would do.
		expect(alder.textContent).not.toBe(birch.textContent);
		expect(alder.className).not.toBe(birch.className);
	});

	test("a null total index reads as Not reported, never as 0", () => {
		const { getByTestId } = renderCard({
			...ENVELOPE,
			pollen: {
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
			},
		});
		const total = getByTestId("city-conditions-pollen-total");
		expect(total).toHaveTextContent("Not reported");
		expect(total).toHaveAttribute("data-reported", "false");
		expect(total.textContent).not.toContain("0");
		expect(getByTestId("city-conditions-pollen-band")).toHaveTextContent("Not reported");
	});
});

describe("CityConditionsCard — mold", () => {
	test("unavailable mold shows an explicit flag AND the reason", () => {
		const { getByTestId, queryByTestId } = renderCard(ENVELOPE);
		const block = getByTestId("city-conditions-mold-unavailable");
		expect(block).toHaveTextContent("Not available");
		const reason = getByTestId("city-conditions-mold-reason");
		expect(reason).toHaveTextContent(MOLD_REASON);
		// Not blank, not a zero, not a bare dash.
		expect(reason.textContent?.trim().length).toBeGreaterThan(20);
		expect(queryByTestId("city-conditions-mold-count")).toBeNull();
	});

	test("a mold payload with no reason still explains itself", () => {
		const { getByTestId } = renderCard({
			...ENVELOPE,
			mold: { available: false, reason: "", count: null, band: null },
		});
		expect(getByTestId("city-conditions-mold-reason")).toHaveTextContent(
			"No provider reported mold spore data",
		);
	});

	test("a keyed provider that DOES report mold renders the count and band", () => {
		const { getByTestId, queryByTestId } = renderCard({
			...ENVELOPE,
			mold: { available: true, reason: null, count: 1240.5, band: "high" },
		});
		// Mold is measured in SPORES. `grains/m³` is the pollen unit and was
		// what this assertion pinned before the envelope carried units.
		expect(getByTestId("city-conditions-mold-count")).toHaveTextContent("1240.5 spores/m³");
		// The card shows the user-facing label now, not the raw band token.
		expect(getByTestId("city-conditions-mold-band")).toHaveTextContent("High");
		expect(queryByTestId("city-conditions-mold-unavailable")).toBeNull();
	});

	test("mold claimed available but sent with no count degrades to the honest block", () => {
		const { getByTestId, queryByTestId } = renderCard({
			...ENVELOPE,
			mold: { available: true, reason: "", count: null, band: null },
		});
		expect(queryByTestId("city-conditions-mold-count")).toBeNull();
		// A count is no longer the only thing that makes mold real — a station
		// activity band counts too — so the reason names both.
		expect(getByTestId("city-conditions-mold-reason")).toHaveTextContent(
			"sent no count or activity band",
		);
	});
});

/**
 * A reporting station shapes the card differently from a forecast grid: it
 * publishes per-CATEGORY bands instead of per-grain numbers, and a mold
 * ACTIVITY band with no spore count. Both render through branches the
 * Open-Meteo payload never reaches, and both must carry their provenance —
 * an observed reading and a modeled one are not interchangeable to a reader
 * deciding whether to go outside.
 */
describe("CityConditionsCard — a reporting station's shape", () => {
	const STATION_SOURCE = {
		id: "atlanta-allergy",
		name: "Atlanta Allergy & Asthma",
		url: "https://www.atlantaallergy.com/pollen_counts",
		kind: "observed",
		certification: "National Allergy Bureau-certified station",
	};

	const STATION_ENVELOPE = {
		...ENVELOPE,
		pollen: {
			available: true,
			grains: null,
			total: 1240.5,
			unit: "grains/m³",
			band: "very-high",
			categories: [
				{ key: "trees", label: "Trees", band: "high", contributors: ["Oak", "Pine"] },
				// No contributors — the station names them only for some categories.
				{ key: "grass", label: "Grass", band: "low", contributors: [] },
			],
			observedAt: "2026-07-28",
			source: STATION_SOURCE,
			reason: null,
		},
		mold: {
			available: true,
			reason: "The station publishes a mold activity band, not a numeric spore count.",
			count: null,
			unit: null,
			band: "moderate",
			observedAt: "2026-07-28",
			source: STATION_SOURCE,
		},
	};

	test("categories replace the per-grain rows, each with its own band", () => {
		const { getByTestId, getAllByTestId, queryAllByTestId } = renderCard(STATION_ENVELOPE);
		expect(getByTestId("city-conditions-pollen-categories")).toBeInTheDocument();
		const categories = getAllByTestId("city-conditions-pollen-category");
		expect(categories.map((c) => c.getAttribute("data-category"))).toEqual(["trees", "grass"]);
		const bands = getAllByTestId("city-conditions-category-band");
		expect(bands[0]).toHaveTextContent("High");
		expect(bands[1]).toHaveTextContent("Low");
		// The grain list is the OTHER branch — a station payload has no grains.
		expect(queryAllByTestId("city-conditions-grain")).toHaveLength(0);
	});

	test("top contributors show for the category that names them, and only that one", () => {
		const { getAllByTestId } = renderCard(STATION_ENVELOPE);
		const categories = getAllByTestId("city-conditions-pollen-category");
		expect(categories[0]).toHaveTextContent("Oak, Pine");
		// Grass named none; the card renders nothing rather than an empty line.
		expect(categories[1]?.textContent).not.toContain(",");
	});

	test("both readings carry provenance — observed, certified, and dated", () => {
		const { getByTestId } = renderCard(STATION_ENVELOPE);
		const pollenSource = getByTestId("city-conditions-pollen-source");
		expect(pollenSource).toHaveTextContent("Observed by Atlanta Allergy & Asthma");
		expect(pollenSource).toHaveTextContent("National Allergy Bureau-certified station");
		// A date-only stamp stays the station's date; no timezone shifting.
		expect(pollenSource).toHaveTextContent("Reported 07/28/2026");
		expect(getByTestId("city-conditions-mold-source")).toHaveTextContent(
			"Observed by Atlanta Allergy & Asthma",
		);
	});

	test("a band-only mold reading says so instead of implying a count", () => {
		const { getByTestId, queryByTestId } = renderCard(STATION_ENVELOPE);
		expect(getByTestId("city-conditions-mold-band")).toHaveTextContent("Moderate");
		expect(getByTestId("city-conditions-mold-count")).toHaveTextContent("Count not published");
		// The note is what stops a band being read as a measured spore figure.
		expect(getByTestId("city-conditions-mold-note")).toHaveTextContent(
			"not a numeric spore count",
		);
		expect(queryByTestId("city-conditions-mold-unavailable")).toBeNull();
	});

	test("modeled data is labelled modeled, not observed", () => {
		const { getByTestId } = renderCard({
			...STATION_ENVELOPE,
			pollen: {
				...STATION_ENVELOPE.pollen,
				source: { id: "open-meteo", name: "Open-Meteo / CAMS", kind: "modeled" },
				observedAt: "2026-07-28T15:00",
			},
		});
		const line = getByTestId("city-conditions-pollen-source");
		expect(line).toHaveTextContent("Modeled by Open-Meteo / CAMS");
		expect(line.textContent).not.toContain("Observed by");
	});
});

describe("CityConditionsCard — ok:false", () => {
	test("a failed run renders the code and message, not an empty card", () => {
		const { getByTestId, queryByTestId } = renderCard({
			v: 1,
			ok: false,
			code: "CITY_NOT_FOUND",
			error: 'No match for "Attlantis".',
		});
		expect(queryByTestId("city-conditions-card")).toBeNull();
		const failed = getByTestId("city-conditions-failed");
		expect(failed).toHaveAttribute("role", "alert");
		expect(failed).toHaveTextContent("City conditions unavailable");
		expect(getByTestId("city-conditions-failure-code")).toHaveTextContent("CITY_NOT_FOUND");
		expect(getByTestId("city-conditions-failure-message")).toHaveTextContent(
			'No match for "Attlantis".',
		);
	});

	test("a failure with no message still says something readable", () => {
		const { getByTestId } = renderCard({ v: 1, ok: false });
		expect(getByTestId("city-conditions-failure-code")).toHaveTextContent("UNKNOWN");
		expect(getByTestId("city-conditions-failure-message")).toHaveTextContent(
			"reported a failure but sent no message",
		);
	});
});
