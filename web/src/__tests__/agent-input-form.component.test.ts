import "@testing-library/jest-dom/vitest";
import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";
import AgentInputForm from "$lib/components/AgentInputForm.svelte";
import type { InputSchema } from "$lib/api.js";

const schema: InputSchema = {
	title: { type: "text", label: "Task title", required: true, description: "What should the agent do?" },
	attempts: { type: "number", label: "Attempts", default: 1 },
	enabled: { type: "boolean", label: "Enable follow-up" },
	mode: { type: "select", label: "Mode", options: ["safe", "fast"] },
	custom: { type: "custom", label: "Custom instruction", component: "missing.svelte" },
	path: { type: "file-path", label: "Working tree", description: "Choose a directory" },
};

describe("AgentInputForm", () => {
	test("requires the declared input before running an agent", async () => {
		const onsubmit = vi.fn();
		const { getByText, container } = render(AgentInputForm, { schema, onsubmit });
		await fireEvent.submit(container.querySelector("form")!);
		expect(getByText("Task title is required")).toBeInTheDocument();
		expect(onsubmit).not.toHaveBeenCalled();
	});

	test("submits typed fields, preserves false boolean values, and adds project variables", async () => {
		const onsubmit = vi.fn();
		const { container, getByLabelText, getByText } = render(AgentInputForm, {
			schema,
			onsubmit,
			projectVariables: { repository: "ezcorp", retries: 3, dryRun: false },
		});
		expect(getByText("Project Variables")).toBeInTheDocument();
		await fireEvent.input(getByLabelText(/Task title/), { target: { value: "Audit coverage" } });
		await fireEvent.input(getByLabelText("Attempts"), { target: { value: "4" } });
		await fireEvent.click(getByLabelText("Enable follow-up"));
		await fireEvent.change(getByLabelText("Mode"), { target: { value: "safe" } });
		await fireEvent.input(getByLabelText("Custom instruction"), { target: { value: "Use the release checklist" } });
		await fireEvent.submit(container.querySelector("form")!);
		expect(onsubmit).toHaveBeenCalledWith({
			title: "Audit coverage",
			attempts: 4,
			enabled: true,
			mode: "safe",
			custom: "Use the release checklist",
			repository: "ezcorp",
			retries: 3,
			dryRun: false,
		});
	});

	test("omits empty optional text while retaining an unchecked boolean", async () => {
		const onsubmit = vi.fn();
		const { container, getByLabelText } = render(AgentInputForm, {
			schema: { required: { type: "string", label: "Required", required: true }, notify: { type: "boolean", label: "Notify" }, note: { type: "string", label: "Note" } },
			onsubmit,
		});
		await fireEvent.input(getByLabelText(/Required/), { target: { value: "go" } });
		await fireEvent.submit(container.querySelector("form")!);
		expect(onsubmit).toHaveBeenCalledWith({ required: "go", notify: false });
	});
});
