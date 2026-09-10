import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, expect, test, vi } from "vitest";
import type { ComponentProps } from "svelte";
import InlineToolForm from "./InlineToolForm.svelte";

type Tool = ComponentProps<typeof InlineToolForm>["tool"];
const tool: Tool = {
  name: "search", description: "Search records",
  inputSchema: {
    type: "object", required: ["query"], properties: {
      query: { type: "string", description: "Search text", "x-shared": "search.query" },
      count: { type: "integer" }, enabled: { type: "boolean" },
      mode: { type: "string", enum: ["fast", "full"] },
      filter: { type: "object" }, unused: { type: "string" },
    },
  },
};
afterEach(() => cleanup());

function mount(overrides: Partial<ComponentProps<typeof InlineToolForm>> = {}) {
  const onconfirm = vi.fn();
  const onclose = vi.fn();
  return { ...render(InlineToolForm, { tool, extensionName: "records", onconfirm, onclose, ...overrides }), onconfirm, onclose };
}

test("validates required and JSON fields, then submits typed values without empty optional fields", async () => {
  const ui = mount();
  const form = ui.container.querySelector("form")!;
  await fireEvent.submit(form);
  expect(ui.getByText("Required")).toBeVisible();
  expect(ui.onconfirm).not.toHaveBeenCalled();
  await fireEvent.input(ui.getByLabelText(/query/), { target: { value: "Report" } });
  await fireEvent.input(ui.getByLabelText("count"), { target: { value: "3" } });
  await fireEvent.click(ui.getByLabelText("enabled"));
  await fireEvent.change(ui.getByLabelText("mode"), { target: { value: "full" } });
  await fireEvent.input(ui.getByLabelText("filter"), { target: { value: "invalid" } });
  await fireEvent.submit(form);
  expect(ui.getByText("Must be valid JSON")).toBeVisible();
  expect(ui.onconfirm).not.toHaveBeenCalled();
  await fireEvent.input(ui.getByLabelText("filter"), { target: { value: '{"active":true}' } });
  await fireEvent.submit(form);
  expect(ui.onconfirm).toHaveBeenCalledWith({ query: "Report", count: 3, enabled: true, mode: "full", filter: { active: true } });
  expect(ui.queryByText("Required")).toBeNull();
});

test("initial values override shared defaults and invalid stored numbers do not submit", async () => {
  const ui = mount({ initialValues: { query: "Initial", count: "not a number" }, sharedValues: { "search.query": "Shared" } });
  expect(ui.getByLabelText(/query/)).toHaveValue("Initial");
  await fireEvent.submit(ui.container.querySelector("form")!);
  expect(ui.getByText("Must be a valid number")).toBeVisible();
  expect(ui.onconfirm).not.toHaveBeenCalled();
  await ui.rerender({ initialValues: {}, sharedValues: { "search.query": "Shared" } });
  expect(ui.getByLabelText(/query/)).toHaveValue("Shared");
});

test("formatted array tags remain arrays and string tags become text", async () => {
  const formatted: Tool = {
    name: "tags", description: "Tag records", inputSchema: { type: "object", properties: {
      arrayTags: { type: "array", format: "tag-input" },
      textTags: { type: "string", format: "tag-input" },
      plain: { type: "string", format: "text" },
    } },
  };
  const ui = mount({ tool: formatted, initialValues: { arrayTags: ["one"], textTags: ["two", "three"], plain: "Label" } });
  await fireEvent.submit(ui.container.querySelector("form")!);
  expect(ui.onconfirm).toHaveBeenCalledWith({ arrayTags: ["one"], textTags: "two, three", plain: "Label" });
});

test("parameter-free tools submit and dismiss from Cancel, Escape, or the outside wrapper", async () => {
  const ui = mount({ tool: { name: "refresh", description: "Refresh", inputSchema: {} } });
  expect(ui.getByText(/No parameters required/)).toBeVisible();
  await fireEvent.submit(ui.container.querySelector("form")!);
  expect(ui.onconfirm).toHaveBeenCalledWith({});
  await fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
  expect(ui.onclose).toHaveBeenCalledTimes(1);
  ui.onclose.mockClear();
  await fireEvent.keyDown(ui.container.querySelector("form")!, { key: "Escape" });
  expect(ui.onclose).toHaveBeenCalled();
  const beforeOutside = ui.onclose.mock.calls.length;
  await fireEvent.click(ui.container.firstElementChild!);
  expect(ui.onclose).toHaveBeenCalledTimes(beforeOutside + 1);
});

test("unsupported formats are visible instead of creating an unusable field", () => {
  const ui = mount({ tool: { name: "unknown", description: "Unknown", inputSchema: { properties: { field: { type: "string", format: "missing-widget" } } } } });
  expect(ui.getByText('Unrecognized format: "missing-widget"')).toBeVisible();
});
