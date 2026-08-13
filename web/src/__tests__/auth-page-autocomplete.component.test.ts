/**
 * Rendered-DOM autocomplete contract for the three auth pages Playwright's
 * mock tier cannot reach.
 *
 * `auth-autocomplete.spec.ts` asserts this in a real browser for
 * `/reset-password/[token]` and `/account`. It cannot do the same for `/login`,
 * `/setup` or `/signup/[token]`: each one's `+page.server.ts` calls
 * `getUserCount()` / `getInviteByToken()`, and under the e2e preview server's
 * `PI_SKIP_INIT=1` there is no DB, so all three serve a 500 (verified with
 * `curl`). That is why `auth-login.spec.ts` and `setup-first-run.spec.ts` drive
 * a hand-written HTML reimplementation — and why asserting `autocomplete`
 * against those shells would prove nothing about the app.
 *
 * So these render the REAL `+page.svelte` through the Svelte compiler and read
 * the attributes off the resulting DOM. Server loads never run, so no DB is
 * needed; the markup is the component's own.
 *
 * `input-autocomplete-guard.test.ts` covers the same fields from the SOURCE
 * side, tree-wide. The two are complementary, not redundant: the guard catches
 * a NEW page nobody wrote a test for, these catch an attribute that is present
 * in the source but lost on the way to the DOM.
 */

import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/svelte";
import { describe, test, expect } from "vitest";
import LoginPage from "../routes/(auth)/login/+page.svelte";
import SetupPage from "../routes/(auth)/setup/+page.svelte";
import SignupPage from "../routes/(auth)/signup/[token]/+page.svelte";

/** `#id` → the `[type, autocomplete]` pair the rendered input must carry. */
type FieldContract = Record<string, [type: string, autocomplete: string]>;

/**
 * Read `[type, autocomplete]` off each `#id` in the rendered DOM.
 *
 * Returns a plain record instead of asserting internally, for two reasons: the
 * assertion belongs in the test (a helper that hides every `expect` reads as an
 * assertion-free test to `scripts/gate-integrity.ts`), and comparing the whole
 * record at once shows the entire form in the diff rather than stopping at the
 * first bad field. A missing input becomes a value, not a throw, so "did not
 * render" also shows up in that diff.
 */
function readFields(container: HTMLElement, ids: readonly string[]): FieldContract {
	const out: FieldContract = {};
	for (const id of ids) {
		const input = container.querySelector<HTMLInputElement>(`#${id}`);
		out[id] = input
			? [input.getAttribute("type") ?? "(no type)", input.getAttribute("autocomplete") ?? "(none)"]
			: ["(did not render)", "(did not render)"];
	}
	return out;
}

describe("auth pages declare autocomplete on every credential input", () => {
	test("login: username + current-password", () => {
		const { container } = render(LoginPage, { props: { data: { returnTo: "/" } } });
		// `username` on the address (not `email`) is what pairs it with the
		// password field, so a manager fills a saved LOGIN rather than treating
		// the two as unrelated. `current-password` asks for the stored secret —
		// on a sign-in form `new-password` would suppress autofill entirely and
		// prompt to generate a new one.
		expect(readFields(container, ["email", "password"])).toEqual({
			email: ["email", "username"],
			password: ["password", "current-password"],
		});
	});

	test("setup: username + new-password on both fields", () => {
		const { container } = render(SetupPage);
		// First-run admin creation CREATES the credential, so both password
		// fields are `new-password` — that is what triggers the manager's
		// generate-and-save flow instead of offering an existing password.
		expect(readFields(container, ["email", "password", "confirmPassword"])).toEqual({
			email: ["email", "username"],
			password: ["password", "new-password"],
			confirmPassword: ["password", "new-password"],
		});
	});

	test("signup: username + new-password", () => {
		const { container } = render(SignupPage, {
			props: {
				data: {
					invite: { email: "invitee@test.local", role: "member" },
					token: "invite-token",
				},
			},
		});
		// Same reasoning as setup: an invited user is setting a password for the
		// first time, never re-entering one.
		expect(readFields(container, ["email", "password"])).toEqual({
			email: ["email", "username"],
			password: ["password", "new-password"],
		});
	});

	test("no credential input on these pages is left without an autocomplete", () => {
		// Belt-and-braces over the per-page contracts above: those name specific
		// ids, so a NEW password field added to one of these forms would slip
		// past them entirely. This sweeps whatever actually rendered.
		const rendered = [
			["login", render(LoginPage, { props: { data: { returnTo: "/" } } }).container],
			["setup", render(SetupPage).container],
			[
				"signup",
				render(SignupPage, {
					props: {
						data: {
							invite: { email: "invitee@test.local", role: "member" },
							token: "invite-token",
						},
					},
				}).container,
			],
		] as const;

		const missing: string[] = [];
		let checked = 0;
		for (const [name, container] of rendered) {
			for (const input of container.querySelectorAll<HTMLInputElement>(
				'input[type="password"], input[type="email"]',
			)) {
				checked++;
				const value = input.getAttribute("autocomplete");
				if (value === null || value.trim() === "") {
					missing.push(`${name}: <input type="${input.type}" id="${input.id || "(none)"}">`);
				}
			}
		}

		// Non-vacuity: if a render silently produced nothing, the loop above
		// finds no inputs and the assertion below passes having checked none.
		expect(checked).toBe(7);
		expect(missing, `credential input(s) without autocomplete:\n${missing.join("\n")}`).toEqual(
			[],
		);
	});
});
