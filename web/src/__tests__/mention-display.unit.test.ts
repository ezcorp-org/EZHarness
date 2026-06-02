import { test, expect, describe } from "vitest";
import {
	displayTokenText,
	toDisplay,
	displayPosToWire,
	wirePosToDisplay,
	applyDisplayEdit,
	wireToDisplayString,
} from "../lib/mention-display";

/**
 * Unit coverage for the compact-display transform that backs the chat
 * composer. These are pure functions — they translate between the wire string
 * (`![kind:name]` tokens) and the compact display string the textarea lays
 * out (`!name` + a little trailing pad), and map caret offsets / edits between
 * the two spaces.
 *
 * The trailing pad (`DISPLAY_TOKEN_PAD`) is display-only breathing room after
 * each chip; the tests derive it from `displayTokenText` so they stay correct
 * if the pad width is ever retuned.
 */
const PAD = displayTokenText("agent", "X").slice("!X".length);

describe("displayTokenText — compact label per kind", () => {
	test("agent/ext/team/feature/lesson/cmd use their sigil + full name", () => {
		expect(displayTokenText("agent", "Code Assistant")).toBe("!Code Assistant" + PAD);
		expect(displayTokenText("ext", "analyzer")).toBe("!analyzer" + PAD);
		expect(displayTokenText("team", "Squad")).toBe("!Squad" + PAD);
		expect(displayTokenText("cmd", "deploy")).toBe("/deploy" + PAD);
		expect(displayTokenText("feature", "auth")).toBe("$auth" + PAD);
		expect(displayTokenText("lesson", "git-stash")).toBe("%git-stash" + PAD);
	});

	test("EZ keeps its EZ: prefix under the ! sigil", () => {
		expect(displayTokenText("EZ", "distill")).toBe("!EZ:distill" + PAD);
	});

	test("file/dir collapse to the basename (dir keeps trailing slash)", () => {
		expect(displayTokenText("file", "src/very/deep/component.svelte")).toBe("@component.svelte" + PAD);
		expect(displayTokenText("file", "app.ts")).toBe("@app.ts" + PAD);
		expect(displayTokenText("dir", "src/lib/components")).toBe("@components/" + PAD);
	});

	test("the label trims to its bare compact form (pad is trailing-only)", () => {
		expect(displayTokenText("agent", "Code Assistant").trimEnd()).toBe("!Code Assistant");
		expect(PAD).toMatch(/^ {2,}$/); // a couple of spaces of breathing room
	});
});

describe("toDisplay — wire → compact display + span map", () => {
	test("plain text is identical in both spaces", () => {
		const { display, spans } = toDisplay("hello world");
		expect(display).toBe("hello world");
		expect(spans).toEqual([]);
	});

	test("single agent token compacts and records the span", () => {
		const wire = "![agent:Code Assistant]";
		const label = displayTokenText("agent", "Code Assistant");
		const { display, spans } = toDisplay(wire);
		expect(display).toBe(label);
		expect(spans).toHaveLength(1);
		expect(spans[0]).toMatchObject({
			wStart: 0,
			wEnd: wire.length,
			dStart: 0,
			dEnd: label.length,
			kind: "agent",
			name: "Code Assistant",
		});
	});

	test("text + token + text keeps surrounding plain text aligned", () => {
		const wire = "use @[file:src/deep/x.ts] now";
		const { display, spans } = toDisplay(wire);
		expect(display).toBe("use " + displayTokenText("file", "src/deep/x.ts") + " now");
		expect(spans).toHaveLength(1);
		// Plain text before the token is byte-identical → same start offset.
		expect(wire.slice(0, spans[0]!.wStart)).toBe("use ");
		expect(display.slice(0, spans[0]!.dStart)).toBe("use ");
		// Plain text after the token (past its pad) is preserved verbatim.
		expect(display.slice(spans[0]!.dEnd)).toBe(" now");
	});

	test("multiple tokens accumulate the wire/display offset drift", () => {
		const wire = "![agent:A] mid /[cmd:deploy]";
		const { display, spans } = toDisplay(wire);
		expect(display).toBe(
			displayTokenText("agent", "A") + " mid " + displayTokenText("cmd", "deploy"),
		);
		expect(spans).toHaveLength(2);
		expect(spans[1]!.kind).toBe("cmd");
		expect(display.slice(spans[1]!.dStart, spans[1]!.dEnd)).toBe(displayTokenText("cmd", "deploy"));
	});

	test("wireToDisplayString is the display-only shortcut", () => {
		expect(wireToDisplayString("x ![team:Ops] y")).toBe("x " + displayTokenText("team", "Ops") + " y");
	});
});

describe("position mapping round-trips", () => {
	const wire = "go ![agent:Code Assistant] then @[file:src/x.ts] end";
	const { spans } = toDisplay(wire);

	test("offsets in leading plain text are identity", () => {
		expect(displayPosToWire(spans, 0)).toBe(0);
		expect(displayPosToWire(spans, 3)).toBe(3); // before the first token
		expect(wirePosToDisplay(spans, 3)).toBe(3);
	});

	test("offset just after the first compact token maps past the wire token", () => {
		const dAfterFirst = ("go " + displayTokenText("agent", "Code Assistant")).length;
		const wAfterFirst = "go ![agent:Code Assistant]".length;
		expect(displayPosToWire(spans, dAfterFirst)).toBe(wAfterFirst);
		expect(wirePosToDisplay(spans, wAfterFirst)).toBe(dAfterFirst);
	});

	test("trailing plain text maps both directions", () => {
		const { display } = toDisplay(wire);
		expect(displayPosToWire(spans, display.length)).toBe(wire.length);
		expect(wirePosToDisplay(spans, wire.length)).toBe(display.length);
	});

	test("a caret inside a token snaps to a wire boundary", () => {
		// "go !C" — offset 4 sits one char into the agent label.
		const inside = 4;
		const snapped = displayPosToWire(spans, inside);
		expect([3, "go ![agent:Code Assistant]".length]).toContain(snapped);
	});
});

describe("applyDisplayEdit — translate display edits onto the wire", () => {
	test("no-op when display is unchanged", () => {
		const wire = "![agent:A] hi";
		expect(applyDisplayEdit(wire, toDisplay(wire).display)).toBe(wire);
	});

	test("typing trailing text appends to the wire after the token + its real space", () => {
		const wire = "![agent:Code Assistant] "; // committed token carries one real space
		const newDisplay = toDisplay(wire).display + "world"; // type past the pad
		expect(applyDisplayEdit(wire, newDisplay)).toBe("![agent:Code Assistant] world");
	});

	test("typing leading text prepends in the wire before the token", () => {
		const wire = "![agent:A]";
		const newDisplay = "hey " + toDisplay(wire).display; // typed "hey " in front
		expect(applyDisplayEdit(wire, newDisplay)).toBe("hey ![agent:A]");
	});

	test("editing plain text between two tokens leaves both wire tokens intact", () => {
		const wire = "![agent:A] mid /[cmd:deploy]";
		const newDisplay = toDisplay(wire).display.replace(" mid ", " MIDDLE ");
		expect(applyDisplayEdit(wire, newDisplay)).toBe("![agent:A] MIDDLE /[cmd:deploy]");
	});

	test("deleting trailing plain text shrinks only the wire's plain tail", () => {
		const wire = "![agent:A] keep this";
		const newDisplay = toDisplay(wire).display.replace(" this", ""); // deleted " this"
		expect(applyDisplayEdit(wire, newDisplay)).toBe("![agent:A] keep");
	});

	test("file token: typing after the compact basename preserves the full wire path", () => {
		const wire = "@[file:src/very/deep/component.svelte] ";
		const newDisplay = toDisplay(wire).display + "ok"; // typed "ok" past the pad
		expect(applyDisplayEdit(wire, newDisplay)).toBe(
			"@[file:src/very/deep/component.svelte] ok",
		);
	});

	test("returns null when an edit chews into a token's interior", () => {
		const wire = "![agent:Code Assistant]";
		// Simulate a range-selection that deleted into the label
		// ("!Code Assistant…" → "!Code"), which is NOT a plain-text edit.
		expect(applyDisplayEdit(wire, "!Code")).toBeNull();
	});

	// ── Deletions that FULLY cover one or more chips ────────────────────
	// These back the highlight+delete / Cmd+Delete / select-all behaviors in
	// the composer: a window that wholly contains a chip label splices the
	// whole wire token out (vs the old code, which rejected ANY chip overlap).

	test("select-all + delete clears a message containing a chip", () => {
		const wire = "hello ![agent:Bob] world";
		expect(applyDisplayEdit(wire, "")).toBe("");
	});

	test("highlight+delete of exactly one chip's label removes only that token", () => {
		const wire = "hi ![agent:Bob] there";
		const { display, spans } = toDisplay(wire);
		// Delete the chip's compact label (dStart..dEnd), keeping the text around it.
		const newDisplay = display.slice(0, spans[0]!.dStart) + display.slice(spans[0]!.dEnd);
		expect(applyDisplayEdit(wire, newDisplay)).toBe("hi  there");
	});

	test("Cmd+Delete to line start removes a chip plus the text before the caret", () => {
		const wire = "keep ![agent:Bob] tail";
		const { display } = toDisplay(wire);
		// Caret sits right before " tail"; kill-to-line-start deletes everything
		// up to it, swallowing the leading text AND the chip.
		const tail = " tail";
		expect(applyDisplayEdit(wire, tail)).toBe(tail);
		// Sanity: the killed display window did end at the chip-free tail.
		expect(display.endsWith(tail)).toBe(true);
	});

	test("a window covering several chips drops all of their wire tokens", () => {
		const wire = "a ![agent:A] b /[cmd:deploy] c";
		const { display, spans } = toDisplay(wire);
		// Select from just before the first chip to just after the second, delete.
		const newDisplay = display.slice(0, spans[0]!.dStart) + display.slice(spans[1]!.dEnd);
		// Both chips and the " b " between them vanish; the surrounding "a " and
		// " c" are kept verbatim (so the two retained spaces sit adjacent).
		expect(applyDisplayEdit(wire, newDisplay)).toBe("a  c");
	});

	test("deleting one of two chips leaves the untouched chip's wire token intact", () => {
		const wire = "![agent:A] mid /[cmd:deploy]";
		const { display, spans } = toDisplay(wire);
		// Remove only the first chip's label.
		const newDisplay = display.slice(spans[0]!.dEnd);
		expect(applyDisplayEdit(wire, newDisplay)).toBe(" mid /[cmd:deploy]");
	});

	test("a selection boundary landing mid-chip is still rejected", () => {
		const wire = "x ![agent:Bob] y";
		const { display, spans } = toDisplay(wire);
		// End the deletion one char into the chip label (after its sigil) — a
		// partial cut that would corrupt the token, so it must reject.
		const newDisplay = display.slice(0, spans[0]!.dStart + 1);
		expect(applyDisplayEdit(wire, newDisplay)).toBeNull();
	});

	test("round-trips a realistic multi-token message edit", () => {
		const wire = "ping ![agent:Bot] re @[file:a/b.ts] thanks";
		const { display } = toDisplay(wire);
		// User appends "!" to the end.
		const newWire = applyDisplayEdit(wire, display + "!");
		expect(newWire).toBe("ping ![agent:Bot] re @[file:a/b.ts] thanks!");
		// And the new wire still projects to the edited display.
		expect(toDisplay(newWire!).display).toBe(display + "!");
	});
});
