/**
 * The consent rules every answer to an `approval` step must clear.
 *
 * Pure — no DB, no clock, no I/O — so the single chokepoint that calls it
 * (`answerApproval`) can be driven from three surfaces (REST, Hub action,
 * chat card) without any of them re-deriving the rules. That
 * single-chokepoint property is the point: the reference extension this
 * ports from originally had two answer paths, and the second could
 * sidestep consent entirely.
 *
 * Ported from `docs/extensions/examples/ez-code-factory/lib/chat-contract.ts`
 * — `enforceNamedApproval`, `crossCheckFindingIds`, and the
 * `enforceRespondContract` composition that runs them IN ORDER.
 *
 * ## `item_ids` means "items requiring consent"
 *
 * Not "everything the step produced". That definition collapses the
 * port's two states into one: a gate with nothing to consent to has an
 * EMPTY set, which is the same test as the port's `askUserCount === 0`
 * clean gate, rather than a special case bolted alongside it.
 *
 * ## Deliberately choice-agnostic
 *
 * The port keys the naming requirement on the ACTION (`approve`/`fix`
 * need ids; `skip`/`abort` do not). A workflow's `choices` are
 * author-defined strings, so the executor cannot know which of them
 * means "approve" — and guessing would be a consent bypass the first
 * time someone wrote `choices: [ship, hold]`.
 *
 * So the requirement keys on the PARKED STEP instead: if it carries
 * items requiring consent, every answer names what it acted on,
 * whichever choice it picked. That is stricter than the port, and
 * strictness is the correct direction for a consent rule. Naming the
 * items is meaningful for a rejection too.
 */

/** Outcome of the guard. `ok: false` carries a message written for the
 *  human who will read it, not a code. */
export interface ApprovalGuardResult {
  ok: boolean;
  error?: string;
  /**
   * True when the answer passed ONLY because standing consent was given
   * for an ids-free bulk clear. The caller records it on the row so a
   * blanket clear is permitted but never silent.
   */
  consentAllUsed?: boolean;
}

/** What the guard needs to know about the parked step. */
export interface ParkedApproval {
  /** The choices the definition declared. An answer outside this set is
   *  rejected, never coerced. */
  choices: string[];
  /** Whether this step requires the answer to name the items it acts on. */
  requireItemConsent: boolean;
  /** The items REQUIRING CONSENT, resolved at suspend time from what the
   *  run actually produced — not from what the definition hoped for. */
  itemIds: string[];
}

/** What the human (or a surface acting for them) sent back. */
export interface ApprovalAnswer {
  choice: string;
  itemIds?: string[];
  /** Explicit standing consent to clear every item without naming them.
   *  Allowed, and always flagged. */
  consentAll?: boolean;
}

/**
 * Reject a choice the definition never declared.
 *
 * Separate from the consent rules because it applies even to a step with
 * nothing to consent to: an undeclared choice would flow into
 * `$steps.<gate>.output.choice` and be read by downstream refs as though
 * the author had allowed it.
 */
function checkChoice(parked: ParkedApproval, answer: ApprovalAnswer): ApprovalGuardResult {
  if (parked.choices.includes(answer.choice)) return { ok: true };
  return {
    ok: false,
    error:
      `"${answer.choice}" is not one of this step's declared choices ` +
      `(${parked.choices.join(", ")}). An answer outside the declared set is ` +
      `rejected rather than coerced.`,
  };
}

/**
 * Ported invariant 5 — no blanket approval.
 *
 * An ids-free answer to a step carrying items requiring consent is
 * refused. A CLEAN step (empty `itemIds`) answers ids-free, because
 * nothing was withheld from the human. Explicit `consentAll` bypasses and
 * is FLAGGED, so a bulk clear is auditable rather than invisible.
 */
export function enforceNamedApproval(
  parked: ParkedApproval,
  answer: ApprovalAnswer,
): ApprovalGuardResult {
  if (!parked.requireItemConsent) return { ok: true };
  // Naming the ids is the proof-of-surface — always allowed.
  if (answer.itemIds && answer.itemIds.length > 0) return { ok: true };
  // Ids-free from here. A clean step has nothing to withhold.
  if (parked.itemIds.length === 0) return { ok: true };
  if (answer.consentAll === true) return { ok: true, consentAllUsed: true };
  return {
    ok: false,
    error:
      `This approval must name the itemIds it is acting on: ${parked.itemIds.length} ` +
      `item(s) are awaiting a decision. Relay them to the user, then pass the ids ` +
      `they decided on — or set consentAll only with their explicit standing ` +
      `consent to clear every item.`,
  };
}

/**
 * Ported invariant 6 — every named id must exist.
 *
 * Strengthens the proof-of-surface check above: without this, any
 * non-empty array satisfies "named some ids", so invented ids could be
 * smuggled through to clear a gate nobody reviewed. An ids-free answer is
 * governed by {@link enforceNamedApproval}, not here.
 */
export function crossCheckItemIds(
  parked: ParkedApproval,
  answer: ApprovalAnswer,
): ApprovalGuardResult {
  if (!answer.itemIds || answer.itemIds.length === 0) return { ok: true };
  const known = new Set(parked.itemIds);
  const unknown = answer.itemIds.filter((id) => !known.has(id));
  if (unknown.length === 0) return { ok: true };
  return {
    ok: false,
    error:
      `Unknown itemId(s): ${unknown.join(", ")}. An approval may only name items ` +
      `this run actually produced.`,
  };
}

/**
 * The whole contract, in order. **This is the only function an answer
 * path may call** — the three surfaces share it so a fourth cannot
 * quietly acquire different rules.
 *
 * Order matters and is ported as-is: the declared-choice check first
 * (it applies to every step), then no-blanket-approval, then
 * cross-check. Returning the FIRST failure keeps the message about the
 * thing the human has to fix.
 *
 * Pure: the caller performs the mutation only when `ok` is true.
 */
export function requireItemConsent(
  parked: ParkedApproval,
  answer: ApprovalAnswer,
): ApprovalGuardResult {
  const choice = checkChoice(parked, answer);
  if (!choice.ok) return choice;

  const named = enforceNamedApproval(parked, answer);
  if (!named.ok) return named;

  const crossChecked = crossCheckItemIds(parked, answer);
  if (!crossChecked.ok) return crossChecked;

  // Carry the audit marker forward from whichever guard set it.
  return named.consentAllUsed ? { ok: true, consentAllUsed: true } : { ok: true };
}
