/**
 * DOM tests for WorkflowBuilder.svelte — the whole-workflow builder form.
 * The pure payload/validation logic lives in workflow-builder-logic.ts
 * (covered separately); this exercises the component-level wiring: initial
 * prop hydration, add/remove step, the rename → sibling-dependsOn remap
 * handler, submit validation surfacing, and the submitting label.
 */

import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, vi } from "vitest";
import WorkflowBuilder from "./WorkflowBuilder.svelte";
import type { StoredStep } from "$lib/workflow-builder-logic.js";
import type { Agent } from "$lib/api.js";

afterEach(() => cleanup());

const agents = [{ name: "alpha" }, { name: "beta" }] as Agent[];

/** A step in the shape the API actually serves — an `input` RECORD, a
 *  `condition` object, a `loop` object. `initial` carries these, not drafts;
 *  the component inflates them via `workflowToDrafts`. */
function draft(name: string, overrides: Partial<StoredStep> = {}): StoredStep {
  return { name, agent: "alpha", ...overrides };
}

function submitForm(container: HTMLElement) {
  return fireEvent.submit(container.querySelector("form") as HTMLFormElement);
}

describe("WorkflowBuilder", () => {
  test("renders defaults (one blank step) and Add Step appends another", async () => {
    const { getByLabelText, getAllByText, getByText } = render(WorkflowBuilder, {
      props: { agents, onsubmit: () => {} },
    });

    expect((getByLabelText("Workflow Name") as HTMLInputElement).value).toBe("");
    expect(getAllByText("Step", { exact: true })).toHaveLength(1);

    await fireEvent.click(getByText("+ Add Step"));
    expect(getAllByText("Step", { exact: true })).toHaveLength(2);
  });

  test("submit surfaces a validation error and does not call onsubmit", async () => {
    const onsubmit = vi.fn();
    const { getByLabelText, getByText, container } = render(WorkflowBuilder, {
      props: { agents, onsubmit },
    });

    // Default blank step has no agent selected.
    await fireEvent.input(getByLabelText("Workflow Name"), { target: { value: "wf" } });
    await submitForm(container);

    expect(getByText('Step "step-1" (agent) needs an agent')).toBeInTheDocument();
    expect(onsubmit).not.toHaveBeenCalled();
  });

  test("hydrates from `initial` and submits the built payload", async () => {
    const onsubmit = vi.fn();
    const { getByLabelText, container } = render(WorkflowBuilder, {
      props: {
        initial: {
          name: "wf",
          description: "demo",
          steps: [draft("s1"), draft("s2", { agent: "beta", dependsOn: ["s1"] })],
        },
        agents,
        onsubmit,
      },
    });

    expect((getByLabelText("Workflow Name") as HTMLInputElement).value).toBe("wf");
    await submitForm(container);

    expect(onsubmit).toHaveBeenCalledWith({
      name: "wf",
      description: "demo",
      steps: [
        { name: "s1", agent: "alpha" },
        { name: "s2", agent: "beta", dependsOn: ["s1"] },
      ],
    });
  });

  test("renaming a step retargets the siblings' dependsOn entries", async () => {
    const onsubmit = vi.fn();
    const { getAllByLabelText, container } = render(WorkflowBuilder, {
      props: {
        initial: {
          name: "wf",
          description: "",
          steps: [draft("s1"), draft("s2", { agent: "beta", dependsOn: ["s1"] })],
        },
        agents,
        onsubmit,
      },
    });

    await fireEvent.input(getAllByLabelText("Step Name")[0]!, { target: { value: "start" } });
    await submitForm(container);

    expect(onsubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          { name: "start", agent: "alpha" },
          { name: "s2", agent: "beta", dependsOn: ["start"] },
        ],
      }),
    );
  });

  test("removing a step prunes it from the siblings' dependsOn", async () => {
    const onsubmit = vi.fn();
    const { getAllByText, container } = render(WorkflowBuilder, {
      props: {
        initial: {
          name: "wf",
          description: "",
          steps: [draft("s1"), draft("s2", { agent: "beta", dependsOn: ["s1"] })],
        },
        agents,
        onsubmit,
      },
    });

    await fireEvent.click(getAllByText("× Remove")[0]!);
    await submitForm(container);

    expect(onsubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [{ name: "s2", agent: "beta" }],
      }),
    );
  });

  test("submitting=true renders the Saving… label and disables the button", () => {
    // Omit `agents` so the component's prop default (`[]`) applies.
    const { getByText } = render(WorkflowBuilder, {
      props: { onsubmit: () => {}, submitting: true } as never,
    });
    const button = getByText("Saving...") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  // ── Edit mode ────────────────────────────────────────────────────
  // The same component serves create and edit. Editing hydrates from a
  // STORED workflow, so the inverse mapping is what these pin.

  test("inflates a stored workflow's every step kind back into editable fields", async () => {
    // The regression this guards: `initial.steps` used to be cast straight
    // to StepDraft[], binding the form to fields a stored step does not
    // have — so an edit rendered blank and saved an erased definition.
    const onsubmit = vi.fn();
    const steps: StoredStep[] = [
      { name: "compose", kind: "transform", output: { headline: "Report on {{$input.topic}}" } },
      {
        name: "assert",
        kind: "gate",
        dependsOn: ["compose"],
        condition: { ref: "$steps.compose.output.headline", op: "contains", value: "Report" },
      },
      { name: "ask", agent: "beta", dependsOn: ["assert"], input: { q: "$prev.output" }, retries: 2 },
    ];
    const { container, getByLabelText } = render(WorkflowBuilder, {
      props: { initial: { name: "wf", description: "d", steps }, agents, onsubmit },
    });

    // Values reached the DOM, not just the payload.
    expect((getByLabelText("Workflow Name") as HTMLInputElement).value).toBe("wf");
    expect((getByLabelText("Retries (0–2)") as HTMLInputElement).value).toBe("2");

    await submitForm(container);
    expect(onsubmit).toHaveBeenCalledWith({ name: "wf", description: "d", steps });
  });

  test("round-trips a looped step's iteration budget and until-condition", async () => {
    const onsubmit = vi.fn();
    const steps: StoredStep[] = [
      {
        name: "count",
        kind: "transform",
        output: { n: "$loop.iteration" },
        loop: {
          maxIterations: 5,
          until: { ref: "$result.output.n", op: "gte", value: 3 },
          onExhausted: "pass",
        },
      },
    ];
    const { container, getByLabelText } = render(WorkflowBuilder, {
      props: { initial: { name: "wf", description: "", steps }, agents, onsubmit },
    });

    expect((getByLabelText("Max iterations (1–25)") as HTMLInputElement).value).toBe("5");
    await submitForm(container);
    expect(onsubmit).toHaveBeenCalledWith(expect.objectContaining({ steps }));
  });

  test("renders a Cancel button only when oncancel is supplied", async () => {
    const oncancel = vi.fn();
    const { queryByTestId, rerender } = render(WorkflowBuilder, {
      props: { agents, onsubmit: () => {} },
    });
    // Create route: nothing to return to.
    expect(queryByTestId("workflow-builder-cancel")).toBeNull();

    await rerender({ agents, onsubmit: () => {}, oncancel });
    const cancel = queryByTestId("workflow-builder-cancel") as HTMLButtonElement;
    expect(cancel).not.toBeNull();
    await fireEvent.click(cancel);
    expect(oncancel).toHaveBeenCalledTimes(1);
  });

  test("loads a SAVED definition into the form, including tool steps and model bindings", async () => {
    // The editor reuses this component with `initial` in API shape. If the
    // form could not represent a tool step or a model binding, saving a
    // loaded workflow would silently delete them.
    const onsubmit = vi.fn();
    const { getByLabelText, getByText } = render(WorkflowBuilder, {
      props: {
        initial: {
          name: "docs",
          description: "d",
          defaultModel: { model: "claude-sonnet-5" },
          steps: [
            { name: "draft", agent: "writer", model: { model: "claude-opus-5" } },
            { name: "publish", kind: "tool", tool: "ext__write" },
          ],
        },
        agents: [{ name: "writer" } as never],
        onsubmit,
        submitLabel: "Save changes",
      },
    });

    expect((getByLabelText("Workflow Name") as HTMLInputElement).value).toBe("docs");
    expect((getByLabelText("Default model (JSON, optional)") as HTMLTextAreaElement).value).toContain(
      "claude-sonnet-5",
    );

    await fireEvent.click(getByText("Save changes"));
    expect(onsubmit).toHaveBeenCalledWith({
      name: "docs",
      description: "d",
      defaultModel: { model: "claude-sonnet-5" },
      steps: [
        { name: "draft", agent: "writer", model: { model: "claude-opus-5" } },
        { name: "publish", kind: "tool", tool: "ext__write" },
      ],
    });
  });

  test("a malformed default model is reported and blocks submit", async () => {
    const onsubmit = vi.fn();
    const { getByLabelText, getByText } = render(WorkflowBuilder, {
      props: {
        initial: { name: "w", description: "", steps: [{ name: "s", agent: "writer" }] },
        agents: [{ name: "writer" } as never],
        onsubmit,
      },
    });

    await fireEvent.input(getByLabelText("Default model (JSON, optional)"), {
      target: { value: "{ nope" },
    });
    await fireEvent.click(getByText("Save Workflow"));

    expect(getByText("Workflow default model is not valid JSON")).toBeTruthy();
    expect(onsubmit).not.toHaveBeenCalled();
  });

  test("the submit label is overridable, so the editor can say Save changes", () => {
    const { getByText } = render(WorkflowBuilder, {
      props: { agents: [], onsubmit: vi.fn(), submitLabel: "Save changes" },
    });
    expect(getByText("Save changes")).toBeTruthy();
  });

  test("a tool step offers the fetched extension tools grouped by extension", async () => {
    // The picker's options come from one /api/extensions fetch made by the
    // builder (not per step), normalized through extension-tool-options.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [
        { id: "notes", name: "Notes", manifest: { tools: [{ name: "add" }, { name: "drop" }] } },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const onsubmit = vi.fn();
    const { container, findByTestId } = render(WorkflowBuilder, {
      props: {
        initial: { name: "wf", description: "", steps: [{ name: "call", kind: "tool" }] },
        agents,
        onsubmit,
      },
    });

    const select = (await findByTestId("step-tool-select")) as HTMLSelectElement;
    await vi.waitFor(() => expect(select.querySelectorAll("optgroup")).toHaveLength(1));
    expect(select.querySelector("optgroup")?.label).toBe("Notes");
    // Values are runtime-namespaced `<ext>__<tool>`, which is what dispatch needs.
    expect([...select.querySelectorAll("option")].map((o) => o.value)).toEqual([
      "",
      "notes__add",
      "notes__drop",
    ]);

    await fireEvent.change(select, { target: { value: "notes__add" } });
    await submitForm(container);
    expect(onsubmit).toHaveBeenCalledWith(
      expect.objectContaining({ steps: [{ name: "call", kind: "tool", tool: "notes__add" }] }),
    );
    vi.unstubAllGlobals();
  });

  test("a tool step with no tool selected is rejected before submit", async () => {
    const onsubmit = vi.fn();
    const { container, getByText } = render(WorkflowBuilder, {
      props: {
        initial: { name: "wf", description: "", steps: [{ name: "call", kind: "tool" }] },
        agents,
        onsubmit,
      },
    });
    await submitForm(container);
    expect(getByText('Step "call" (tool) needs a tool')).toBeInTheDocument();
    expect(onsubmit).not.toHaveBeenCalled();
  });
});
