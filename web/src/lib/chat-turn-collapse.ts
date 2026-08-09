/**
 * Pure logic for collapsing a chat TURN — a user prompt plus every message
 * that answers it, up to the next prompt.
 *
 * Walking back through a conversation with ArrowLeft collapses the turn you
 * step away from, so a long agentic run folds down to the prompts you actually
 * typed; ArrowRight pops the most recently collapsed turn back open. A
 * collapsed turn keeps its prompt bubble on screen and replaces the answer
 * with one muted summary row, the same idiom `ThinkingCard` and `ToolCallCard`
 * use.
 *
 * `ChatThread.svelte` owns the DOM; every decision lives here so it is
 * testable without mounting the component.
 */

/** The one message shape this module needs. */
export interface TurnMessage {
  id: string;
  role: string;
}

/** A turn: the prompt that opened it, plus the replies that belong to it. */
export interface Turn {
  /** `data-message-id` of the user prompt. Doubles as the turn's id. */
  promptId: string;
  /** Ids of the messages answering it (never includes the prompt). */
  replyIds: string[];
}

/**
 * Group a rendered message path into turns.
 *
 * Messages BEFORE the first user prompt (a thread an agent opened, a system
 * notice) belong to no turn: they are never hidden, because there is no prompt
 * left on screen to expand them from.
 */
export function groupTurns(messages: readonly TurnMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      turns.push({ promptId: m.id, replyIds: [] });
      continue;
    }
    turns[turns.length - 1]?.replyIds.push(m.id);
  }
  return turns;
}

/** Lookup built once per render pass and shared by every row. */
export interface TurnIndex {
  turns: Turn[];
  /** Reply id → the promptId of the turn it belongs to. */
  turnOfReply: Map<string, string>;
  /** promptId → its position in `turns`. */
  indexOfTurn: Map<string, number>;
}

export function buildTurnIndex(messages: readonly TurnMessage[]): TurnIndex {
  const turns = groupTurns(messages);
  const turnOfReply = new Map<string, string>();
  const indexOfTurn = new Map<string, number>();
  turns.forEach((turn, i) => {
    indexOfTurn.set(turn.promptId, i);
    for (const id of turn.replyIds) turnOfReply.set(id, turn.promptId);
  });
  return { turns, turnOfReply, indexOfTurn };
}

/**
 * Should this row be hidden right now?
 *
 * True only for a REPLY inside a collapsed turn — the prompt itself always
 * stays on screen, which is the whole point of the collapsed state.
 */
export function isRowHidden(
  messageId: string,
  index: TurnIndex,
  collapsed: ReadonlySet<string>,
): boolean {
  const turnId = index.turnOfReply.get(messageId);
  return turnId !== undefined && collapsed.has(turnId);
}

/** What the summary row reports for a collapsed turn. */
export interface TurnSummary {
  replies: number;
  tools: number;
}

/**
 * Count what a collapsed turn is hiding. `toolsFor` is injected (the tool
 * calls live in a store keyed by message id) so this stays pure.
 */
export function summarizeTurn(turn: Turn, toolsFor: (messageId: string) => number): TurnSummary {
  let tools = 0;
  for (const id of turn.replyIds) tools += toolsFor(id);
  return { replies: turn.replyIds.length, tools };
}

/**
 * Collapse state.
 *
 * `collapsed` is every turn folded right now, however it got that way.
 * `stack` is only the turns ArrowLeft folded, oldest first — ArrowRight pops
 * it. A turn the user collapsed by hand is deliberately NOT on the stack, so
 * the arrows never undo a decision the user made with the mouse.
 */
export interface TurnCollapseState {
  collapsed: ReadonlySet<string>;
  stack: readonly string[];
}

export const EMPTY_COLLAPSE_STATE: TurnCollapseState = {
  collapsed: new Set(),
  stack: [],
};

function withCollapsed(
  state: TurnCollapseState,
  mutate: (draft: Set<string>) => void,
  stack: readonly string[],
): TurnCollapseState {
  const draft = new Set(state.collapsed);
  mutate(draft);
  return { collapsed: draft, stack };
}

/**
 * ArrowLeft: fold the turn being left behind and remember it.
 *
 * A no-op when the turn is already folded (so a second press cannot stack the
 * same turn twice) or when it is `streamingTurnId` — folding the answer that
 * is still being written would hide the very thing the user is waiting for.
 */
export function pushCollapse(
  state: TurnCollapseState,
  turnId: string | null,
  opts: { streamingTurnId?: string | null } = {},
): TurnCollapseState {
  if (turnId === null) return state;
  if (turnId === (opts.streamingTurnId ?? null)) return state;
  if (state.collapsed.has(turnId)) return state;
  return withCollapsed(state, (d) => d.add(turnId), [...state.stack, turnId]);
}

/**
 * ArrowRight: pop the most recently arrow-collapsed turn and unfold it.
 *
 * Returns the turn id so the caller can navigate to it, or `null` when the
 * stack is empty — the arrows then fall back to plain prompt-to-prompt
 * stepping. Entries the user has already unfolded by hand are discarded as
 * they surface, so one press never appears to do nothing.
 */
export function popExpand(state: TurnCollapseState): {
  state: TurnCollapseState;
  turnId: string | null;
} {
  const stack = [...state.stack];
  while (stack.length > 0) {
    const turnId = stack.pop()!;
    if (!state.collapsed.has(turnId)) continue; // already opened by hand
    return {
      state: withCollapsed(state, (d) => d.delete(turnId), stack),
      turnId,
    };
  }
  return { state: { collapsed: state.collapsed, stack }, turnId: null };
}

/**
 * The summary row's click: unfold one turn. It also drops the turn from the
 * stack, so a later ArrowRight moves on to the next one instead of spending a
 * press on a turn that is already open.
 */
export function expandTurn(state: TurnCollapseState, turnId: string): TurnCollapseState {
  if (!state.collapsed.has(turnId)) return state;
  return withCollapsed(
    state,
    (d) => d.delete(turnId),
    state.stack.filter((id) => id !== turnId),
  );
}

/**
 * Which turn is streaming right now — the LAST one, and only while a run is
 * live. That is the turn {@link pushCollapse} refuses to fold.
 */
export function streamingTurnId(index: TurnIndex, isStreaming: boolean): string | null {
  if (!isStreaming) return null;
  return index.turns[index.turns.length - 1]?.promptId ?? null;
}

/**
 * The turn ArrowLeft just stepped away from: the one directly below the prompt
 * it landed on. `prev` moves exactly one prompt up, so the turn being left is
 * always the next one down — no need to re-derive it from scroll geometry.
 */
export function turnLeftBehind(promptIds: readonly string[], landedOn: string): string | null {
  const i = promptIds.indexOf(landedOn);
  if (i < 0) return null;
  return promptIds[i + 1] ?? null;
}
