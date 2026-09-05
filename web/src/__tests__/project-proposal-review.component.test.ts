import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, expect, test, vi } from "vitest";
import type { ComponentProps } from "svelte";
const mocks = vi.hoisted(() => ({ submit: null as null | (() => (input: { update: () => Promise<void> }) => Promise<void>) }));
vi.mock("$app/forms", () => ({ enhance: (_node: unknown, submit: typeof mocks.submit) => { mocks.submit = submit; } }));
import Page from "../routes/(app)/extensions/project-proposals/[id]/+page.svelte";
function props(state = "proposed", merge = true) { return { data: { state, proposal: { id: "proposal", number: 42, repository: "owner/repository", merge, snapshot: { head: "a".repeat(40), base: "b".repeat(40), files: ["docs/file.md"], digest: "digest" } } }, form: null } as ComponentProps<typeof Page>; }
afterEach(() => { cleanup(); mocks.submit = null; });
test("host review shows exact target hashes files and cannot submit unchecked", async () => {
  const view = render(Page, props());
  expect(view.getByText("a".repeat(40))).toBeInTheDocument();
  expect(view.getByText("b".repeat(40))).toBeInTheDocument();
  expect(view.getByText("docs/file.md")).toBeInTheDocument();
  expect(view.getByRole("link")).toHaveAttribute("href", "https://github.com/owner/repository/pull/42");
  const approve = view.getByRole("button", { name: "Approve and merge" });
  expect(approve).toBeDisabled();
  await fireEvent.click(view.getByRole("checkbox"));
  expect(approve).toBeEnabled();
  const complete = mocks.submit!();
  await waitFor(() => expect(approve).toBeDisabled());
  const update = vi.fn(async () => {});
  await complete({ update });
  expect(update).toHaveBeenCalled();
  await waitFor(() => expect(view.getByRole("checkbox")).not.toBeChecked());
});
test("ready-only review and final failure states describe their exact effects", async () => {
  const view = render(Page, props("proposed", false));
  expect(view.getByRole("button", { name: "Approve and mark ready" })).toBeDisabled();
  await view.rerender({ ...props("failed"), form: { message: "Verify on GitHub" } });
  expect(view.getByRole("status")).toHaveTextContent("Verify on GitHub");
  expect(view.getByText(/operation may have partial effects/)).toBeInTheDocument();
  expect(view.queryByRole("button")).not.toBeInTheDocument();
  await view.rerender(props("completed"));
  expect(view.getByText(/This decision is final/)).toBeInTheDocument();
});
