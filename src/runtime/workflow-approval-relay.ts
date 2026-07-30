/**
 * Verbatim ask-user relay — ported invariant 2.
 *
 * A parked `approval` is a question for a HUMAN. When it reaches an LLM
 * — because a workflow is being driven from a chat, or an agent is
 * summarising a run — the model must relay it, not answer it, not
 * paraphrase it, and not decide on the human's behalf which items are
 * worth mentioning.
 *
 * The mechanism is structural rather than advisory: the finding cannot be
 * formatted WITHOUT the directive, because {@link formatGateRelay} is the
 * only thing that renders one and it always prepends
 * {@link RELAY_DIRECTIVE} for a blocking approval. There is no "render the
 * items" helper to reach for instead. That is the same shape ported
 * invariant 7 uses for the answer path: make the safe thing the only
 * exported thing.
 *
 * ## `directive` is non-null iff `stop` is true
 *
 * The two travel together by construction. A relay that carried the
 * items but not the directive would be an LLM-readable list of pending
 * decisions with nothing telling it to stop — which is precisely the
 * "pre-judge the user's decision" failure this exists to prevent. A
 * directive without a stop would be noise that trains readers to ignore
 * it.
 *
 * ## Verbatim means verbatim
 *
 * Item text is copied, never truncated, re-cased, re-ordered or
 * de-duplicated here. An approval that asks about `a.ts` and `A.ts` is
 * asking about two things; a relay that tidied that up would be answering
 * a question nobody asked. The only transformation is fencing, so a
 * prompt containing markdown cannot restructure the surrounding message.
 */

/**
 * The machine-enforced instruction that precedes every blocking relay.
 *
 * Deliberately imperative and deliberately three separate prohibitions:
 * "relay verbatim" alone was read as "summarise faithfully", and
 * "do not answer" alone left paraphrasing open.
 */
export const RELAY_DIRECTIVE =
  "RELAY THIS TO THE USER VERBATIM. Do not paraphrase it, do not pre-judge " +
  "which options matter, and do not answer on the user's behalf. STOP after " +
  "relaying and wait for their decision.";

/** The approval fields a relay renders. */
export interface RelayApproval {
  workflowName: string;
  stepName: string;
  prompt: string;
  choices: string[];
  requireItemConsent: boolean;
  itemIds: string[];
}

export interface GateRelay {
  /** True when the run is parked and a human must decide. */
  stop: boolean;
  /** {@link RELAY_DIRECTIVE} when `stop`, else null. Never one without
   *  the other — see the module doc. */
  directive: string | null;
  /** The message to relay, directive included when blocking. */
  text: string;
  /** The items consent was requested for, verbatim and in order. */
  items: string[];
}

/**
 * Fence a value so untrusted prompt text cannot restructure the message
 * around it.
 *
 * A prompt is author-controlled but an item id can carry file paths and
 * user data; either could contain a fence or a heading. Backtick-fencing
 * with a run longer than anything inside keeps the payload inert without
 * altering a single character of it.
 */
function fence(value: string): string {
  let longest = 0;
  for (const run of value.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}\n${value}\n${ticks}`;
}

/**
 * Render a parked approval for relay to a human through an LLM.
 *
 * `stop` is always true for a pending approval: the run IS parked, and a
 * caller that wanted a non-blocking summary is asking for something this
 * function deliberately does not produce.
 */
export function formatGateRelay(approval: RelayApproval): GateRelay {
  const items = [...approval.itemIds];
  const lines = [
    RELAY_DIRECTIVE,
    "",
    `Workflow **${approval.workflowName}** is waiting at step **${approval.stepName}**.`,
    "",
    fence(approval.prompt),
    "",
    `Options: ${approval.choices.join(", ")}`,
  ];
  if (approval.requireItemConsent) {
    lines.push(
      "",
      // Named as a requirement, not a suggestion: an LLM that reported
      // "approve or reject" without this would be describing a decision
      // the user cannot actually make in one click.
      `This approval requires per-item consent — the user must choose which of ` +
        `these ${items.length} item(s) they are consenting to:`,
    );
    for (const item of items) lines.push(fence(item));
  }
  return {
    stop: true,
    directive: RELAY_DIRECTIVE,
    text: lines.join("\n"),
    items,
  };
}
