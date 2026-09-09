import { afterEach, beforeEach, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import Page from "./+page.svelte";

afterEach(cleanup);
beforeEach(() => {
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
const data = { name: "browser", binding: "a".repeat(64), nonce: crypto.randomUUID(), conversationId: null, tools: ["allowed"], conversations: [{ id: "owned", title: "Owned conversation", projectId: "project" }], projects: [{ id: "project", name: "Project" }] };

test("requires explicit host conversation selection before creating the frame", () => {
  const rendered = render(Page, { data: data as any });
  expect(rendered.getByRole("heading", { name: "browser" })).toBeTruthy();
  expect(rendered.getByLabelText("Conversation").querySelector('option[value="owned"]')?.textContent).toBe("Owned conversation");
  expect(rendered.getByRole("button", { name: "Create preview conversation" }).closest("form")?.getAttribute("method")).toBe("POST");
  expect(rendered.container.querySelector("iframe")).toBeNull();
});

test("renders the selected immutable frame without child-selected authority", () => {
  const rendered = render(Page, { data: { ...data, conversationId: "owned" } as any });
  const frame = rendered.getByTitle("browser preview");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("src")).toContain("conversationId=owned");
  expect(rendered.queryByRole("button", { name: "Create preview conversation" })).toBeNull();
});
