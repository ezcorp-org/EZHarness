import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, expect, test, vi } from "vitest";
import ComboBox from "./ComboBox.svelte";
import TagInput from "./TagInput.svelte";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function type(input: HTMLElement, value: string) {
  await fireEvent.input(input, { target: { value } });
}

test("ComboBox filters choices and supports keyboard, pointer, Escape, and outside dismissal", async () => {
  const onchange = vi.fn();
  const ui = render(ComboBox, { value: "", options: { options: ["Alpha", "Beta", "Gamma"] }, onchange });
  const input = ui.getByRole("textbox");
  await fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(ui.queryByRole("list")).toBeNull();
  await fireEvent.focus(input);
  await fireEvent.click(input);
  expect(ui.getByRole("button", { name: "Beta" })).toBeVisible();
  await type(input, "a");
  await fireEvent.keyDown(input, { key: "ArrowDown" });
  await fireEvent.keyDown(input, { key: "ArrowDown" });
  await fireEvent.keyDown(input, { key: "ArrowUp" });
  await fireEvent.keyDown(input, { key: "Enter" });
  expect(onchange).toHaveBeenLastCalledWith("Alpha");
  expect(input).toHaveValue("Alpha");
  expect(ui.queryByRole("list")).toBeNull();
  await type(input, "Bet");
  await fireEvent.mouseEnter(ui.getByRole("button", { name: "Beta" }));
  await fireEvent.mouseDown(ui.getByRole("button", { name: "Beta" }));
  expect(onchange).toHaveBeenLastCalledWith("Beta");
  await fireEvent.focus(input);
  await fireEvent.keyDown(input, { key: "Escape" });
  expect(ui.queryByRole("list")).toBeNull();
  await fireEvent.focus(input);
  await fireEvent.click(document.body);
  expect(ui.queryByRole("list")).toBeNull();
});

test.each([false, true])("ComboBox commits only permitted custom text on blur (custom=%s)", async (allowCustom) => {
  vi.useFakeTimers();
  const onchange = vi.fn();
  const ui = render(ComboBox, { value: "Alpha", size: "md", options: { options: ["Alpha"], allowCustom }, onchange });
  const input = ui.getByRole("textbox");
  await type(input, "New value");
  expect(ui.getByText("No results")).toBeVisible();
  await fireEvent.blur(input);
  await vi.advanceTimersByTimeAsync(150);
  expect(input).toHaveValue(allowCustom ? "New value" : "Alpha");
  expect(onchange.mock.calls).toEqual(allowCustom ? [["New value"]] : []);
  expect(ui.queryByRole("list")).toBeNull();
  await ui.rerender({ value: "External" });
  expect(input).toHaveValue("External");
});

test("ComboBox debounces remote search, aborts its predecessor, and clears failed results", async () => {
  vi.useFakeTimers();
  let release!: (response: Response) => void;
  const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(resolve => { release = resolve; }));
  vi.stubGlobal("fetch", fetch);
  const ui = render(ComboBox, { value: "", options: { async: true, fetchUrl: "/choices", debounce: 20 } });
  const input = ui.getByRole("textbox");
  await type(input, "a");
  await type(input, "a b");
  expect(fetch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(20);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toBe("/choices?q=a%20b");
  expect(ui.getByText("Loading...")).toBeVisible();
  release(Response.json(["Alpha beta"]));
  await vi.advanceTimersByTimeAsync(0);
  expect(ui.getByRole("button", { name: "Alpha beta" })).toBeVisible();
  fetch.mockRejectedValueOnce(new Error("Offline"));
  await type(input, "next");
  await vi.advanceTimersByTimeAsync(20);
  expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  expect(ui.getByText("No results")).toBeVisible();
  fetch.mockResolvedValueOnce(Response.json({ invalid: true }));
  await type(input, "invalid");
  await vi.advanceTimersByTimeAsync(20);
  expect(ui.getByText("No results")).toBeVisible();
});

test("ComboBox does not open a disabled control or request an absent remote URL", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const ui = render(ComboBox, { value: "", disabled: true });
  const input = ui.getByRole("textbox");
  expect(input).toBeDisabled();
  await fireEvent.focus(input);
  expect(ui.queryByRole("list")).toBeNull();
  await ui.rerender({ disabled: false, options: { async: true } });
  await type(input, "query");
  await vi.advanceTimersByTimeAsync(300);
  expect(fetch).not.toHaveBeenCalled();
});

test("TagInput selects suggestions by keyboard and pointer, then removes tags", async () => {
  const onchange = vi.fn();
  const ui = render(TagInput, { value: [], options: { suggestions: ["Alpha", "Beta"] }, onchange });
  const input = ui.getByRole("textbox");
  await fireEvent.click(input.parentElement!);
  expect(input).toHaveFocus();
  await fireEvent.keyDown(input, { key: "ArrowDown" });
  await fireEvent.keyDown(input, { key: "ArrowDown" });
  await fireEvent.keyDown(input, { key: "ArrowUp" });
  await fireEvent.keyDown(input, { key: "Enter" });
  expect(onchange).toHaveBeenLastCalledWith(["Alpha"]);
  await type(input, "B");
  const suggestion = ui.getByRole("button", { name: "Beta" });
  await fireEvent.mouseEnter(suggestion);
  await fireEvent.mouseDown(suggestion);
  expect(onchange).toHaveBeenLastCalledWith(["Alpha", "Beta"]);
  await fireEvent.keyDown(input, { key: "Backspace" });
  expect(onchange).toHaveBeenLastCalledWith(["Alpha"]);
  await fireEvent.click(ui.getByRole("button", { name: "×" }));
  expect(onchange).toHaveBeenLastCalledWith([]);
});

test("TagInput trims custom tags, refuses blanks and duplicates, and hides suggestions", async () => {
  vi.useFakeTimers();
  const onchange = vi.fn();
  const ui = render(TagInput, { value: [], size: "md", options: { suggestions: ["Alpha", "Beta"] }, onchange });
  const input = ui.getByRole("textbox");
  for (const value of [" ", " Custom ", "Custom"]) {
    await type(input, value);
    await fireEvent.keyDown(input, { key: "," });
  }
  expect(onchange.mock.calls).toEqual([[["Custom"]]]);
  await type(input, "A");
  await fireEvent.keyDown(input, { key: "Escape" });
  expect(ui.queryByRole("list")).toBeNull();
  await fireEvent.focus(input);
  expect(ui.getByRole("list")).toBeVisible();
  await fireEvent.blur(input);
  await vi.advanceTimersByTimeAsync(150);
  expect(ui.queryByRole("list")).toBeNull();
});

test("TagInput refuses unknown restricted tags and keeps disabled tags intact", async () => {
  const onchange = vi.fn();
  const ui = render(TagInput, { value: ["Alpha"], options: { suggestions: ["Alpha", "Beta"], freeform: false }, onchange });
  const input = ui.getByRole("textbox");
  await type(input, "Unknown");
  await fireEvent.keyDown(input, { key: "Enter" });
  expect(onchange).not.toHaveBeenCalled();
  await ui.rerender({ disabled: true });
  expect(input).toBeDisabled();
  expect(ui.queryByRole("button", { name: "×" })).toBeNull();
  expect(ui.getByText("Alpha")).toBeVisible();
});
