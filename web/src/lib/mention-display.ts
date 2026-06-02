/**
 * Compact-display layer for the chat composer.
 *
 * The composer edits text in a `<textarea>` whose glyphs are transparent; a
 * mirrored overlay paints pretty mention chips on top. To keep the caret and
 * any following text aligned with the chips, the textarea and the overlay must
 * lay out each mention in the SAME horizontal space.
 *
 * Historically that space was the full raw wire token (`![agent:Code
 * Assistant]`), which is far wider than the chip's visible label
 * (`!Code Assistant`). The leftover width showed up as a large blank gap to
 * the right of every chip (and the caret floated out there after selecting a
 * mention).
 *
 * This module decouples what the textarea *lays out* (a COMPACT display
 * string, e.g. `!Code Assistant`) from what travels on the wire (the full
 * `![kind:name]` token). The wire string remains the single source of truth
 * for parsing, submission and server-side expansion — it is never changed by
 * this layer. We only translate edits made against the compact display string
 * back onto the wire string, and map caret offsets between the two spaces.
 *
 * Key invariant that keeps the translation simple and safe: mention tokens are
 * ATOMIC. The composer never lets the caret sit inside a token, deletes whole
 * tokens on Backspace/Delete, and commits new tokens through explicit handlers
 * that mutate the wire string directly. So a plain keystroke / paste only ever
 * edits the PLAIN-TEXT regions between tokens — which are byte-identical in the
 * display and wire strings. {@link applyDisplayEdit} relies on exactly that.
 */

import { getSegments } from "./mention-logic";

/**
 * The compact label shown in the textarea (and reserved in the overlay) for a
 * mention of the given wire `kind` + `name`. Mirrors `MentionChip`'s
 * sigil + `displayName` logic so the transparent textarea token lines up with
 * the visible chip painted over it.
 *
 * `kind` is the wire/segment kind emitted by `MENTION_REGEX`
 * (`agent | ext | team | EZ | file | dir | cmd | feature | lesson`).
 */
/**
 * Trailing pad appended to every compact label. The visible chip pill is wider
 * than its bare label text (rounded-full border + horizontal padding), so it
 * overflows a bare-label reservation and butts up against whatever follows.
 * Padding the reservation here widens the textarea/overlay footprint so the
 * pill sits inside it AND leaves a clear gap before the next character — the
 * same "breathing room after the pill" the literal `/goal` command commits.
 * Display-only: it never touches the wire token (`value`).
 */
const DISPLAY_TOKEN_PAD = "    ";

export function displayTokenText(kind: string, name: string): string {
	if (kind === "EZ") return `!EZ:${name}${DISPLAY_TOKEN_PAD}`;
	if (kind === "file" || kind === "dir") {
		const slash = name.lastIndexOf("/");
		const base = slash >= 0 ? name.slice(slash + 1) : name;
		return (kind === "dir" ? `@${base}/` : `@${base}`) + DISPLAY_TOKEN_PAD;
	}
	const sigil = kind === "cmd" ? "/" : kind === "feature" ? "$" : kind === "lesson" ? "%" : "!";
	return `${sigil}${name}${DISPLAY_TOKEN_PAD}`;
}

/** One mention's footprint in both the wire string and the display string. */
export interface DisplaySpan {
	/** Start offset of the raw token in the wire string. */
	wStart: number;
	/** End offset (exclusive) of the raw token in the wire string. */
	wEnd: number;
	/** Start offset of the compact label in the display string. */
	dStart: number;
	/** End offset (exclusive) of the compact label in the display string. */
	dEnd: number;
	kind: string;
	name: string;
}

/**
 * Project a wire string onto its compact display string, returning the display
 * text plus the per-mention span map used to translate offsets/edits.
 */
export function toDisplay(wire: string): { display: string; spans: DisplaySpan[] } {
	const segments = getSegments(wire);
	const spans: DisplaySpan[] = [];
	let display = "";
	let wPos = 0;
	let dPos = 0;
	for (const seg of segments) {
		if (seg.type === "text") {
			display += seg.text;
			wPos += seg.text.length;
			dPos += seg.text.length;
		} else {
			const label = displayTokenText(seg.kind, seg.name);
			const wLen = seg.raw.length;
			spans.push({
				wStart: wPos,
				wEnd: wPos + wLen,
				dStart: dPos,
				dEnd: dPos + label.length,
				kind: seg.kind,
				name: seg.name,
			});
			display += label;
			wPos += wLen;
			dPos += label.length;
		}
	}
	return { display, spans };
}

/** Convenience: just the compact display string for a wire string. */
export function wireToDisplayString(wire: string): string {
	return toDisplay(wire).display;
}

/**
 * Map a caret offset in DISPLAY space to the equivalent offset in WIRE space.
 * Offsets that land inside a token snap to the token's far edge (in the
 * direction of travel is the caller's concern — we clamp to the nearest
 * boundary based on which half the offset falls in).
 */
export function displayPosToWire(spans: DisplaySpan[], dPos: number): number {
	let wire = dPos;
	for (const s of spans) {
		if (s.dEnd <= dPos) {
			// Token fully before the caret: add the width the wire token has
			// over its compact label.
			wire += (s.wEnd - s.wStart) - (s.dEnd - s.dStart);
		} else if (dPos > s.dStart && dPos < s.dEnd) {
			// Inside a token — snap to the nearest wire boundary.
			const mid = (s.dStart + s.dEnd) / 2;
			return dPos <= mid ? s.wStart : s.wEnd;
		} else {
			break;
		}
	}
	return wire;
}

/**
 * Map a caret offset in WIRE space to the equivalent offset in DISPLAY space.
 * Mirror of {@link displayPosToWire}.
 */
export function wirePosToDisplay(spans: DisplaySpan[], wPos: number): number {
	let disp = wPos;
	for (const s of spans) {
		if (s.wEnd <= wPos) {
			disp -= (s.wEnd - s.wStart) - (s.dEnd - s.dStart);
		} else if (wPos > s.wStart && wPos < s.wEnd) {
			const mid = (s.wStart + s.wEnd) / 2;
			return wPos <= mid ? s.dStart : s.dEnd;
		} else {
			break;
		}
	}
	return disp;
}

/**
 * Translate an edit made against the compact display string back onto the wire
 * string.
 *
 * Computes the minimal changed window (common prefix + common suffix) between
 * the old and new display strings. When that window lies entirely in plain
 * text (the normal case — typing, deleting or pasting between tokens) the same
 * text is spliced into the wire string at the mapped offsets and the rebuilt
 * wire string is returned.
 *
 * A deletion/replacement whose window *fully covers* one or more chip labels
 * (a range selection, a Cmd/Ctrl line-or-word kill, or select-all → delete) is
 * also accepted: the covered wire tokens are spliced out wholesale, mapping the
 * window's edges across the remaining chips. Only the chips entirely inside the
 * window disappear; chips outside it are untouched.
 *
 * Returns `null` only when the edit window cuts *partway* into a token's
 * interior (e.g. a selection boundary that landed mid-chip), which would
 * corrupt the `![kind:name]` syntax. The caller treats `null` as "reject /
 * resync" — such partial cuts are expected to go through the explicit
 * atomic-delete handler, not through free-form text edits.
 */
export function applyDisplayEdit(oldWire: string, newDisplay: string): string | null {
	const { display: oldDisplay, spans } = toDisplay(oldWire);
	if (newDisplay === oldDisplay) return oldWire;

	const maxPrefix = Math.min(oldDisplay.length, newDisplay.length);
	let p = 0;
	while (p < maxPrefix && oldDisplay[p] === newDisplay[p]) p++;

	let s = 0;
	const maxSuffix = maxPrefix - p;
	while (
		s < maxSuffix &&
		oldDisplay[oldDisplay.length - 1 - s] === newDisplay[newDisplay.length - 1 - s]
	) {
		s++;
	}

	const editStartD = p;
	const editEndD = oldDisplay.length - s;

	// An edit that overlaps a chip is only safe when it *fully* covers that
	// chip's compact label — then the whole wire token is spliced out below.
	// A partial cut into a token's interior (a boundary landing mid-chip) would
	// corrupt the `![kind:name]` syntax, so reject it and let the caller resync.
	for (const sp of spans) {
		const overlaps = editStartD < sp.dEnd && editEndD > sp.dStart;
		if (!overlaps) continue;
		const fullyCovers = editStartD <= sp.dStart && editEndD >= sp.dEnd;
		if (!fullyCovers) return null;
	}

	const wStart = displayPosToWire(spans, editStartD);
	const wEnd = displayPosToWire(spans, editEndD);
	const inserted = newDisplay.slice(p, newDisplay.length - s);
	return oldWire.slice(0, wStart) + inserted + oldWire.slice(wEnd);
}
