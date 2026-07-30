/**
 * Display + edit helpers for the Settings → Models "Routing Experiments"
 * editor — bounded exploration (`provider:explorationRate`) and shadow mode
 * (`provider:routingShadow`).
 *
 * Both settings are already validated where it counts: the admin
 * `PUT /api/settings/<key>` route runs the backend's own
 * `validateExplorationRate` / `validateShadowThresholds` before anything lands
 * in the row. This module imports those SAME validators rather than restating
 * their rules, so the form can pre-flight an edit and show the exact sentence
 * the server would have replied with — an operator sees the inverted-pair
 * explanation while typing, instead of discovering it through a 400.
 *
 * What lives here is the part the backend has no opinion about:
 *
 *  - **The unit the form works in.** The setting stores a probability, but a
 *    bare `0.05` in a box is precisely how a `100`-meaning-one-percent typo
 *    happens, so the field is a PERCENTAGE and the conversion lives here.
 *  - **Saying the cost out loud.** Exploration buys unbiased training data with
 *    someone's answer quality. {@link explorationImpact} turns the abstract
 *    probability into the sentence that trade actually deserves.
 */

import {
	type ExplorationRateValidation,
	validateExplorationRate,
} from "$server/runtime/routing/exploration";
import { validateShadowThresholds } from "$server/runtime/routing/shadow";
import type { TierThresholds } from "$server/runtime/tier-classifier";

/** Stored fractions carry more precision than the form can type, so both
 *  directions of the ×100 round — otherwise a typed `8.7` would store
 *  `0.08700000000000001` and read back as `8.700000000000001`. */
const RATE_DECIMALS = 6;
const PERCENT_DECIMALS = 4;

/**
 * Above this share of traffic, exploration stops being a sampling experiment
 * and becomes the routing policy. Not a limit — the operator may still save
 * it — but the impact line says so louder.
 */
export const HIGH_EXPLORATION_RATE = 0.2;

/** The stored probability as the percentage the form shows, or `null` (an
 *  empty box) when exploration is off. */
export function percentFromRate(rate: number): number | null {
	if (rate <= 0) return null;
	return Number((rate * 100).toFixed(PERCENT_DECIMALS));
}

/** The typed percentage as a stored probability, or the reason it is not one. */
export function rateFromPercent(percent: number | null): ExplorationRateValidation {
	// An empty box is not a typo — it is the operator turning exploration off.
	if (percent === null || !Number.isFinite(percent)) return { ok: true, rate: 0 };
	const checked = validateExplorationRate(Number((percent / 100).toFixed(RATE_DECIMALS)));
	if (checked.ok) return checked;
	// The backend's own message is phrased in fractions because that is what it
	// stores; this box is a percentage, so say it in the operator's units.
	return { ok: false, error: `${percent}% is not a share of traffic — enter 0 to 100` };
}

/**
 * Does saving `next` need the operator to acknowledge what exploration costs?
 *
 * Only when it puts MORE traffic on a deliberately weaker model than is
 * running today. Turning exploration down or off is always allowed with no
 * ceremony — making things safer should never need a confirmation.
 */
export function needsAcknowledgement(current: number, next: number): boolean {
	return next > current;
}

/** How loudly the impact line should read. */
export type ExplorationLevel = "off" | "on" | "high";

export interface ExplorationImpact {
	level: ExplorationLevel;
	text: string;
}

/**
 * What a given rate means for the people using this deployment, in plain
 * words. Deliberately concrete ("about 1 in 20 turns"), because a probability
 * on its own reads as a tuning parameter rather than as somebody's worse
 * answer.
 */
export function explorationImpact(rate: number): ExplorationImpact {
	if (rate <= 0) {
		return { level: "off", text: "Off — every routed turn is served the tier the classifier picked." };
	}
	const share = rate >= 1 ? "Every routed turn" : `About 1 in ${Math.round(1 / rate)} routed turns`;
	return {
		level: rate > HIGH_EXPLORATION_RATE ? "high" : "on",
		text:
			`${share} will be answered one tier BELOW what the classifier asked for. ` +
			"Some of those answers will be worse — that is the price of the data.",
	};
}

/** The shadow form's two boxes. `null` is an empty box, not a zero. */
export interface ShadowForm {
	fastMaxTokens: number | null;
	powerfulMinTokens: number | null;
}

/** What the two boxes currently amount to. `empty` is shadow mode OFF — the
 *  same thing an absent setting means. */
export type ShadowFormState =
	| { kind: "empty" }
	| { kind: "invalid"; error: string }
	| { kind: "valid"; thresholds: TierThresholds };

/** The stored candidate as form values; both boxes empty when it is unset. */
export function shadowFormFrom(thresholds: TierThresholds | undefined): ShadowForm {
	return {
		fastMaxTokens: thresholds?.fastMaxTokens ?? null,
		powerfulMinTokens: thresholds?.powerfulMinTokens ?? null,
	};
}

/**
 * Read the two boxes.
 *
 * Half a pair is its own case: it is neither a candidate nor "off", and the
 * server would reject it with a message about ONE field, which reads like the
 * other field is fine. Everything else defers to the backend validator, so the
 * inverted-pair explanation the form shows is the server's own sentence.
 */
export function readShadowForm(form: ShadowForm): ShadowFormState {
	const { fastMaxTokens, powerfulMinTokens } = form;
	if (fastMaxTokens === null && powerfulMinTokens === null) return { kind: "empty" };
	if (fastMaxTokens === null || powerfulMinTokens === null) {
		return {
			kind: "invalid",
			error: "Set both thresholds, or clear both to turn shadow mode off.",
		};
	}
	const checked = validateShadowThresholds({ fastMaxTokens, powerfulMinTokens });
	if (!checked.ok) return { kind: "invalid", error: checked.error };
	return { kind: "valid", thresholds: checked.thresholds };
}

/** True when `form` names the candidate that is already stored — a save would
 *  rewrite the row with what it already holds. */
export function shadowUnchanged(form: ShadowForm, stored: TierThresholds | undefined): boolean {
	const current = shadowFormFrom(stored);
	return (
		form.fastMaxTokens === current.fastMaxTokens &&
		form.powerfulMinTokens === current.powerfulMinTokens
	);
}

/**
 * What to show when a save fails. The route answers a rejected edit with the
 * validator's sentence, which is the single most useful thing an operator can
 * be told — so it is surfaced verbatim, and only a failure with nothing to say
 * (a dropped connection) falls back to generic text.
 */
export function saveErrorMessage(err: unknown): string {
	if (err instanceof Error && err.message) return err.message;
	return "Save failed — the setting was not changed.";
}
