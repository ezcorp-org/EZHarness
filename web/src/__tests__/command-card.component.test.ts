/**
 * CommandCard prop / event surface tests.
 *
 * Covers: every prop renders, optional buttons hide when handlers are
 * absent, edit/delete callbacks fire on click, empty description
 * surfaces the placeholder dash, data-source carries the registry
 * source value so the popover round-trip assertion has a hook.
 */

import "@testing-library/jest-dom/vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi } from "vitest";
import CommandCard from "$lib/components/CommandCard.svelte";

function makeCommand(overrides: Partial<{ id: string; userId: string; name: string; description: string; body: string; frontmatter: Record<string, string>; createdAt: string; updatedAt: string }> = {}) {
	return {
		id: "c1",
		userId: "u1",
		name: "review",
		description: "Review staged changes",
		body: "Review: $ARGUMENTS",
		frontmatter: {},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("CommandCard", () => {
	test("renders the slash-prefixed name and the description", () => {
		const { getByText, getByTestId } = render(CommandCard, {
			command: makeCommand(),
		});
		expect(getByText("/review")).toBeInTheDocument();
		expect(getByTestId("command-card-description")).toHaveTextContent("Review staged changes");
	});

	test("renders the 'Saved' source badge with the registry source as data-source", () => {
		const { getByText, getByTestId } = render(CommandCard, {
			command: makeCommand(),
		});
		expect(getByText("Saved")).toBeInTheDocument();
		expect(getByTestId("command-card")).toHaveAttribute("data-source", "user:db");
	});

	test("falls back to a dash when description is empty", () => {
		const { getByTestId } = render(CommandCard, {
			command: makeCommand({ description: "" }),
		});
		expect(getByTestId("command-card-description")).toHaveTextContent("—");
	});

	test("does NOT render edit/delete buttons when no callbacks given", () => {
		const { queryByTestId } = render(CommandCard, {
			command: makeCommand(),
		});
		expect(queryByTestId("command-card-edit")).toBeNull();
		expect(queryByTestId("command-card-delete")).toBeNull();
	});

	test("clicking edit fires onedit", async () => {
		const onedit = vi.fn();
		const { getByTestId } = render(CommandCard, {
			command: makeCommand(),
			onedit,
		});
		await fireEvent.click(getByTestId("command-card-edit"));
		expect(onedit).toHaveBeenCalledTimes(1);
	});

	test("clicking delete fires ondelete", async () => {
		const ondelete = vi.fn();
		const { getByTestId } = render(CommandCard, {
			command: makeCommand(),
			ondelete,
		});
		await fireEvent.click(getByTestId("command-card-delete"));
		expect(ondelete).toHaveBeenCalledTimes(1);
	});

	test("renders both buttons independently when both callbacks given", () => {
		const { getByTestId } = render(CommandCard, {
			command: makeCommand(),
			onedit: vi.fn(),
			ondelete: vi.fn(),
		});
		expect(getByTestId("command-card-edit")).toBeInTheDocument();
		expect(getByTestId("command-card-delete")).toBeInTheDocument();
	});
});
