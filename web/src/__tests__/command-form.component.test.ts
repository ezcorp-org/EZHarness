/**
 * CommandForm prop / event surface tests.
 *
 * Coverage targets:
 *   - Required name + slug validation surfaces inline (no submit fires).
 *   - Body byte counter increments live; over-limit disables submit.
 *   - Disabled `name` input on edit mode + payload omits `name`.
 *   - Model dropdown populates from /api/models when present.
 *   - onsubmit receives a normalized frontmatter object with empty
 *     strings dropped and only the documented keys included.
 *   - Cancel callback fires when oncancel handler is provided.
 */

import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";

// Default fetch mock: empty model list (advisory only, never required).
beforeEach(() => {
	vi.restoreAllMocks();
	const fetchMock = vi.fn(async (url: string) => {
		if (url === "/api/models") {
			return new Response(
				JSON.stringify([
					{ provider: "anthropic", model: "claude-3-5-sonnet" },
					{ provider: "openai", model: "gpt-4o" },
					// Dup to confirm Set-dedup behavior in the component.
					{ provider: "openai", model: "gpt-4o" },
				]),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response("{}", { status: 200 });
	});
	(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

import CommandForm from "$lib/components/CommandForm.svelte";

describe("CommandForm — create mode", () => {
	test("name field is enabled and required", () => {
		const { getByTestId } = render(CommandForm, {
			onsubmit: vi.fn(),
		});
		const name = getByTestId("command-form-name") as HTMLInputElement;
		expect(name.disabled).toBe(false);
		expect(name.required).toBe(true);
	});

	test("submit blocked + inline error when name is empty", async () => {
		const onsubmit = vi.fn();
		const { getByTestId } = render(CommandForm, { onsubmit });
		await fireEvent.input(getByTestId("command-form-body"), {
			target: { value: "non-empty body" },
		});
		await fireEvent.submit(getByTestId("command-form"));
		expect(onsubmit).not.toHaveBeenCalled();
		expect(getByTestId("command-form-name-error")).toHaveTextContent("Name is required");
	});

	test("submit blocked + inline error when slug invalid (uppercase / spaces)", async () => {
		const onsubmit = vi.fn();
		const { getByTestId } = render(CommandForm, { onsubmit });
		await fireEvent.input(getByTestId("command-form-name"), {
			target: { value: "My Review" },
		});
		await fireEvent.input(getByTestId("command-form-body"), {
			target: { value: "body" },
		});
		await fireEvent.submit(getByTestId("command-form"));
		expect(onsubmit).not.toHaveBeenCalled();
		expect(getByTestId("command-form-name-error")).toHaveTextContent(/lowercase alphanumeric/i);
	});

	test("submit success emits payload including name + filtered frontmatter", async () => {
		const onsubmit = vi.fn();
		const { getByTestId } = render(CommandForm, { onsubmit });
		await fireEvent.input(getByTestId("command-form-name"), { target: { value: "myreview" } });
		await fireEvent.input(getByTestId("command-form-description"), { target: { value: "Review staged changes" } });
		await fireEvent.input(getByTestId("command-form-argument-hint"), { target: { value: "<file>" } });
		await fireEvent.input(getByTestId("command-form-agent"), { target: { value: "" } });
		await fireEvent.input(getByTestId("command-form-model"), { target: { value: "claude-3-5-sonnet" } });
		await fireEvent.input(getByTestId("command-form-body"), { target: { value: "Review: $ARGUMENTS" } });
		await fireEvent.submit(getByTestId("command-form"));

		expect(onsubmit).toHaveBeenCalledTimes(1);
		const payload = onsubmit.mock.calls[0]![0];
		expect(payload).toMatchObject({
			name: "myreview",
			description: "Review staged changes",
			body: "Review: $ARGUMENTS",
		});
		// Empty `agent` was dropped; argument-hint and model kept.
		expect(payload.frontmatter).toEqual({
			"argument-hint": "<file>",
			model: "claude-3-5-sonnet",
		});
	});

	test("body byte counter updates as user types", async () => {
		const { getByTestId } = render(CommandForm, { onsubmit: vi.fn() });
		const counter = getByTestId("command-form-body-bytes");
		expect(counter).toHaveTextContent("0 / 65536 bytes");
		await fireEvent.input(getByTestId("command-form-body"), {
			target: { value: "hello" },
		});
		expect(counter).toHaveTextContent("5 / 65536 bytes");
	});

	test("oversize body disables submit + surfaces inline error", async () => {
		const onsubmit = vi.fn();
		const { getByTestId } = render(CommandForm, { onsubmit });
		await fireEvent.input(getByTestId("command-form-name"), { target: { value: "x" } });
		await fireEvent.input(getByTestId("command-form-body"), {
			target: { value: "x".repeat(64 * 1024 + 1) },
		});
		const submit = getByTestId("command-form-submit") as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		// Submit click does nothing while disabled. Even if the user
		// programmatically submits the form, validate() blocks.
		await fireEvent.submit(getByTestId("command-form"));
		expect(onsubmit).not.toHaveBeenCalled();
		expect(getByTestId("command-form-body-error")).toHaveTextContent(/exceeds 64 KB/i);
	});

	test("model dropdown populates from /api/models with dedup", async () => {
		const { container } = render(CommandForm, { onsubmit: vi.fn() });
		await waitFor(() => {
			const opts = container.querySelectorAll("#cmd-model-options option");
			expect(opts.length).toBe(2);
		});
		const values = Array.from(
			container.querySelectorAll<HTMLOptionElement>("#cmd-model-options option"),
		).map((o) => o.value);
		expect(values).toEqual(["claude-3-5-sonnet", "gpt-4o"]);
	});

	test("model fetch failure degrades gracefully — form still submits", async () => {
		(globalThis as { fetch: typeof fetch }).fetch = vi.fn(async () =>
			new Response("Boom", { status: 500 }),
		) as unknown as typeof fetch;
		const onsubmit = vi.fn();
		const { getByTestId, container } = render(CommandForm, { onsubmit });
		// No options populated.
		expect(container.querySelectorAll("#cmd-model-options option").length).toBe(0);
		// Submit still works.
		await fireEvent.input(getByTestId("command-form-name"), { target: { value: "x" } });
		await fireEvent.input(getByTestId("command-form-body"), { target: { value: "b" } });
		await fireEvent.submit(getByTestId("command-form"));
		expect(onsubmit).toHaveBeenCalledTimes(1);
	});

	test("oncancel fires when cancel handler provided", async () => {
		const oncancel = vi.fn();
		const { getByTestId } = render(CommandForm, {
			onsubmit: vi.fn(),
			oncancel,
		});
		await fireEvent.click(getByTestId("command-form-cancel"));
		expect(oncancel).toHaveBeenCalledTimes(1);
	});

	test("no Cancel button rendered when oncancel is absent", () => {
		const { queryByTestId } = render(CommandForm, { onsubmit: vi.fn() });
		expect(queryByTestId("command-form-cancel")).toBeNull();
	});

	test("submitting=true disables submit + swaps label", async () => {
		const { getByTestId } = render(CommandForm, {
			onsubmit: vi.fn(),
			submitting: true,
		});
		const submit = getByTestId("command-form-submit") as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		expect(submit).toHaveTextContent(/saving/i);
	});
});

describe("CommandForm — edit mode", () => {
	test("name input is disabled + payload omits name", async () => {
		const onsubmit = vi.fn();
		const { getByTestId } = render(CommandForm, {
			mode: "edit",
			initial: {
				name: "review",
				description: "old",
				body: "old body",
				frontmatter: { agent: "bot" },
			},
			onsubmit,
		});
		const name = getByTestId("command-form-name") as HTMLInputElement;
		expect(name.disabled).toBe(true);
		expect(name.value).toBe("review");

		await fireEvent.input(getByTestId("command-form-body"), {
			target: { value: "new body" },
		});
		await fireEvent.submit(getByTestId("command-form"));

		expect(onsubmit).toHaveBeenCalledTimes(1);
		const payload = onsubmit.mock.calls[0]![0];
		expect(payload.name).toBeUndefined();
		expect(payload.body).toBe("new body");
		expect(payload.frontmatter).toEqual({ agent: "bot" });
	});

	test("pre-populates every field from initial", () => {
		const { getByTestId } = render(CommandForm, {
			mode: "edit",
			initial: {
				name: "review",
				description: "desc-here",
				body: "body-here",
				frontmatter: {
					"argument-hint": "<file>",
					agent: "the-agent",
					model: "gpt-4o",
				},
			},
			onsubmit: vi.fn(),
		});
		expect((getByTestId("command-form-name") as HTMLInputElement).value).toBe("review");
		expect((getByTestId("command-form-description") as HTMLInputElement).value).toBe("desc-here");
		expect((getByTestId("command-form-argument-hint") as HTMLInputElement).value).toBe("<file>");
		expect((getByTestId("command-form-agent") as HTMLInputElement).value).toBe("the-agent");
		expect((getByTestId("command-form-model") as HTMLInputElement).value).toBe("gpt-4o");
		expect((getByTestId("command-form-body") as HTMLTextAreaElement).value).toBe("body-here");
	});

	test("edit mode skips slug validation (name disabled, value preserved)", async () => {
		const onsubmit = vi.fn();
		const { getByTestId, queryByTestId } = render(CommandForm, {
			mode: "edit",
			initial: { name: "Already-Bad-Slug-Saved-Long-Ago", body: "ok" },
			onsubmit,
		});
		await fireEvent.submit(getByTestId("command-form"));
		expect(queryByTestId("command-form-name-error")).toBeNull();
		expect(onsubmit).toHaveBeenCalledTimes(1);
	});
});
