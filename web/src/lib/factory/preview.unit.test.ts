import { afterEach, describe, expect, test, vi } from "vitest";
import {
	FACTORY_PREVIEW_IMAGE_BYTES,
	FACTORY_PREVIEW_TEXT_BYTES,
	browserImageCodec,
	fitWithin,
	planArtifactPreview,
	rasterType,
	reencodeRaster,
	type FactoryImageCodec,
} from "./preview";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("rasterType", () => {
	test("trusts only magic bytes", () => {
		expect(rasterType(bytes(...PNG, 1))).toBe("image/png");
		expect(rasterType(bytes(...PNG.slice(0, 7)))).toBeNull();
		expect(rasterType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b))).toBeNull();
		expect(rasterType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
		expect(rasterType(bytes(0xff, 0xd8, 0xfe))).toBeNull();
		expect(rasterType(text("GIF87a..."))).toBe("image/gif");
		expect(rasterType(text("GIF89a..."))).toBe("image/gif");
		expect(rasterType(text("GIF88a..."))).toBeNull();
		expect(rasterType(text("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
		expect(rasterType(text("RIFF\0\0\0\0WAVE"))).toBeNull();
		expect(rasterType(text("XIFF\0\0\0\0WEBP"))).toBeNull();
		expect(rasterType(text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
		expect(rasterType(bytes())).toBeNull();
	});
});

describe("planArtifactPreview", () => {
	test("markup is escaped source, never rendered, and JSON is pretty-printed", () => {
		for (const markup of ["<script>alert(1)</script>", "<!DOCTYPE html><p>x</p>", "< svg onload=alert(1)>", "<IFRAME src=x>", "<math>", "<style>", "<link rel=x>", "<meta x>", "<object>", "<embed>", "<html>"]) {
			expect(planArtifactPreview(text(markup))).toEqual({ kind: "text", text: markup, truncated: false, markup: true });
		}
		expect(planArtifactPreview(text("<b>bold</b> is not active markup"))).toMatchObject({ kind: "text", markup: false });
		expect(planArtifactPreview(text("<svgfoo>"))).toMatchObject({ kind: "text", markup: false });
		expect(planArtifactPreview(text('{"a":[1,{"b":"<script>"}]}'))).toEqual({ kind: "json", text: '{\n  "a": [\n    1,\n    {\n      "b": "<script>"\n    }\n  ]\n}', truncated: false });
		expect(planArtifactPreview(text("plain words"))).toEqual({ kind: "text", text: "plain words", truncated: false, markup: false });
	});

	test("binary, invalid UTF-8, and oversized images are download-only", () => {
		expect(planArtifactPreview(bytes(0x41, 0x00, 0x42))).toEqual({ kind: "download", reason: "Binary content is download-only." });
		expect(planArtifactPreview(bytes(0xc3, 0x28))).toEqual({ kind: "download", reason: "The content is not UTF-8 text." });
		expect(planArtifactPreview(bytes(...PNG), FACTORY_PREVIEW_IMAGE_BYTES)).toEqual({ kind: "image", type: "image/png" });
		expect(planArtifactPreview(bytes(...PNG), FACTORY_PREVIEW_IMAGE_BYTES + 1)).toEqual({ kind: "download", reason: "The image is too large to preview." });
	});

	test("text is bounded, marked truncated, and never parsed as JSON when cut", () => {
		const long = text("[" + "1,".repeat(FACTORY_PREVIEW_TEXT_BYTES) + "1]");
		const plan = planArtifactPreview(long);
		expect(plan).toMatchObject({ kind: "text", truncated: true });
		expect((plan as { text: string }).text.length).toBe(FACTORY_PREVIEW_TEXT_BYTES);
		// A multi-byte character split by the window is tolerated only when the window was cut.
		const euro = text("€".repeat(FACTORY_PREVIEW_TEXT_BYTES));
		expect(planArtifactPreview(euro)).toMatchObject({ kind: "text", truncated: true });
		expect(planArtifactPreview(text("x"), FACTORY_PREVIEW_TEXT_BYTES + 5)).toMatchObject({ kind: "text", truncated: true, text: "x" });
		// A NUL beyond the window does not change the verdict for the window.
		const late = new Uint8Array(FACTORY_PREVIEW_TEXT_BYTES + 1).fill(0x61);
		late[FACTORY_PREVIEW_TEXT_BYTES] = 0;
		expect(planArtifactPreview(late)).toMatchObject({ kind: "text", truncated: true });
	});
});

describe("fitWithin", () => {
	test("scales the longer side down, never up, and refuses empty images", () => {
		expect(fitWithin(4096, 2048)).toEqual({ width: 1024, height: 512 });
		expect(fitWithin(1000, 3000, 300)).toEqual({ width: 100, height: 300 });
		expect(fitWithin(10, 20)).toEqual({ width: 10, height: 20 });
		expect(fitWithin(5000, 1, 100)).toEqual({ width: 100, height: 1 });
		expect(fitWithin(0, 10)).toEqual({ width: 0, height: 0 });
		expect(fitWithin(10, -1)).toEqual({ width: 0, height: 0 });
		expect(fitWithin(Number.NaN, 10)).toEqual({ width: 0, height: 0 });
	});
});

describe("reencodeRaster", () => {
	const image = (width: number, height: number) => ({ width, height, close: vi.fn() });

	test("decodes with the proven type, re-encodes at the fitted size, and always releases the bitmap", async () => {
		const decoded = image(2048, 1024);
		const codec: FactoryImageCodec = {
			decode: vi.fn(async (blob: Blob) => { expect(blob.type).toBe("image/jpeg"); expect(blob.size).toBe(3); return decoded; }),
			encode: vi.fn(async () => new Blob([bytes(1)], { type: "image/png" })),
		};
		const result = await reencodeRaster(bytes(0xff, 0xd8, 0xff), "image/jpeg", codec);
		expect(result.type).toBe("image/png");
		expect(codec.encode).toHaveBeenCalledWith(decoded, 1024, 512);
		expect(decoded.close).toHaveBeenCalledTimes(1);
	});

	test("refuses an image without pixels and an encoder that returns anything but PNG", async () => {
		const empty = image(0, 0);
		await expect(reencodeRaster(bytes(1), "image/png", { decode: async () => empty, encode: vi.fn() })).rejects.toThrow("The image has no pixels.");
		expect(empty.close).toHaveBeenCalledTimes(1);
		const wrong = image(1, 1);
		await expect(reencodeRaster(bytes(1), "image/png", { decode: async () => wrong, encode: async () => new Blob(["<svg/>"], { type: "image/svg+xml" }) })).rejects.toThrow("not a PNG");
		expect(wrong.close).toHaveBeenCalledTimes(1);
	});
});

describe("browserImageCodec", () => {
	afterEach(() => { vi.unstubAllGlobals(); });

	test("decodes through createImageBitmap and re-encodes through an offscreen canvas as PNG", async () => {
		const bitmap = { width: 3, height: 2, close: vi.fn() };
		vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
		const drawImage = vi.fn();
		const convertToBlob = vi.fn(async (options: { type: string }) => new Blob([bytes(1)], { type: options.type }));
		class Canvas { constructor(readonly width: number, readonly height: number) {} getContext() { return { drawImage }; } convertToBlob = convertToBlob; }
		vi.stubGlobal("OffscreenCanvas", Canvas);
		const blob = new Blob([bytes(1)]);
		expect(await browserImageCodec.decode(blob)).toBe(bitmap);
		const encoded = await browserImageCodec.encode(bitmap, 2, 1);
		expect(encoded.type).toBe("image/png");
		expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 2, 1);
		expect(convertToBlob).toHaveBeenCalledWith({ type: "image/png" });
	});

	test("says so when no 2D context exists", async () => {
		class Canvas { getContext() { return null; } }
		vi.stubGlobal("OffscreenCanvas", Canvas);
		await expect(browserImageCodec.encode({ width: 1, height: 1 }, 1, 1)).rejects.toThrow("Canvas is unavailable.");
	});
});
