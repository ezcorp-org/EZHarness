import { test, expect, describe } from "bun:test";
import { getCardComponentName } from "../lib/components/tool-cards/utils.js";

describe("getCardComponentName", () => {
	test("maps 'terminal' cardType to TerminalCard", () => {
		expect(getCardComponentName("terminal", false)).toBe("TerminalCard");
	});

	test("maps 'diff' cardType to DiffCard", () => {
		expect(getCardComponentName("diff", false)).toBe("DiffCard");
	});

	test("maps 'search-results' cardType to SearchResultsCard", () => {
		expect(getCardComponentName("search-results", false)).toBe("SearchResultsCard");
	});

	test("maps unknown cardType to DefaultCard", () => {
		expect(getCardComponentName("unknown-type", false)).toBe("DefaultCard");
	});

	test("maps undefined cardType to DefaultCard", () => {
		expect(getCardComponentName(undefined, false)).toBe("DefaultCard");
	});

	test("returns PermissionGate when permissionPending is true regardless of cardType", () => {
		expect(getCardComponentName("terminal", true)).toBe("PermissionGate");
		expect(getCardComponentName("diff", true)).toBe("PermissionGate");
		expect(getCardComponentName(undefined, true)).toBe("PermissionGate");
	});

	test("returns card component when permissionPending is undefined", () => {
		expect(getCardComponentName("terminal", undefined)).toBe("TerminalCard");
	});

	test("maps 'kokoro-tts-player' cardType to KokoroTtsPlayerCard (Kokoro-TTS extension card)", () => {
		expect(getCardComponentName("kokoro-tts-player", false)).toBe("KokoroTtsPlayerCard");
	});

	test("kokoro-tts-player still respects permissionPending gate", () => {
		expect(getCardComponentName("kokoro-tts-player", true)).toBe("PermissionGate");
	});

	test("maps 'price-chart' cardType to PriceChartCard (price-chart extension)", () => {
		expect(getCardComponentName("price-chart", false)).toBe("PriceChartCard");
	});

	test("price-chart still respects permissionPending gate", () => {
		expect(getCardComponentName("price-chart", true)).toBe("PermissionGate");
	});

	test("maps 'weather-panel' cardType to WeatherCard (weather extension custom web component card)", () => {
		expect(getCardComponentName("weather-panel", false)).toBe("WeatherCard");
	});

	test("weather-panel still respects permissionPending gate", () => {
		expect(getCardComponentName("weather-panel", true)).toBe("PermissionGate");
	});

	test("maps 'image-gen-grid' cardType to ImageGenCard (openai-image-gen-2 multi-image grid)", () => {
		expect(getCardComponentName("image-gen-grid", false)).toBe("ImageGenCard");
	});

	test("image-gen-grid still respects permissionPending gate", () => {
		expect(getCardComponentName("image-gen-grid", true)).toBe("PermissionGate");
	});

	test("maps 'ez-install' cardType to EzToolResultCard (extension-author install_draft deep-link)", () => {
		expect(getCardComponentName("ez-install", false)).toBe("EzToolResultCard");
	});

	test("ez-install still respects permissionPending gate", () => {
		expect(getCardComponentName("ez-install", true)).toBe("PermissionGate");
	});
});
