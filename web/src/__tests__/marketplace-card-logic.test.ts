import { test, expect, describe } from "bun:test";
import type { MarketplaceListing } from "../lib/api.js";

// Pure logic extracted from MarketplaceCard.svelte

function ratingDisplay(listing: Pick<MarketplaceListing, "ratingTotal" | "ratingPercent">): string {
	return listing.ratingTotal > 0 ? `${listing.ratingPercent}%` : "New";
}

function displayTags(listing: Pick<MarketplaceListing, "tags">): string[] {
	return (listing.tags ?? []).slice(0, 3);
}

function isFlaggedVisible(showFlagBadge: boolean, status: string): boolean {
	return showFlagBadge && status === "flagged";
}

function cardHref(id: string): string {
	return `/marketplace/${id}`;
}

function versionLabel(version: string): string {
	return `v${version}`;
}

// ── ratingDisplay ────────────────────────────────────────────────────

describe("ratingDisplay", () => {
	test("shows percentage when ratingTotal > 0", () => {
		expect(ratingDisplay({ ratingTotal: 10, ratingPercent: 80 })).toBe("80%");
	});

	test("shows 0% when ratingTotal > 0 and percent is 0", () => {
		expect(ratingDisplay({ ratingTotal: 5, ratingPercent: 0 })).toBe("0%");
	});

	test("shows 100% for perfect rating", () => {
		expect(ratingDisplay({ ratingTotal: 3, ratingPercent: 100 })).toBe("100%");
	});

	test("shows New when ratingTotal is 0", () => {
		expect(ratingDisplay({ ratingTotal: 0, ratingPercent: 0 })).toBe("New");
	});

	test("shows New when ratingTotal is 0 even if percent is non-zero", () => {
		// guard: shouldn't happen in practice but logic depends only on ratingTotal
		expect(ratingDisplay({ ratingTotal: 0, ratingPercent: 99 })).toBe("New");
	});
});

// ── displayTags ──────────────────────────────────────────────────────

describe("displayTags", () => {
	test("returns up to 3 tags", () => {
		expect(displayTags({ tags: ["a", "b", "c", "d", "e"] })).toEqual(["a", "b", "c"]);
	});

	test("returns all tags when fewer than 3", () => {
		expect(displayTags({ tags: ["x", "y"] })).toEqual(["x", "y"]);
	});

	test("returns empty array when tags is empty", () => {
		expect(displayTags({ tags: [] })).toEqual([]);
	});

	test("returns empty array when tags is null/undefined (fallback)", () => {
		// The component uses (listing.tags ?? []).slice(0, 3)
		expect(displayTags({ tags: null as unknown as string[] })).toEqual([]);
	});

	test("returns exactly 3 when exactly 3 tags provided", () => {
		expect(displayTags({ tags: ["a", "b", "c"] })).toEqual(["a", "b", "c"]);
	});
});

// ── isFlaggedVisible ─────────────────────────────────────────────────

describe("isFlaggedVisible", () => {
	test("visible when showFlagBadge true and status is flagged", () => {
		expect(isFlaggedVisible(true, "flagged")).toBe(true);
	});

	test("not visible when showFlagBadge false, even if flagged", () => {
		expect(isFlaggedVisible(false, "flagged")).toBe(false);
	});

	test("not visible when status is not flagged", () => {
		expect(isFlaggedVisible(true, "active")).toBe(false);
	});

	test("not visible when both false/non-flagged", () => {
		expect(isFlaggedVisible(false, "active")).toBe(false);
	});

	test("not visible for other statuses like pending", () => {
		expect(isFlaggedVisible(true, "pending")).toBe(false);
	});
});

// ── cardHref ─────────────────────────────────────────────────────────

describe("cardHref", () => {
	test("produces correct marketplace detail URL", () => {
		expect(cardHref("abc-123")).toBe("/marketplace/abc-123");
	});

	test("handles slug-style ids", () => {
		expect(cardHref("my-agent-slug")).toBe("/marketplace/my-agent-slug");
	});
});

// ── versionLabel ─────────────────────────────────────────────────────

describe("versionLabel", () => {
	test("prepends v to version string", () => {
		expect(versionLabel("1.0.0")).toBe("v1.0.0");
	});

	test("prepends v to any version string", () => {
		expect(versionLabel("2.3.4-beta")).toBe("v2.3.4-beta");
	});
});
