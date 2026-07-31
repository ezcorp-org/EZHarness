/**
 * PendingApprovalCard — the third answer surface, in the DOM.
 *
 * What only a DOM test can show is that the consent rules are the ones the
 * user actually meets: the button really is dead until something is
 * ticked, the request really carries ONLY what was ticked, and a list too
 * long to read really does refuse the decision rather than truncating it.
 */
import { render, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import PendingApprovalCard from "./PendingApprovalCard.svelte";
import type { PendingApprovalNotice } from "$lib/workflow-approvals-logic";

afterEach(() => cleanup());
afterEach(() => vi.unstubAllGlobals());

let fetchSpy: ReturnType<typeof vi.fn>;
let lastBody: unknown;
let lastUrl: string | undefined;

function stubFetch(status = 200, body: unknown = { run: { status: "success" } }) {
  lastBody = undefined;
  lastUrl = undefined;
  fetchSpy = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    lastUrl = String(url);
    lastBody = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchSpy);
}

beforeEach(() => stubFetch());

function notice(overrides: Partial<PendingApprovalNotice> = {}): PendingApprovalNotice {
  return {
    approvalId: "ap-1",
    workflowRunId: "run-1",
    workflowName: "ship-it",
    stepName: "confirm",
    prompt: "Publish the release notes?",
    choices: ["approve", "reject"],
    requireItemConsent: false,
    itemIds: [],
    expiresAt: null,
    ...overrides,
  };
}

describe("a clean gate", () => {
  test("renders the prompt, its source, and one button per declared choice", () => {
    const { getByTestId, getAllByTestId } = render(PendingApprovalCard, {
      props: { approval: notice(), onResolved: () => {} },
    });

    expect(getByTestId("pending-approval-prompt").textContent).toContain(
      "Publish the release notes?",
    );
    expect(getByTestId("pending-approval-source").textContent).toContain("ship-it");
    expect(getByTestId("pending-approval-source").textContent).toContain("confirm");
    const choices = getAllByTestId("pending-approval-choice");
    expect(choices.map((c) => c.textContent?.trim())).toEqual(["approve", "reject"]);
  });

  test("answering POSTs to the one answer route and reports resolved", async () => {
    let resolved = 0;
    const { getAllByTestId } = render(PendingApprovalCard, {
      props: { approval: notice(), onResolved: () => resolved++ },
    });

    await fireEvent.click(getAllByTestId("pending-approval-choice")[1]!);
    await waitFor(() => expect(resolved).toBe(1));

    // `/api/workflows/approvals/:id` is `answerApproval` — the same
    // chokepoint the inbox and the Hub action clear.
    expect(lastUrl).toBe("/api/workflows/approvals/ap-1");
    expect(lastBody).toEqual({ choice: "reject" });
  });

  test("a refusal keeps the card and shows the server's own sentence", async () => {
    stubFetch(409, { error: "Your answer was recorded, but run run-1 could not continue: drift" });
    let resolved = 0;
    const { getAllByTestId, getByTestId } = render(PendingApprovalCard, {
      props: { approval: notice(), onResolved: () => resolved++ },
    });

    await fireEvent.click(getAllByTestId("pending-approval-choice")[0]!);

    // Dismissing here would take the only report of what happened with
    // it — and "recorded but could not continue" is not "try again".
    await waitFor(() =>
      expect(getByTestId("pending-approval-error").textContent).toContain("was recorded"),
    );
    expect(resolved).toBe(0);
  });

  test("renders a deadline when the step declared a timeout, and none when it did not", () => {
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();
    const { getByTestId } = render(PendingApprovalCard, {
      props: { approval: notice({ expiresAt: soon }), onResolved: () => {} },
    });
    expect(getByTestId("pending-approval-deadline").textContent).toContain("Expires in");

    cleanup();
    const { queryByTestId } = render(PendingApprovalCard, {
      props: { approval: notice(), onResolved: () => {} },
    });
    expect(queryByTestId("pending-approval-deadline")).toBeNull();
  });
});

describe("per-item consent", () => {
  const consent = notice({
    approvalId: "ap-2",
    requireItemConsent: true,
    itemIds: ["a.ts", "b.ts"],
  });

  test("the button is dead until something is ticked — the reason is visible BEFORE the click", () => {
    const { getAllByTestId, getByTestId } = render(PendingApprovalCard, {
      props: { approval: consent, onResolved: () => {} },
    });
    expect(getByTestId("pending-approval-consent-note")).toBeTruthy();
    expect((getAllByTestId("pending-approval-choice")[0] as HTMLButtonElement).disabled).toBe(true);
  });

  test("sends EXACTLY what was ticked — never the offered list", async () => {
    const { getAllByTestId } = render(PendingApprovalCard, {
      props: { approval: consent, onResolved: () => {} },
    });

    await fireEvent.click(getAllByTestId("pending-approval-item")[0]!);
    const button = getAllByTestId("pending-approval-choice")[0] as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await fireEvent.click(button);

    // Echoing both back would turn "consent to this one" into "consent to
    // everything you were asked about".
    await waitFor(() => expect(lastBody).toEqual({ choice: "approve", itemIds: ["a.ts"] }));
  });

  test("a list too long to read refuses the decision instead of truncating it", () => {
    const many = Array.from({ length: 40 }, (_, i) => `file-${i}.ts`);
    const { getByTestId, queryAllByTestId } = render(PendingApprovalCard, {
      props: { approval: notice({ requireItemConsent: true, itemIds: many }), onResolved: () => {} },
    });

    // No choices at all — a partially-shown list cannot produce an
    // informed answer, and the surface says so rather than taking one.
    expect(queryAllByTestId("pending-approval-choice")).toHaveLength(0);
    expect(queryAllByTestId("pending-approval-item")).toHaveLength(0);
    expect(getByTestId("pending-approval-too-many").textContent).toContain("40 items");
    expect(getByTestId("pending-approval-inbox-link").getAttribute("href")).toBe(
      "/workflows/approvals",
    );
  });
});
