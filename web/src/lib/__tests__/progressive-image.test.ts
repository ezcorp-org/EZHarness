import { parseHTML } from "linkedom";
import { test, expect, describe, beforeEach } from "bun:test";
import {
	attachProgressiveImages,
	progressiveImage,
} from "../progressive-image";

const win = parseHTML("<!DOCTYPE html><html><body></body></html>");
const doc = win.document;

// linkedom has no real network/layout pipeline, so load/error never fire
// naturally — dispatch linkedom's own Event so it routes through the
// library's listener implementation (mirrors image-error-handler.test.ts).
function fire(el: Element, type: "load" | "error") {
	el.dispatchEvent(new (win.Event as any)(type));
}

const WRAP = (inner: string) =>
	`<span class="progressive-img-wrap">${inner}</span>`;

describe("attachProgressiveImages", () => {
	let container: Element;

	beforeEach(() => {
		container = doc.createElement("div");
	});

	test("no progressive images → noop", () => {
		container.innerHTML = "<p>Hi <img src='/x.png' alt='x' /></p>";
		attachProgressiveImages(container as any);
		expect(
			container.querySelector("img")!.getAttribute("data-prog-wired"),
		).toBeNull();
	});

	test("load event settles img + wrapper", () => {
		container.innerHTML = WRAP(
			`<img class="progressive-img" src="https://e.test/a.png" alt="a" />`,
		);
		attachProgressiveImages(container as any);
		const img = container.querySelector("img")!;
		const wrap = container.querySelector(".progressive-img-wrap")!;

		// Not loaded yet → still blurred (no --loaded classes).
		expect(img.classList.contains("progressive-img--loaded")).toBe(false);
		expect(wrap.classList.contains("progressive-img-wrap--loaded")).toBe(
			false,
		);

		fire(img, "load");

		expect(img.classList.contains("progressive-img--loaded")).toBe(true);
		expect(wrap.classList.contains("progressive-img-wrap--loaded")).toBe(
			true,
		);
		expect(wrap.classList.contains("progressive-img-wrap--error")).toBe(
			false,
		);
	});

	test("cached image (complete + naturalWidth) settles synchronously", () => {
		container.innerHTML = WRAP(
			`<img class="progressive-img" src="https://e.test/c.png" alt="c" />`,
		);
		const img = container.querySelector("img")!;
		Object.defineProperty(img, "complete", { value: true, configurable: true });
		Object.defineProperty(img, "naturalWidth", {
			value: 200,
			configurable: true,
		});

		attachProgressiveImages(container as any);

		// Settled immediately — no fake blur over an already-decoded image.
		expect(img.classList.contains("progressive-img--loaded")).toBe(true);
		expect(
			container
				.querySelector(".progressive-img-wrap")!
				.classList.contains("progressive-img-wrap--loaded"),
		).toBe(true);
	});

	test("error stops shimmer + flags wrapper for collapse", () => {
		container.innerHTML = WRAP(
			`<img class="progressive-img" src="https://e.test/bad.png" alt="bad" />`,
		);
		attachProgressiveImages(container as any);
		const img = container.querySelector("img")!;
		const wrap = container.querySelector(".progressive-img-wrap")!;

		fire(img, "error");

		expect(img.classList.contains("progressive-img--loaded")).toBe(true);
		expect(wrap.classList.contains("progressive-img-wrap--loaded")).toBe(
			true,
		);
		expect(wrap.classList.contains("progressive-img-wrap--error")).toBe(
			true,
		);
	});

	test("idempotent: second attach does not re-wire", () => {
		container.innerHTML = WRAP(
			`<img class="progressive-img" src="https://e.test/a.png" alt="a" />`,
		);
		attachProgressiveImages(container as any);
		attachProgressiveImages(container as any);
		const img = container.querySelector("img")!;
		expect(img.getAttribute("data-prog-wired")).toBe("1");

		// A single load still produces a single settled state.
		fire(img, "load");
		expect(img.classList.contains("progressive-img--loaded")).toBe(true);
	});

	test("multiple images settle independently", () => {
		container.innerHTML =
			WRAP(`<img class="progressive-img" src="https://e.test/a.png" alt="a" />`) +
			WRAP(`<img class="progressive-img" src="https://e.test/b.png" alt="b" />`);
		attachProgressiveImages(container as any);
		const [a, b] = Array.from(container.querySelectorAll("img"));

		fire(a!, "load");

		expect(a!.classList.contains("progressive-img--loaded")).toBe(true);
		expect(b!.classList.contains("progressive-img--loaded")).toBe(false);
	});

	test("works without a wrapper (img-only) — settles the img", () => {
		container.innerHTML = `<img class="progressive-img" src="https://e.test/n.png" alt="n" />`;
		attachProgressiveImages(container as any);
		const img = container.querySelector("img")!;
		fire(img, "load");
		expect(img.classList.contains("progressive-img--loaded")).toBe(true);
	});
});

describe("progressiveImage action", () => {
	test("wires the node it is attached to", () => {
		const wrap = doc.createElement("span");
		wrap.className = "progressive-img-wrap";
		const img = doc.createElement("img");
		img.className = "progressive-img";
		wrap.appendChild(img);

		progressiveImage(img as any);
		expect(img.getAttribute("data-prog-wired")).toBe("1");

		fire(img, "load");
		expect(img.classList.contains("progressive-img--loaded")).toBe(true);
		expect(wrap.classList.contains("progressive-img-wrap--loaded")).toBe(
			true,
		);
	});
});
