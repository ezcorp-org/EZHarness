import "@testing-library/jest-dom/vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, test, vi } from "vitest";
import ModalBackdrop from "./ModalBackdrop.svelte";

const panel = createRawSnippet(() => ({ render: () => `<div data-testid="panel">Panel</div>` }));

describe("ModalBackdrop", () => {
	test("is a fixed full-viewport layer that takes no margin, at the asked stacking order and dim", () => {
		const { getByTestId } = render(ModalBackdrop, { z: 40, dim: 60, class: "flex p-4", "data-testid": "backdrop" });
		const backdrop = getByTestId("backdrop");
		expect([...backdrop.classList]).toEqual(expect.arrayContaining(["fixed", "inset-0", "m-0", "bg-black/60", "flex", "p-4"]));
		expect(backdrop.style.zIndex).toBe("40");
	});

	test("defaults to a modal's stacking order with no dim", () => {
		const { getByTestId } = render(ModalBackdrop, { "data-testid": "backdrop" });
		const backdrop = getByTestId("backdrop");
		expect(backdrop.style.zIndex).toBe("50");
		expect([...backdrop.classList].filter((name) => name.startsWith("bg-"))).toEqual([]);
	});

	test.each([
		["lightbox", ["flex", "items-center", "justify-center", "p-8", "bg-[rgb(0_0_0/0.85)]", "backdrop-blur-[4px]", "cursor-zoom-out"]],
		["console", ["grid", "items-start", "justify-items-center", "overflow-auto", "bg-[rgb(4_8_18/0.72)]"]],
	] as const)("the %s variant carries its shared look", (variant, classes) => {
		const { getByTestId } = render(ModalBackdrop, { variant, z: 80, "data-testid": "backdrop" });
		const backdrop = getByTestId("backdrop");
		expect([...backdrop.classList]).toEqual(expect.arrayContaining(["fixed", "inset-0", "m-0", ...classes]));
		expect(backdrop.style.zIndex).toBe("80");
	});

	test("closes on a click on the backdrop itself, not on the content inside it", async () => {
		const onclose = vi.fn();
		const { getByTestId } = render(ModalBackdrop, { onclose, children: panel, "data-testid": "backdrop" });
		await fireEvent.click(getByTestId("panel"));
		expect(onclose).not.toHaveBeenCalled();
		await fireEvent.click(getByTestId("backdrop"));
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	test("a click with no onclose does nothing, and other attributes reach the element", async () => {
		const { getByRole } = render(ModalBackdrop, { role: "dialog", "aria-label": "Settings" });
		const backdrop = getByRole("dialog", { name: "Settings" });
		await fireEvent.click(backdrop);
		expect(backdrop).toBeInTheDocument();
	});
});
