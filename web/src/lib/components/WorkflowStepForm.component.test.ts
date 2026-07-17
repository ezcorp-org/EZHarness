/**
 * DOM tests for WorkflowStepForm.svelte — the per-step editor row of the
 * workflow builder. The pure payload logic lives in
 * workflow-builder-logic.ts (covered separately); this exercises the
 * component-level bindings and the kind-conditional sections: the input/
 * output pair add/remove handlers, the depends-on toggle, the loop + retries
 * visibility rules, and that a transform step hides the (executor-ignored)
 * Input Mapping editor.
 *
 * Each kind/branch is rendered from its initial draft state (rather than
 * relying on prop-object re-render after a click), and the add/remove/toggle
 * handlers are asserted via the mutated draft they operate on.
 */

import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, vi } from "vitest";
import WorkflowStepForm from "./WorkflowStepForm.svelte";
import { blankStep, type StepDraft } from "$lib/workflow-builder-logic.js";

afterEach(() => cleanup());

function step(overrides: Partial<StepDraft> = {}): StepDraft {
  return { ...blankStep(0), ...overrides };
}

/** The pair-remove buttons render "×"; the step-remove button is "× Remove". */
function pairRemoveButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button")).filter(
    (b) => b.textContent?.trim() === "×",
  ) as HTMLButtonElement[];
}

describe("WorkflowStepForm", () => {
  test("agent kind (loop off): agent select, input pairs add/remove, depends-on, remove", async () => {
    const s = step({
      name: "s1",
      kind: "agent",
      inputPairs: [{ key: "a", value: "$input.x" }],
    });
    const onremove = vi.fn();
    const { getByText, getByPlaceholderText, container } = render(WorkflowStepForm, {
      props: { step: s, agents: [{ name: "writer" } as never], allStepNames: ["s1", "s2"], onremove },
    });

    // Agent-only sections render (the "-- Select Agent --" option is unique to
    // the agent field; the kind dropdown's "Agent" option is not).
    expect(getByText("-- Select Agent --")).toBeInTheDocument();
    expect(getByText("Input Mapping")).toBeInTheDocument();
    expect(getByText("Retries (0–2)")).toBeInTheDocument();
    expect(getByPlaceholderText("field")).toBeInTheDocument();

    // addInputPair grows the draft's inputPairs.
    await fireEvent.click(getByText("+ Add"));
    expect(s.inputPairs.length).toBe(2);

    // removeInputPair shrinks it (click the first pair's × button).
    await fireEvent.click(pairRemoveButtons(container)[0]!);
    expect(s.inputPairs.length).toBe(1);

    // toggleDep adds then removes the sibling step name.
    const depCheckbox = getByText("s2").querySelector("input") as HTMLInputElement;
    await fireEvent.click(depCheckbox);
    expect(s.dependsOn).toContain("s2");
    await fireEvent.click(depCheckbox);
    expect(s.dependsOn).not.toContain("s2");

    // The remove button invokes onremove.
    await fireEvent.click(getByText("× Remove"));
    expect(onremove).toHaveBeenCalledTimes(1);
  });

  test("typing in Step Name updates the draft and notifies onnamechange(old, new)", async () => {
    const s = step({ name: "s1" });
    const onnamechange = vi.fn();
    const { getByLabelText } = render(WorkflowStepForm, {
      props: { step: s, agents: [], allStepNames: ["s1"], onremove: () => {}, onnamechange },
    });

    await fireEvent.input(getByLabelText("Step Name"), { target: { value: "renamed" } });
    expect(s.name).toBe("renamed");
    expect(onnamechange).toHaveBeenCalledWith("s1", "renamed");
  });

  test("Step Name input still applies the rename without an onnamechange prop", async () => {
    const s = step({ name: "s1" });
    const { getByLabelText } = render(WorkflowStepForm, {
      props: { step: s, agents: [], allStepNames: ["s1"], onremove: () => {} },
    });

    await fireEvent.input(getByLabelText("Step Name"), { target: { value: "solo" } });
    expect(s.name).toBe("solo");
  });

  test("agent kind (loop on): loop fields render and retries is hidden", () => {
    const s = step({ name: "s1", kind: "agent", loopEnabled: true });
    const { getByText, queryByText } = render(WorkflowStepForm, {
      props: { step: s, agents: [], allStepNames: ["s1"], onremove: () => {} },
    });

    expect(getByText("Max iterations (1–25)")).toBeInTheDocument();
    expect(getByText("On exhausted")).toBeInTheDocument();
    // Retries is agent-only AND loop-off-only.
    expect(queryByText("Retries (0–2)")).toBeNull();
  });

  test("transform kind: output pairs add/remove, loop present, input mapping hidden", async () => {
    const s = step({
      name: "t1",
      kind: "transform",
      outputPairs: [{ key: "o", value: "literal" }],
    });
    const { getByText, queryByText, container } = render(WorkflowStepForm, {
      props: { step: s, agents: [], allStepNames: ["t1"], onremove: () => {} },
    });

    expect(getByText("Output Mapping")).toBeInTheDocument();
    expect(getByText("Loop this step")).toBeInTheDocument();
    // Input Mapping + agent select + retries are hidden for a transform.
    expect(queryByText("Input Mapping")).toBeNull();
    expect(queryByText("-- Select Agent --")).toBeNull();
    expect(queryByText("Retries (0–2)")).toBeNull();

    await fireEvent.click(getByText("+ Add"));
    expect(s.outputPairs.length).toBe(2);
    await fireEvent.click(pairRemoveButtons(container)[0]!);
    expect(s.outputPairs.length).toBe(1);
  });

  test("gate kind: condition editor only — no input/output/loop/retries", () => {
    const s = step({ name: "g1", kind: "gate" });
    // Omit agents/allStepNames so the component's prop defaults (`[]`) apply.
    const { getByText, queryByText } = render(WorkflowStepForm, {
      props: { step: s, onremove: () => {} } as never,
    });

    expect(getByText("Condition (JSON)")).toBeInTheDocument();
    expect(queryByText("Input Mapping")).toBeNull();
    expect(queryByText("Output Mapping")).toBeNull();
    expect(queryByText("Loop this step")).toBeNull();
    expect(queryByText("Retries (0–2)")).toBeNull();
  });
});
