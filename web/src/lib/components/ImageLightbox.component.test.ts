import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import { lightbox } from "$lib/image-lightbox.svelte.js";
import ImageLightbox from "./ImageLightbox.svelte";

afterEach(() => {
	lightbox.hide();
	cleanup();
});

async function openLightbox() {
	const view = render(ImageLightbox);
	lightbox.show("https://img.example.test/x.png", "A diagram");
	await tick();
	return view;
}

describe("ImageLightbox", () => {
	test("Escape closes an open lightbox and takes the key from the page", async () => {
		const { queryByTestId } = await openLightbox();
		expect(queryByTestId("image-lightbox")).toBeInTheDocument();

		const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
		window.dispatchEvent(event);
		await tick();

		expect(event.defaultPrevented).toBe(true);
		expect(lightbox.open).toBe(false);
		expect(queryByTestId("image-lightbox")).toBeNull();
	});

	test("another key leaves it open, and Escape with nothing open is left to the page", async () => {
		const { queryByTestId } = await openLightbox();
		await fireEvent.keyDown(window, { key: "Enter" });
		expect(queryByTestId("image-lightbox")).toBeInTheDocument();

		lightbox.hide();
		await tick();
		const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
		window.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
	});

	test("the close button and a click on the backdrop close it; a click on the image does not", async () => {
		const { getByRole, getByTestId, queryByTestId } = await openLightbox();
		await fireEvent.click(getByRole("img", { name: "A diagram" }));
		expect(queryByTestId("image-lightbox")).toBeInTheDocument();
		await fireEvent.click(getByTestId("image-lightbox"));
		expect(queryByTestId("image-lightbox")).toBeNull();

		lightbox.show("https://img.example.test/x.png", "A diagram");
		await tick();
		await fireEvent.click(getByRole("button", { name: "Close image preview" }));
		expect(queryByTestId("image-lightbox")).toBeNull();
	});
});
