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

/**
 * A parked approval as the `workflow:approval_request` event delivers it.
 *
 * Deliberately NOT {@link PendingApproval}: that is the inbox's projection
 * of a row the client FETCHED, and it carries `createdAt` / `formSchema`
 * which the push notice has no business inventing. The fields the two
 * share are named identically so the shared logic below takes either.
 */
export interface PendingApprovalNotice {
	approvalId: string;
	workflowRunId: string;
	workflowName: string;
	stepName: string;
	prompt: string;
	choices: string[];
	requireItemConsent: boolean;
	itemIds: string[];
	expiresAt: string | null;
}

/** The body `POST /api/workflows/approvals/:id` expects. */
export interface AnswerBody {
	choice: string;
	itemIds?: string[];
}

/**
 * How many consent items the tray will let a user tick before it stops
 * pretending to be the right surface for the job.
 *
 * Not a styling number. See {@link trayConsentPlan}.
 */
export const TRAY_ITEM_LIMIT = 6;

/**
 * What the tray card may do about this approval's consent items.
 *
 *   - `none`   — nothing to consent to (either the step does not require
 *                it, or it resolved to an empty set, which the server
 *                guard reads as a clean gate answerable ids-free).
 *   - `tick`   — the list is short enough to READ in a corner overlay,
 *                so the user ticks what they are consenting to.
 *   - `inbox`  — too long. The card refuses to take the decision and
 *                sends the user to the inbox.
 *
 * That last branch is a consent rule, not a layout preference. A tray
 * that truncated the list would let someone tick 6 of 40 items and send
 * exactly those 6 — a complete, valid, server-accepted answer to a
 * question they were never shown the whole of. Refusing to answer at all
 * is the only honest option once the surface cannot display what is being
 * consented to.
 */
export function trayConsentPlan(
	approval: Pick<PendingApprovalNotice, "requireItemConsent" | "itemIds">,
): { mode: "none" | "tick" | "inbox"; items: string[] } {
	if (!approval.requireItemConsent || approval.itemIds.length === 0) {
		return { mode: "none", items: [] };
	}
	if (approval.itemIds.length > TRAY_ITEM_LIMIT) {
		return { mode: "inbox", items: approval.itemIds };
	}
	return { mode: "tick", items: approval.itemIds };
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

/** What {@link submitApprovalAnswer} learned. `ok: false` carries the
 *  server's own sentence — never a re-worded one, because the refusals that
 *  matter (`resume-failed`) say something the client cannot re-derive. */
export type SubmitResult =
	| { ok: true; runStatus: string | undefined }
	| { ok: false; message: string };

/**
 * POST one answer to the single answer route.
 *
 * Extracted because there are now two client surfaces sending it — the
 * inbox page and the pending-decisions tray — and a second hand-rolled
 * `fetch` is how the two would drift on the thing that matters most: a
 * non-OK response NEVER reads as "not answered". `resume-failed` means the
 * decision WAS recorded and only the resume failed, so a card that said
 * "failed, try again" would send the user to answer something the CAS will
 * refuse.
 *
 * `fetcher` is injected so this is testable without a network or a DOM.
 */
export async function submitApprovalAnswer(
	approvalId: string,
	body: AnswerBody,
	fetcher: typeof fetch = fetch,
): Promise<SubmitResult> {
	const res = await fetcher(`/api/workflows/approvals/${approvalId}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const parsed = (await res.json().catch(() => ({}))) as {
		run?: { status?: string };
		error?: string;
	};
	if (!res.ok) return { ok: false, message: parsed.error ?? `Failed (${res.status})` };
	return { ok: true, runStatus: parsed.run?.status };
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
	if (ms <= 0) return { text: "Expired — this run may already have been failed", urgent: true };
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
