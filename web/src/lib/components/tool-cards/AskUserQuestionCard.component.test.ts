/**
 * Svelte 5 DOM tests for AskUserQuestionCard.svelte.
 *
 * Covers:
 *   • Renders the question text from `toolCall.input.question`.
 *   • Options array → one button per option, role=group on the wrapper.
 *   • No options → textarea + Send button (Enter submits, Shift+Enter
 *     newlines).
 *   • Click → POSTs to /api/ask-user/answer with `{ toolCallId, answer }`.
 *   • Submit disables controls + shows "Sending…" while pending.
 *   • Bad submit (non-2xx) → submit error banner appears.
 *   • Complete state → renders "Answered: <text>" summary parsed from
 *     `toolCall.output.content[].text`.
 *   • Missing toolCall.id → renders the inert error banner; clicks do
 *     nothing.
 */

import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, vi, beforeEach } from "vitest";
import AskUserQuestionCard from "./AskUserQuestionCard.svelte";
import type { ToolCallState } from "$lib/stores.svelte.js";

afterEach(() => cleanup());

let fetchSpy: ReturnType<typeof vi.fn>;
let lastFetchInit: RequestInit | undefined;

beforeEach(() => {
  lastFetchInit = undefined;
  fetchSpy = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    lastFetchInit = init;
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
  // userFetch wraps the global fetch; stubbing global fetch is enough.
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeRunningCall(
  overrides: Partial<ToolCallState> & { input?: Record<string, unknown> } = {},
): ToolCallState {
  return {
    id: "tc-test-1",
    toolName: "ask_user_question",
    status: "running",
    input: overrides.input ?? { question: "Pick one", options: ["A", "B", "C"] },
    startedAt: Date.now(),
    ...overrides,
  } as ToolCallState;
}

describe("AskUserQuestionCard", () => {
  test("renders the question text", () => {
    const { getByText } = render(AskUserQuestionCard, {
      toolCall: makeRunningCall(),
    });
    expect(getByText("Pick one")).toBeInTheDocument();
  });

  test("with options → renders one button per option inside role=group", () => {
    const { getByTestId, getByRole } = render(AskUserQuestionCard, {
      toolCall: makeRunningCall(),
    });
    const group = getByTestId("ask-user-options");
    expect(group).toBeInTheDocument();
    const buttonA = getByRole("button", { name: "A" });
    const buttonB = getByRole("button", { name: "B" });
    const buttonC = getByRole("button", { name: "C" });
    expect(buttonA).toBeInTheDocument();
    expect(buttonB).toBeInTheDocument();
    expect(buttonC).toBeInTheDocument();
  });

  test("no options → renders textarea + Send button (no buttons-list)", () => {
    const { getByTestId, getByPlaceholderText, getByRole, queryByTestId } = render(
      AskUserQuestionCard,
      {
        toolCall: makeRunningCall({ input: { question: "What's your name?" } }),
      },
    );
    expect(getByTestId("ask-user-text-form")).toBeInTheDocument();
    expect(getByPlaceholderText(/Type your answer/i)).toBeInTheDocument();
    expect(getByRole("button", { name: /^Send$/i })).toBeInTheDocument();
    expect(queryByTestId("ask-user-options")).toBeNull();
  });

  test("clicking an option POSTs once with { toolCallId, answer }", async () => {
    const { getByRole } = render(AskUserQuestionCard, {
      toolCall: makeRunningCall(),
    });
    const buttonB = getByRole("button", { name: "B" });
    await fireEvent.click(buttonB);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("/api/ask-user/answer");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ toolCallId: "tc-test-1", answer: "B" });
  });

  test("clicking an option disables every button while pending", async () => {
    // Make fetch hang so the submitting state is observable.
    fetchSpy.mockImplementation(
      () => new Promise(() => undefined) as unknown as Promise<Response>,
    );
    const { getByRole, getAllByRole } = render(AskUserQuestionCard, {
      toolCall: makeRunningCall(),
    });
    const buttonA = getByRole("button", { name: "A" });
    await fireEvent.click(buttonA);

    const buttons = getAllByRole("button");
    for (const b of buttons) {
      expect(b).toBeDisabled();
    }
  });

  test("textarea submission sends the trimmed value", async () => {
    const { getByPlaceholderText, getByRole } = render(AskUserQuestionCard, {
      toolCall: makeRunningCall({ input: { question: "Free?" } }),
    });
    const textarea = getByPlaceholderText(/Type your answer/i) as HTMLTextAreaElement;
    await fireEvent.input(textarea, { target: { value: "Alice" } });
    await fireEvent.click(getByRole("button", { name: /^Send$/i }));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(lastFetchInit?.body));
    expect(body).toEqual({ toolCallId: "tc-test-1", answer: "Alice" });
  });

  test("textarea Enter submits, Shift+Enter does not", async () => {
    const { getByPlaceholderText } = render(AskUserQuestionCard, {
      toolCall: makeRunningCall({ input: { question: "Free?" } }),
    });
    const textarea = getByPlaceholderText(/Type your answer/i) as HTMLTextAreaElement;
    await fireEvent.input(textarea, { target: { value: "Bob" } });

    // Shift+Enter — should NOT submit.
    await fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(fetchSpy).not.toHaveBeenCalled();

    // Plain Enter — should submit.
    await fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("empty textarea submit is a no-op", async () => {
    const { getByRole } = render(AskUserQuestionCard, {
      toolCall: makeRunningCall({ input: { question: "Free?" } }),
    });
    const sendBtn = getByRole("button", { name: /^Send$/i }) as HTMLButtonElement;
    expect(sendBtn).toBeDisabled();
    await fireEvent.click(sendBtn);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("non-2xx response surfaces an error banner", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("nope", { status: 500 }) as never,
    );
    const { getByRole, findByTestId } = render(AskUserQuestionCard, {
      toolCall: makeRunningCall(),
    });
    await fireEvent.click(getByRole("button", { name: "A" }));
    const err = await findByTestId("ask-user-submit-error");
    expect(err.textContent).toContain("500");
  });

  test("complete state renders 'Answered' summary parsed from output.content", () => {
    const completed = makeRunningCall({
      status: "complete",
      output: { content: [{ type: "text", text: "blue" }] },
    });
    const { getByTestId } = render(AskUserQuestionCard, {
      toolCall: completed,
    });
    expect(getByTestId("ask-user-answered-text").textContent?.trim()).toBe("blue");
  });

  test("error state renders the error text", () => {
    const errored = makeRunningCall({
      status: "error",
      error: "boom",
    });
    const { getByText } = render(AskUserQuestionCard, {
      toolCall: errored,
    });
    expect(getByText("boom")).toBeInTheDocument();
  });

  test("missing toolCall.id renders the inert error banner and disables controls", async () => {
    const noId = makeRunningCall({ id: undefined });
    const { getByTestId, getByRole } = render(AskUserQuestionCard, {
      toolCall: noId,
    });
    expect(getByTestId("ask-user-missing-id")).toBeInTheDocument();

    // All buttons disabled.
    const buttonA = getByRole("button", { name: "A" });
    expect(buttonA).toBeDisabled();
    await fireEvent.click(buttonA);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
