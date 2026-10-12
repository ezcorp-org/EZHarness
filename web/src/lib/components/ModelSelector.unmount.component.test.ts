/**
 * The picker retries /api/models with backoff when it fails. Once the picker
 * unmounts (the user left the page), the retries stop: no more requests, and
 * no "Failed to load models" toast on whatever page the user is on now.
 */
import { render } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock("$lib/toast.svelte.js", () => ({ addToast }));

import ModelSelector from "./ModelSelector.svelte";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	addToast.mockClear();
});

describe("ModelSelector model-list retry", () => {
	test("stops retrying and never toasts after unmount", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async () => new Response("down", { status: 503 }));
		vi.stubGlobal("fetch", fetchMock);
		const view = render(ModelSelector, { selected: null, onselect: () => {} });
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		view.unmount();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(addToast).not.toHaveBeenCalled();
	});
});
