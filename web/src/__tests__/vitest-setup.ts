/**
 * vitest setup for Svelte component DOM tests.
 * - Pulls in @testing-library/jest-dom matchers (toBeInTheDocument, etc.)
 * - Cleans up mounted components between tests so DOM queries don't leak.
 * - Stubs URL.createObjectURL / revokeObjectURL since jsdom's default
 *   implementation throws; the ChatInput thumbnail effect relies on them.
 */

import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/svelte";

afterEach(() => cleanup());

if (typeof URL.createObjectURL !== "function" || URL.createObjectURL.toString().includes("not implemented")) {
	let counter = 0;
	URL.createObjectURL = (_blob: Blob) => `blob:mock://${++counter}`;
	URL.revokeObjectURL = () => {};
}
