/**
 * Hostile-preview rules for run artifacts (C09).
 *
 * Artifact bytes are untrusted. The console shows them in exactly two ways:
 * as escaped text (Svelte text interpolation, never `{@html}`), or as a raster
 * image that was decoded and RE-ENCODED to PNG in a bounded canvas, so no
 * original byte of the file reaches an image element. Markup — HTML, SVG,
 * scripts — is only ever shown as its escaped source. Anything else is a
 * download with `nosniff` and an attachment disposition.
 */

/** Text previews read at most this many bytes. */
export const FACTORY_PREVIEW_TEXT_BYTES = 64 * 1024;
/** Images larger than this are not decoded at all. */
export const FACTORY_PREVIEW_IMAGE_BYTES = 4 * 1024 * 1024;
/** Re-encoded images are scaled to fit this edge. */
export const FACTORY_PREVIEW_IMAGE_EDGE = 1024;

export type FactoryRasterType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type FactoryPreviewPlan =
	| { readonly kind: "json"; readonly text: string; readonly truncated: boolean }
	| { readonly kind: "text"; readonly text: string; readonly truncated: boolean; readonly markup: boolean }
	| { readonly kind: "image"; readonly type: FactoryRasterType }
	| { readonly kind: "download"; readonly reason: string };

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
	return prefix.every((value, index) => bytes[offset + index] === value);
}

const ASCII = (text: string) => Array.from(text, character => character.charCodeAt(0));

/** The raster type proven by the file's own magic bytes, or null. The claimed name or type is never trusted. */
export function rasterType(bytes: Uint8Array): FactoryRasterType | null {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(bytes, ASCII("GIF87a")) || startsWith(bytes, ASCII("GIF89a"))) return "image/gif";
	if (startsWith(bytes, ASCII("RIFF")) && startsWith(bytes, ASCII("WEBP"), 8)) return "image/webp";
	return null;
}

const MARKUP = /<\s*(!doctype|html|svg|script|iframe|object|embed|math|style|link|meta)\b/i;

/** Decides how untrusted bytes may be shown. It never returns a way to execute them. */
export function planArtifactPreview(bytes: Uint8Array, encodedBytes = bytes.byteLength): FactoryPreviewPlan {
	const raster = rasterType(bytes);
	if (raster) {
		return encodedBytes <= FACTORY_PREVIEW_IMAGE_BYTES ? { kind: "image", type: raster } : { kind: "download", reason: "The image is too large to preview." };
	}
	const window = bytes.subarray(0, FACTORY_PREVIEW_TEXT_BYTES);
	if (window.includes(0)) return { kind: "download", reason: "Binary content is download-only." };
	let text: string;
	try {
		// A cut can land inside a multi-byte character; only a truncated window may end that way.
		text = new TextDecoder("utf-8", { fatal: true }).decode(window, { stream: encodedBytes > window.byteLength });
	} catch {
		return { kind: "download", reason: "The content is not UTF-8 text." };
	}
	const truncated = encodedBytes > window.byteLength;
	if (!truncated) {
		try {
			return { kind: "json", text: JSON.stringify(JSON.parse(text), null, 2), truncated: false };
		} catch {
			// Not JSON; it is shown as text below.
		}
	}
	return { kind: "text", text, truncated, markup: MARKUP.test(text) };
}

/** The largest size that fits `edge` on its longer side without enlarging. */
export function fitWithin(width: number, height: number, edge = FACTORY_PREVIEW_IMAGE_EDGE): { readonly width: number; readonly height: number } {
	if (!(width > 0 && height > 0)) return { width: 0, height: 0 };
	const scale = Math.min(1, edge / Math.max(width, height));
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export interface FactoryImageCodec {
	readonly decode: (blob: Blob) => Promise<{ readonly width: number; readonly height: number; close(): void }>;
	readonly encode: (image: { readonly width: number; readonly height: number }, width: number, height: number) => Promise<Blob>;
}

/**
 * Decodes a proven raster and re-encodes it to PNG at a bounded size. The
 * decoder is the browser's own image decoder, which runs no script; what the
 * page displays is the new PNG, never the artifact's bytes.
 */
export async function reencodeRaster(bytes: Uint8Array, type: FactoryRasterType, codec: FactoryImageCodec): Promise<Blob> {
	const image = await codec.decode(new Blob([new Uint8Array(bytes)], { type }));
	try {
		const size = fitWithin(image.width, image.height);
		if (size.width === 0) throw new Error("The image has no pixels.");
		const encoded = await codec.encode(image, size.width, size.height);
		if (encoded.type !== "image/png") throw new Error("The re-encoded preview is not a PNG.");
		return encoded;
	} finally {
		image.close();
	}
}

/** The browser codec: `createImageBitmap` to decode, an offscreen canvas to re-encode. */
export const browserImageCodec: FactoryImageCodec = {
	decode: blob => createImageBitmap(blob),
	async encode(image, width, height) {
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas is unavailable.");
		context.drawImage(image as ImageBitmap, 0, 0, width, height);
		return canvas.convertToBlob({ type: "image/png" });
	},
};
