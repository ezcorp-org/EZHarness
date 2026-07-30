/**
 * Pure logic for the approvals inbox.
 *
 * Split out of the page so the decision rules are testable without
 * mounting Svelte. The page keeps only fetch + render; everything that
 * could be *wrong* rather than merely ugly lives here.
 */

/** One pending decision, as the inbox route projects it. */
export interface PendingApproval {
	id: string;
	workflowRunId: string;
	workflowName: string;
	stepName: string;
	prompt: string;
	choices: string[];
	requireItemConsent: boolean;
	itemIds: string[];
	formSchema: Record<string, unknown> | null;
	expiresAt: string | null;
	createdAt: string;
}

/** The body `POST /api/workflows/approvals/:id` expects. */
export interface AnswerBody {
	choice: string;
	itemIds?: string[];
}

/**
 * Build the answer payload for a choice.
 *
 * `itemIds` is sent ONLY when the approval demands per-item consent, and
 * then it is the items the human actually ticked — never the full list
 * the server offered. Echoing the offered list back would turn "consent
 * to these three" into "consent to whatever you asked about", which is
 * the shape `requireItemConsent` exists to prevent.
 *
 * Sending no `itemIds` at all for a consent-required approval is
 * deliberate and safe: the server-side guard refuses it. The UI must not
 * paper over that by inventing a selection.
 */
export function buildAnswerBody(
	approval: Pick<PendingApproval, "requireItemConsent">,
	choice: string,
	selectedItemIds: string[],
): AnswerBody {
	if (!approval.requireItemConsent) return { choice };
	return { choice, itemIds: selectedItemIds };
}

/**
 * Can this choice be submitted yet?
 *
 * An approval requiring item consent with nothing ticked is not
 * answerable — the button is disabled rather than the request being sent
 * and refused, so the reason is visible before the click rather than
 * after it.
 */
export function canSubmit(
	approval: Pick<PendingApproval, "requireItemConsent">,
	selectedItemIds: string[],
	inFlight: boolean,
): boolean {
	if (inFlight) return false;
	if (!approval.requireItemConsent) return true;
	return selectedItemIds.length > 0;
}

/**
 * Toggle one item in a selection, returning a NEW array.
 *
 * Returns a new array rather than mutating so Svelte's reactivity sees
 * the change — an in-place `push` on a `$state` array member is the
 * classic way a checkbox appears to do nothing.
 */
export function toggleItem(selected: string[], itemId: string): string[] {
	return selected.includes(itemId)
		? selected.filter((id) => id !== itemId)
		: [...selected, itemId];
}

/**
 * How an answered approval should read once the server has replied.
 *
 * The run's own status is what matters, not merely that the POST returned
 * 200: an answer can be recorded while the run then fails to continue,
 * and the inbox must not claim otherwise. `suspended` after an answer
 * means the run parked AGAIN — on the next approval — which is progress,
 * not failure.
 */
export function describeOutcome(runStatus: string | undefined): {
	tone: "ok" | "warn" | "error";
	text: string;
} {
	if (runStatus === undefined) return { tone: "warn", text: "Answer recorded; run state unknown" };
	if (runStatus === "success") return { tone: "ok", text: "Answered — the run completed" };
	if (runStatus === "suspended") {
		return { tone: "ok", text: "Answered — the run is waiting on the next approval" };
	}
	if (runStatus === "running") return { tone: "ok", text: "Answered — the run is continuing" };
	return { tone: "error", text: `Answered, but the run is ${runStatus}` };
}
