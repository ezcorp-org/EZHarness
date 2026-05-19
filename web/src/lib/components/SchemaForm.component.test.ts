/**
 * DOM tests for the generic <SchemaForm/> component.
 *
 * Pins:
 *   - each of the four field types renders correct DOM (select options,
 *     text minlength/maxlength/pattern, number min/max/step + integer→1)
 *   - changing a value fires `oninput` with the merged blob
 *   - submit fires `onsubmit` with the current values
 *   - empty schema renders the "No configurable settings" placeholder
 */

import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import SchemaForm from "./SchemaForm.svelte";
import type { SettingsSchema } from "$server/extensions/types";

afterEach(() => cleanup());

describe("SchemaForm — empty schema", () => {
  test("renders 'No configurable settings' when schema is empty", () => {
    const { getByTestId, queryByTestId } = render(SchemaForm, {
      schema: {} as SettingsSchema,
      values: {},
    });
    expect(getByTestId("schema-form-empty")).toBeInTheDocument();
    expect(queryByTestId("schema-form")).toBeNull();
  });
});

describe("SchemaForm — select field", () => {
  const schema: SettingsSchema = {
    voice: {
      type: "select",
      label: "Voice",
      description: "Speaker timbre.",
      options: [
        { value: "a", label: "Bella" },
        { value: "b", label: "Sarah" },
      ],
      default: "a",
    },
  };

  test("renders <select> with one <option> per entry", () => {
    const { getByTestId } = render(SchemaForm, { schema, values: { voice: "a" } });
    const select = getByTestId("schema-input-voice") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.querySelectorAll("option").length).toBe(2);
    expect(select.value).toBe("a");
  });

  test("renders the description below the label", () => {
    const { getByText } = render(SchemaForm, { schema, values: { voice: "a" } });
    expect(getByText("Speaker timbre.")).toBeInTheDocument();
  });

  test("change emits oninput with the merged blob", async () => {
    const oninput = vi.fn();
    const { getByTestId } = render(SchemaForm, {
      schema,
      values: { voice: "a", other: "x" },
      oninput,
    });
    const select = getByTestId("schema-input-voice") as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: "b" } });
    expect(oninput).toHaveBeenCalledTimes(1);
    expect(oninput).toHaveBeenCalledWith({ voice: "b", other: "x" });
  });

  test("falls back to field.default when value is missing", () => {
    const { getByTestId } = render(SchemaForm, { schema, values: {} });
    const select = getByTestId("schema-input-voice") as HTMLSelectElement;
    expect(select.value).toBe("a");
  });
});

describe("SchemaForm — text field", () => {
  const schema: SettingsSchema = {
    name: {
      type: "text",
      label: "Name",
      minLength: 2,
      maxLength: 32,
      pattern: "^[a-z]+$",
    },
  };

  test("renders <input type=text> with min/max/pattern attrs", () => {
    const { getByTestId } = render(SchemaForm, { schema, values: { name: "hi" } });
    const input = getByTestId("schema-input-name") as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.getAttribute("minlength")).toBe("2");
    expect(input.getAttribute("maxlength")).toBe("32");
    expect(input.getAttribute("pattern")).toBe("^[a-z]+$");
  });

  test("typing emits oninput", async () => {
    const oninput = vi.fn();
    const { getByTestId } = render(SchemaForm, {
      schema,
      values: { name: "" },
      oninput,
    });
    const input = getByTestId("schema-input-name") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "abc" } });
    expect(oninput).toHaveBeenCalledWith({ name: "abc" });
  });
});

describe("SchemaForm — number field", () => {
  const schema: SettingsSchema = {
    speed: {
      type: "number",
      label: "Speed",
      min: 0.5,
      max: 2.0,
      step: 0.05,
      default: 1.0,
    },
    count: {
      type: "number",
      label: "Count",
      integer: true,
    },
  };

  test("renders <input type=number> with min/max/step", () => {
    const { getByTestId } = render(SchemaForm, { schema, values: { speed: 1.0, count: 0 } });
    const input = getByTestId("schema-input-speed") as HTMLInputElement;
    expect(input.type).toBe("number");
    expect(input.getAttribute("min")).toBe("0.5");
    expect(input.getAttribute("max")).toBe("2");
    expect(input.getAttribute("step")).toBe("0.05");
  });

  test("integer:true forces step=1", () => {
    const { getByTestId } = render(SchemaForm, { schema, values: { speed: 1, count: 0 } });
    const input = getByTestId("schema-input-count") as HTMLInputElement;
    expect(input.getAttribute("step")).toBe("1");
  });

  test("input coerces to number before emitting", async () => {
    const oninput = vi.fn();
    const { getByTestId } = render(SchemaForm, {
      schema,
      values: { speed: 1.0, count: 0 },
      oninput,
    });
    const input = getByTestId("schema-input-speed") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "1.5" } });
    expect(oninput).toHaveBeenCalledWith({ speed: 1.5, count: 0 });
  });

  test("integer field parses with parseInt", async () => {
    const oninput = vi.fn();
    const { getByTestId } = render(SchemaForm, {
      schema,
      values: { speed: 1, count: 0 },
      oninput,
    });
    const input = getByTestId("schema-input-count") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "7" } });
    expect(oninput).toHaveBeenCalledWith({ speed: 1, count: 7 });
  });

  test("empty string value emits empty string back", async () => {
    const oninput = vi.fn();
    const { getByTestId } = render(SchemaForm, {
      schema,
      values: { speed: 1, count: 0 },
      oninput,
    });
    const input = getByTestId("schema-input-speed") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "" } });
    expect(oninput).toHaveBeenCalledWith({ speed: "", count: 0 });
  });
});

describe("SchemaForm — boolean field", () => {
  const schema: SettingsSchema = {
    enabled: {
      type: "boolean",
      label: "Enabled",
      default: true,
    },
  };

  test("renders <input type=checkbox> with checked from values", () => {
    const { getByTestId } = render(SchemaForm, { schema, values: { enabled: false } });
    const input = getByTestId("schema-input-enabled") as HTMLInputElement;
    expect(input.type).toBe("checkbox");
    expect(input.checked).toBe(false);
  });

  test("toggling emits oninput with new boolean", async () => {
    const oninput = vi.fn();
    const { getByTestId } = render(SchemaForm, {
      schema,
      values: { enabled: false },
      oninput,
    });
    const input = getByTestId("schema-input-enabled") as HTMLInputElement;
    await fireEvent.click(input);
    expect(oninput).toHaveBeenCalledWith({ enabled: true });
  });

  test("default applied when value missing", () => {
    const { getByTestId } = render(SchemaForm, { schema, values: {} });
    const input = getByTestId("schema-input-enabled") as HTMLInputElement;
    expect(input.checked).toBe(true);
  });
});

describe("SchemaForm — submission", () => {
  const schema: SettingsSchema = {
    name: { type: "text", label: "Name" },
  };

  test("submit fires onsubmit with current values", async () => {
    const onsubmit = vi.fn();
    const { getByTestId } = render(SchemaForm, {
      schema,
      values: { name: "claude" },
      onsubmit,
    });
    const form = getByTestId("schema-form") as HTMLFormElement;
    await fireEvent.submit(form);
    expect(onsubmit).toHaveBeenCalledTimes(1);
    expect(onsubmit).toHaveBeenCalledWith({ name: "claude" });
  });

  test("disabled form does not fire onsubmit", async () => {
    const onsubmit = vi.fn();
    const { getByTestId } = render(SchemaForm, {
      schema,
      values: { name: "claude" },
      disabled: true,
      onsubmit,
    });
    const form = getByTestId("schema-form") as HTMLFormElement;
    await fireEvent.submit(form);
    expect(onsubmit).not.toHaveBeenCalled();
  });

  test("disabled form disables every field control", () => {
    const fullSchema: SettingsSchema = {
      a: { type: "text", label: "A" },
      b: { type: "number", label: "B" },
      c: { type: "boolean", label: "C" },
      d: { type: "select", label: "D", options: [{ value: "x", label: "X" }] },
    };
    const { getByTestId } = render(SchemaForm, {
      schema: fullSchema,
      values: { a: "", b: 0, c: false, d: "x" },
      disabled: true,
    });
    expect((getByTestId("schema-input-a") as HTMLInputElement).disabled).toBe(true);
    expect((getByTestId("schema-input-b") as HTMLInputElement).disabled).toBe(true);
    expect((getByTestId("schema-input-c") as HTMLInputElement).disabled).toBe(true);
    expect((getByTestId("schema-input-d") as HTMLSelectElement).disabled).toBe(true);
  });

  test("onsubmit can be omitted without throwing", async () => {
    const { getByTestId } = render(SchemaForm, {
      schema,
      values: { name: "x" },
    });
    const form = getByTestId("schema-form") as HTMLFormElement;
    // No-throw is the contract — fireEvent.submit returns false when
    // preventDefault was called, which is expected here.
    await fireEvent.submit(form);
    expect(true).toBe(true);
  });
});
