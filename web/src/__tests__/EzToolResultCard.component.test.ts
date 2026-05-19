/**
 * Phase 48 Wave 3 + agent-install-ux-polish Phase 1 — DOM tests for
 * EzToolResultCard.
 *
 * Covers:
 *   - the single primary action renders as a real <a href> (D2: safe
 *     Svelte href binding, NEVER {@html}; SvelteKit auto-enhances
 *     same-origin relative anchors to client nav)
 *   - propose_* callers keep the original "Open prefilled form" label
 *     and their tool-name-specific heading copy (regression)
 *   - the agent-install result (openUrlLabel="Open extension",
 *     relative "/extensions/<name>") renders an
 *     <a href="/extensions/weather"> with the "Open extension" label
 *   - empty openUrl renders an inert (aria-disabled, no href) affordance
 */
import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/svelte";
import { describe, test, expect } from "vitest";
import EzToolResultCard from "$lib/components/ez/EzToolResultCard.svelte";

describe("EzToolResultCard — render", () => {
	test("renders the primary action as an <a href> with default label", () => {
		const { getByTestId } = render(EzToolResultCard, {
			props: {
				result: { openUrl: "/new-project?prefill=abc", draftId: "abc" },
			},
		});
		const link = getByTestId("ez-card-open");
		expect(link).toBeInTheDocument();
		expect(link.tagName).toBe("A");
		expect(link).toHaveAttribute("href", "/new-project?prefill=abc");
		expect(link).toHaveTextContent(/Open prefilled form/i);
	});

	test("uses propose_create_project default copy when toolName matches", () => {
		const { getByTestId } = render(EzToolResultCard, {
			props: {
				result: { openUrl: "/new-project?prefill=abc" },
				toolName: "propose_create_project",
			},
		});
		const card = getByTestId("ez-tool-result-card");
		expect(card).toHaveTextContent(/Open new project form/i);
		expect(card).toHaveAttribute("data-tool-name", "propose_create_project");
		// Regression: propose_* label unchanged.
		expect(getByTestId("ez-card-open")).toHaveTextContent(/Open prefilled form/i);
	});

	test("uses propose_create_agent default copy when toolName matches", () => {
		const { getByTestId } = render(EzToolResultCard, {
			props: {
				result: { openUrl: "/agents/new?prefill=abc" },
				toolName: "propose_create_agent",
			},
		});
		expect(getByTestId("ez-tool-result-card")).toHaveTextContent(/Open new agent form/i);
		expect(getByTestId("ez-card-open")).toHaveTextContent(/Open prefilled form/i);
	});

	test("respects explicit title/summary props over defaults", () => {
		const { getByTestId } = render(EzToolResultCard, {
			props: {
				result: { openUrl: "/x", title: "Custom Heading", summary: "Custom blurb." },
			},
		});
		const card = getByTestId("ez-tool-result-card");
		expect(card).toHaveTextContent(/Custom Heading/);
		expect(card).toHaveTextContent(/Custom blurb./);
	});
});

describe("EzToolResultCard — install card (agent-install Phase 1)", () => {
	test("renders <a href='/extensions/weather'> with the 'Open extension' label", () => {
		// Exactly the shape the host `install_draft` result produces:
		// `{ ok, extensionId, name, openUrl }` plus the D1 label
		// override. The card binds the relative path straight onto the
		// anchor's href (D2 safe binding) — no scheme/host/`..`.
		const { getByTestId } = render(EzToolResultCard, {
			props: {
				result: {
					openUrl: "/extensions/weather",
					openUrlLabel: "Open extension",
					title: "Extension installed",
					summary: "weather is installed and enabled.",
				},
				toolName: "install_draft",
			},
		});
		const link = getByTestId("ez-card-open");
		expect(link.tagName).toBe("A");
		expect(link).toHaveAttribute("href", "/extensions/weather");
		// Relative, same-origin: no protocol, no host.
		expect(link.getAttribute("href")).toMatch(/^\/extensions\/weather$/);
		expect(link).toHaveTextContent(/Open extension/);
		expect(link).not.toHaveTextContent(/Open prefilled form/);
	});

	test("openUrlLabel does not leak into other cards (default unchanged)", () => {
		const { getByTestId } = render(EzToolResultCard, {
			props: { result: { openUrl: "/marketplace?q=pdf" } },
		});
		expect(getByTestId("ez-card-open")).toHaveTextContent(/Open prefilled form/i);
	});
});

describe("EzToolResultCard — empty url", () => {
	test("empty openUrl renders an inert, aria-disabled affordance with no href", () => {
		const { getByTestId } = render(EzToolResultCard, {
			props: { result: { openUrl: "" } },
		});
		const el = getByTestId("ez-card-open");
		expect(el.tagName).not.toBe("A");
		expect(el).not.toHaveAttribute("href");
		expect(el).toHaveAttribute("aria-disabled", "true");
	});
});
