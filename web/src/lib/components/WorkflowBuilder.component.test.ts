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
import { blankStep, type StepDraft } from "$lib/workflow-builder-logic.js";
import type { Agent } from "$lib/api.js";

afterEach(() => cleanup());

const agents = [{ name: "alpha" }, { name: "beta" }] as Agent[];

function draft(name: string, overrides: Partial<StepDraft> = {}): StepDraft {
  return { ...blankStep(0), name, agent: "alpha", ...overrides };
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
});
