/**
 * Unit tests for chat-turn-collapse — the decision layer behind folding a chat
 * turn as ArrowLeft walks back through a conversation.
 */
import { describe, test, expect } from "vitest";
import {
  groupTurns,
  buildTurnIndex,
  isRowHidden,
  summarizeTurn,
  pushCollapse,
  popExpand,
  expandTurn,
  streamingTurnId,
  turnLeftBehind,
  EMPTY_COLLAPSE_STATE,
  type TurnCollapseState,
  type TurnMessage,
} from "./chat-turn-collapse";

/** `u*` ids are prompts, everything else answers the prompt above it. */
const chain = (...ids: string[]): TurnMessage[] =>
  ids.map((id) => ({ id, role: id.startsWith("u") ? "user" : "assistant" }));

const state = (collapsed: string[], stack: string[] = []): TurnCollapseState => ({
  collapsed: new Set(collapsed),
  stack,
});

describe("groupTurns", () => {
  test("a prompt opens a turn and the messages after it are its replies", () => {
    expect(groupTurns(chain("u1", "a1", "a2", "u2", "a3"))).toEqual([
      { promptId: "u1", replyIds: ["a1", "a2"] },
      { promptId: "u2", replyIds: ["a3"] },
    ]);
  });

  test("a prompt with no answer yet is a turn with no replies", () => {
    expect(groupTurns(chain("u1"))).toEqual([{ promptId: "u1", replyIds: [] }]);
  });

  test("messages BEFORE the first prompt belong to no turn", () => {
    // A thread an agent opened. There is no prompt above them, so nothing
    // could ever unfold them — they must never be foldable.
    expect(groupTurns(chain("a0", "a1", "u1", "a2"))).toEqual([
      { promptId: "u1", replyIds: ["a2"] },
    ]);
  });

  test("an empty path has no turns", () => {
    expect(groupTurns([])).toEqual([]);
  });
});

describe("buildTurnIndex / isRowHidden", () => {
  const index = buildTurnIndex(chain("a0", "u1", "a1", "a2", "u2", "a3"));

  test("indexes each reply to its turn, and each turn to its position", () => {
    expect(index.turnOfReply.get("a1")).toBe("u1");
    expect(index.turnOfReply.get("a2")).toBe("u1");
    expect(index.turnOfReply.get("a3")).toBe("u2");
    expect(index.indexOfTurn.get("u1")).toBe(0);
    expect(index.indexOfTurn.get("u2")).toBe(1);
  });

  test("a folded turn hides its replies but NEVER its prompt", () => {
    const collapsed = new Set(["u1"]);
    expect(isRowHidden("a1", index, collapsed)).toBe(true);
    expect(isRowHidden("a2", index, collapsed)).toBe(true);
    // The prompt is the whole point of the folded state.
    expect(isRowHidden("u1", index, collapsed)).toBe(false);
    // A different turn is untouched.
    expect(isRowHidden("a3", index, collapsed)).toBe(false);
  });

  test("a pre-prompt message is never hidden, whatever is folded", () => {
    expect(isRowHidden("a0", index, new Set(["u1", "u2"]))).toBe(false);
  });

  test("nothing is hidden when nothing is folded", () => {
    expect(isRowHidden("a1", index, new Set())).toBe(false);
  });
});

describe("summarizeTurn", () => {
  const turn = { promptId: "u1", replyIds: ["a1", "a2", "a3"] };

  test("counts replies and sums the tool calls across them", () => {
    const tools: Record<string, number> = { a1: 2, a2: 0, a3: 1 };
    expect(summarizeTurn(turn, (id) => tools[id] ?? 0)).toEqual({
      replies: 3,
      tools: 3,
    });
  });

  test("a turn with no replies counts zero of both", () => {
    expect(summarizeTurn({ promptId: "u1", replyIds: [] }, () => 5)).toEqual({
      replies: 0,
      tools: 0,
    });
  });
});

describe("pushCollapse (ArrowLeft)", () => {
  test("folds the turn and remembers it on the stack", () => {
    const next = pushCollapse(EMPTY_COLLAPSE_STATE, "u2");
    expect([...next.collapsed]).toEqual(["u2"]);
    expect(next.stack).toEqual(["u2"]);
  });

  test("stacks in press order, most recent last", () => {
    let s = pushCollapse(EMPTY_COLLAPSE_STATE, "u5");
    s = pushCollapse(s, "u4");
    s = pushCollapse(s, "u3");
    expect(s.stack).toEqual(["u5", "u4", "u3"]);
  });

  test("no turn behind us (the first prompt) → unchanged, same object", () => {
    expect(pushCollapse(EMPTY_COLLAPSE_STATE, null)).toBe(EMPTY_COLLAPSE_STATE);
  });

  test("an already-folded turn is not stacked twice", () => {
    const s = state(["u2"], ["u2"]);
    expect(pushCollapse(s, "u2")).toBe(s);
  });

  test("the STREAMING turn is never folded", () => {
    // Folding the answer still being written would hide the thing the user
    // is sitting there waiting for.
    const s = pushCollapse(EMPTY_COLLAPSE_STATE, "u9", {
      streamingTurnId: "u9",
    });
    expect(s).toBe(EMPTY_COLLAPSE_STATE);
    // A different turn folds normally while that run streams.
    expect(pushCollapse(EMPTY_COLLAPSE_STATE, "u8", { streamingTurnId: "u9" }).stack).toEqual([
      "u8",
    ]);
  });
});

describe("popExpand (ArrowRight)", () => {
  test("unfolds the most recently folded turn and hands it back", () => {
    const s = state(["u5", "u4"], ["u5", "u4"]);
    const { state: next, turnId } = popExpand(s);
    expect(turnId).toBe("u4");
    expect([...next.collapsed]).toEqual(["u5"]);
    expect(next.stack).toEqual(["u5"]);
  });

  test("an empty stack yields null (the caller falls back to plain stepping)", () => {
    const { state: next, turnId } = popExpand(EMPTY_COLLAPSE_STATE);
    expect(turnId).toBeNull();
    expect(next.stack).toEqual([]);
  });

  test("skips entries the user already unfolded by hand", () => {
    // u4 was opened with the mouse, so popping it would spend a press doing
    // nothing visible. Walk past it to the next real entry.
    const s = state(["u5"], ["u5", "u4"]);
    const { state: next, turnId } = popExpand(s);
    expect(turnId).toBe("u5");
    expect(next.stack).toEqual([]);
  });

  test("a stack of only stale entries yields null and empties the stack", () => {
    const s = state([], ["u4", "u3"]);
    const { state: next, turnId } = popExpand(s);
    expect(turnId).toBeNull();
    expect(next.stack).toEqual([]);
    expect([...next.collapsed]).toEqual([]);
  });

  test("ArrowLeft then ArrowRight round-trips to the starting state", () => {
    const folded = pushCollapse(EMPTY_COLLAPSE_STATE, "u5");
    const { state: back } = popExpand(folded);
    expect([...back.collapsed]).toEqual([]);
    expect(back.stack).toEqual([]);
  });
});

describe("expandTurn (clicking the summary row)", () => {
  test("unfolds the turn and drops it from the stack", () => {
    // Dropping it matters: a later ArrowRight must move on to the next
    // folded turn rather than spending a press on this one.
    const s = state(["u5", "u4"], ["u5", "u4"]);
    const next = expandTurn(s, "u5");
    expect([...next.collapsed]).toEqual(["u4"]);
    expect(next.stack).toEqual(["u4"]);
  });

  test("expanding an already-open turn changes nothing", () => {
    const s = state(["u4"], ["u4"]);
    expect(expandTurn(s, "u9")).toBe(s);
  });
});

describe("streamingTurnId", () => {
  const index = buildTurnIndex(chain("u1", "a1", "u2", "a2"));

  test("the last turn is the live one while a run streams", () => {
    expect(streamingTurnId(index, true)).toBe("u2");
  });

  test("nothing is live when no run is streaming", () => {
    expect(streamingTurnId(index, false)).toBeNull();
  });

  test("a conversation with no turns has no live turn", () => {
    expect(streamingTurnId(buildTurnIndex([]), true)).toBeNull();
  });
});

describe("turnLeftBehind", () => {
  const prompts = ["u1", "u2", "u3"];

  test("the turn below the one we landed on", () => {
    // `prev` steps exactly one prompt up, so the turn being left is always
    // the next one down.
    expect(turnLeftBehind(prompts, "u2")).toBe("u3");
    expect(turnLeftBehind(prompts, "u1")).toBe("u2");
  });

  test("landing on the last prompt leaves nothing behind", () => {
    expect(turnLeftBehind(prompts, "u3")).toBeNull();
  });

  test("an unknown prompt leaves nothing behind", () => {
    expect(turnLeftBehind(prompts, "ghost")).toBeNull();
  });
});
