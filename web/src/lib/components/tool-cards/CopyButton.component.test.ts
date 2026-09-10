import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, expect, test, vi } from "vitest";
import CopyButton from "./CopyButton.svelte";

const copy = vi.hoisted(() => vi.fn());
vi.mock("$lib/clipboard.js", () => ({ copyToClipboard: copy }));

afterEach(() => { cleanup(); vi.useRealTimers(); copy.mockReset(); });

test("confirms a successful copy and clears confirmation after two seconds", async () => {
  vi.useFakeTimers();
  copy.mockResolvedValue(true);
  const ui = render(CopyButton, { text: "Tool output" });
  await fireEvent.click(ui.getByRole("button", { name: "Copy output" }));
  expect(copy).toHaveBeenCalledWith("Tool output");
  expect(ui.getByRole("button", { name: "Copied" })).toBeVisible();
  await vi.advanceTimersByTimeAsync(1999);
  expect(ui.getByRole("button", { name: "Copied" })).toBeVisible();
  await vi.advanceTimersByTimeAsync(1);
  expect(ui.getByRole("button", { name: "Copy output" })).toBeVisible();
});

test("does not claim success when the clipboard rejects the copy", async () => {
  copy.mockResolvedValue(false);
  const ui = render(CopyButton, { text: "Unavailable" });
  await fireEvent.click(ui.getByRole("button", { name: "Copy output" }));
  expect(copy).toHaveBeenCalledWith("Unavailable");
  expect(ui.queryByRole("button", { name: "Copied" })).toBeNull();
});
