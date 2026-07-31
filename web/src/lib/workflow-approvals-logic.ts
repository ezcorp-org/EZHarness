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

/**
 * How a parked decision's deadline should read.
 *
 * `expiresAt` was being FETCHED and never rendered, which is the worst of
 * both: the timeout sweep will answer this approval on the clock's behalf,
 * and the human deciding it could not see that it had a clock at all. A
 * decision that silently times out is indistinguishable, afterwards, from
 * one nobody looked at.
 *
 * `now` is injected so this is testable without freezing time.
 */
export function describeDeadline(
	expiresAt: string | null,
	now: Date,
): { text: string; urgent: boolean } | null {
	if (!expiresAt) return null;
	const ms = new Date(expiresAt).getTime() - now.getTime();
	// Already past: say so plainly rather than rendering "in -3 hours".
	//
	// Deliberately NEUTRAL about what happens next. The step's `onTimeout`
	// decides that — `abort` cancels the run, `approve` and `skip` carry it
	// on — and the policy is a field of the workflow DEFINITION, not of the
	// row this inbox reads. An earlier version of this string promised the
	// run "may already have been failed", which is true for exactly one of
	// the three policies and was a lie for the other two.
	if (ms <= 0) return { text: "Past deadline — the timeout policy decides this", urgent: true };
	const mins = Math.floor(ms / 60_000);
	if (mins < 60) return { text: `Expires in ${mins} min`, urgent: true };
	const hours = Math.floor(mins / 60);
	// Under a day is the window where a human still has to act today.
	if (hours < 24) return { text: `Expires in ${hours}h`, urgent: hours < 4 };
	return { text: `Expires in ${Math.floor(hours / 24)}d`, urgent: false };
}

/** Relative age of a parked decision — how long it has been blocking. */
export function describeAge(createdAt: string, now: Date): string {
	const mins = Math.max(0, Math.floor((now.getTime() - new Date(createdAt).getTime()) / 60_000));
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins} min ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}
