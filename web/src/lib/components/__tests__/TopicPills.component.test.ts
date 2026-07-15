/**
 * DOM tests for TopicPills.svelte — the hover-revealed pill overlay on a chat
 * message row. Verifies: one pill per anchored topic, the extract callback
 * fires once per click, the in-flight guard (busyId) blocks re-entry + shows
 * a per-pill spinner, and an empty topic list renders nothing.
 */
import { describe, test, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import "@testing-library/jest-dom/vitest";
import TopicPills from "../chat/TopicPills.svelte";
import type { Topic } from "$lib/topic-contexts-logic";

const topics: Topic[] = [
	{ id: "t1", label: "Auth flow", typeId: "feature", messageIds: ["m1"] },
	{ id: "t2", label: "Rate limiting", typeId: "bug-fix", messageIds: ["m1"] },
];

describe("TopicPills", () => {
	test("renders a pill per topic with a type-colour dot", () => {
		const { getByTestId } = render(TopicPills, {
			props: { topics, onextract: vi.fn() },
		});
		expect(getByTestId("topic-pill-t1")).toHaveTextContent("Auth flow");
		expect(getByTestId("topic-pill-t2")).toHaveTextContent("Rate limiting");
		// Not busy → colour dot, no spinner.
		expect(document.querySelector('[data-testid="topic-pill-spinner"]')).toBeNull();
	});

	test("empty topic list renders nothing", () => {
		const { queryByTestId } = render(TopicPills, {
			props: { topics: [], onextract: vi.fn() },
		});
		expect(queryByTestId("topic-pills")).toBeNull();
	});

	test("clicking a pill fires onextract once with the topic id", async () => {
		const onextract = vi.fn();
		const { getByTestId } = render(TopicPills, { props: { topics, onextract } });
		await fireEvent.click(getByTestId("topic-pill-t1"));
		expect(onextract).toHaveBeenCalledTimes(1);
		expect(onextract).toHaveBeenCalledWith("t1");
	});

	test("in-flight (busyId set) blocks clicks and shows a spinner on that pill", async () => {
		const onextract = vi.fn();
		const { getByTestId } = render(TopicPills, {
			props: { topics, busyId: "t1", onextract },
		});
		// The busy pill shows a spinner and is disabled; a click is guarded.
		expect(getByTestId("topic-pill-spinner")).toBeInTheDocument();
		expect(getByTestId("topic-pill-t1")).toBeDisabled();
		await fireEvent.click(getByTestId("topic-pill-t1"));
		// Clicking a different (also-disabled) pill is likewise guarded.
		await fireEvent.click(getByTestId("topic-pill-t2"));
		expect(onextract).not.toHaveBeenCalled();
	});
});
