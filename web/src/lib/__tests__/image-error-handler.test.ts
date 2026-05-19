import { parseHTML } from "linkedom";
import { test, expect, describe, beforeEach } from "bun:test";
import { attachImageFallbacks } from "../image-error-handler";

const win = parseHTML("<!DOCTYPE html><html><body></body></html>");
const doc = win.document;

// linkedom's elements don't go through a real layout/network pipeline — `error`
// won't fire naturally. Use linkedom's own Event so it plays nicely with the
// library's dispatch implementation.
function fireError(el: Element) {
	el.dispatchEvent(new (win.Event as any)("error"));
}

describe("attachImageFallbacks", () => {
	let container: Element;

	beforeEach(() => {
		container = doc.createElement("div");
	});

	test("no chat images → noop", () => {
		container.innerHTML = "<p>Hello <img src='/other.png' alt='other' /></p>";
		attachImageFallbacks(container as any);
		// Non-chat-image unchanged
		expect(container.querySelector("img")).not.toBeNull();
	});

	test("chat image error → replaced with fallback span with link to original URL", () => {
		container.innerHTML = `<img src="https://example.com/cat.png" alt="a cat" data-chat-image="1" data-original-url="https://example.com/cat.png" class="chat-image" />`;
		attachImageFallbacks(container as any);
		const img = container.querySelector("img")!;
		fireError(img);

		const fallback = container.querySelector('[data-testid="chat-image-fallback"]');
		expect(fallback).not.toBeNull();
		expect(container.querySelector("img")).toBeNull();

		const link = fallback!.querySelector("a");
		expect(link).not.toBeNull();
		expect(link!.getAttribute("href")).toBe("https://example.com/cat.png");
		expect(link!.getAttribute("target")).toBe("_blank");
		expect(link!.getAttribute("rel")).toBe("noopener noreferrer");
		expect(link!.textContent).toContain("Open original");

		expect(fallback!.textContent).toContain("Image unavailable");
		expect(fallback!.textContent).toContain("a cat");
	});

	test("fallback label falls back to generic when alt is empty", () => {
		container.innerHTML = `<img src="https://example.com/x.png" alt="" data-chat-image="1" data-original-url="https://example.com/x.png" />`;
		attachImageFallbacks(container as any);
		fireError(container.querySelector("img")!);
		const fallback = container.querySelector('[data-testid="chat-image-fallback"]')!;
		expect(fallback.textContent).toContain("Image unavailable");
		expect(fallback.textContent).not.toContain("Image unavailable:");
	});

	test("fallback omits link when no original URL is available", () => {
		container.innerHTML = `<img src="/local.png" alt="x" data-chat-image="1" />`;
		attachImageFallbacks(container as any);
		const img = container.querySelector("img")!;
		// Remove the src before firing error so buildFallback sees empty originalUrl
		img.removeAttribute("src");
		fireError(img);
		const fallback = container.querySelector('[data-testid="chat-image-fallback"]')!;
		expect(fallback.querySelector("a")).toBeNull();
	});

	test("successful load leaves image untouched", () => {
		container.innerHTML = `<img src="https://example.com/ok.png" alt="ok" data-chat-image="1" data-original-url="https://example.com/ok.png" />`;
		attachImageFallbacks(container as any);
		// No error fired.
		expect(container.querySelector("img")).not.toBeNull();
		expect(container.querySelector('[data-testid="chat-image-fallback"]')).toBeNull();
	});

	test("idempotent: second attach on same image does not double-wire the handler", () => {
		container.innerHTML = `<img src="https://example.com/a.png" alt="a" data-chat-image="1" data-original-url="https://example.com/a.png" />`;
		attachImageFallbacks(container as any);
		attachImageFallbacks(container as any);
		const img = container.querySelector("img")!;
		expect(img.getAttribute("data-fallback-wired")).toBe("1");
		fireError(img);
		expect(container.querySelectorAll('[data-testid="chat-image-fallback"]').length).toBe(1);
	});

	test("handles multiple chat images independently", () => {
		container.innerHTML = `
			<img src="https://example.com/a.png" alt="a" data-chat-image="1" data-original-url="https://a.test" />
			<img src="https://example.com/b.png" alt="b" data-chat-image="1" data-original-url="https://b.test" />
		`;
		attachImageFallbacks(container as any);
		const imgs = Array.from(container.querySelectorAll("img"));
		expect(imgs.length).toBe(2);
		// Fail the first one only.
		fireError(imgs[0]!);
		expect(container.querySelectorAll("img").length).toBe(1);
		const fb = container.querySelector('[data-testid="chat-image-fallback"] a')!;
		expect(fb.getAttribute("href")).toBe("https://a.test");
	});
});
