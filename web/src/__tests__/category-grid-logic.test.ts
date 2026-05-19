import { test, expect, describe } from "bun:test";

// Pure logic extracted from CategoryGrid.svelte

const CATEGORIES = [
	{ name: "Productivity", icon: "\u{1F4CB}" },
	{ name: "Development", icon: "\u{1F4BB}" },
	{ name: "Writing", icon: "\u{270F}\u{FE0F}" },
	{ name: "Research", icon: "\u{1F50D}" },
	{ name: "Education", icon: "\u{1F393}" },
	{ name: "Creative", icon: "\u{1F3A8}" },
	{ name: "Data & Analysis", icon: "\u{1F4CA}" },
	{ name: "Communication", icon: "\u{1F4AC}" },
	{ name: "Modes", icon: "\u{1F3AF}" },
	{ name: "Other", icon: "\u2699\uFE0F" },
] as const;

/** Toggle logic: selecting the already-selected category deselects it (returns null). */
function toggle(selected: string | null, name: string): string | null {
	return selected === name ? null : name;
}

/** Returns the icon for a given category name, or undefined if not found. */
function iconFor(name: string): string | undefined {
	return CATEGORIES.find((c) => c.name === name)?.icon;
}

// ── category list ────────────────────────────────────────────────────

describe("CATEGORIES list", () => {
	test("contains exactly 10 categories", () => {
		expect(CATEGORIES.length).toBe(10);
	});

	test("all categories have a name and icon", () => {
		for (const cat of CATEGORIES) {
			expect(cat.name.length).toBeGreaterThan(0);
			expect(cat.icon.length).toBeGreaterThan(0);
		}
	});

	test("category names are unique", () => {
		const names = CATEGORIES.map((c) => c.name);
		expect(new Set(names).size).toBe(names.length);
	});

	test("includes expected categories", () => {
		const names = CATEGORIES.map((c) => c.name);
		expect(names).toContain("Productivity");
		expect(names).toContain("Development");
		expect(names).toContain("Writing");
		expect(names).toContain("Modes");
		expect(names).toContain("Other");
	});
});

// ── toggle logic ─────────────────────────────────────────────────────

describe("toggle", () => {
	test("selects a category when none is selected", () => {
		expect(toggle(null, "Productivity")).toBe("Productivity");
	});

	test("deselects when the same category is toggled again", () => {
		expect(toggle("Productivity", "Productivity")).toBeNull();
	});

	test("switches from one category to another", () => {
		expect(toggle("Writing", "Development")).toBe("Development");
	});

	test("returns null when toggling an already-selected item", () => {
		expect(toggle("Modes", "Modes")).toBeNull();
	});

	test("selecting from null always returns the name", () => {
		for (const cat of CATEGORIES) {
			expect(toggle(null, cat.name)).toBe(cat.name);
		}
	});
});

// ── icon mapping ─────────────────────────────────────────────────────

describe("iconFor", () => {
	test("returns icon for Productivity", () => {
		expect(iconFor("Productivity")).toBe("📋");
	});

	test("returns icon for Development", () => {
		expect(iconFor("Development")).toBe("💻");
	});

	test("returns icon for Research", () => {
		expect(iconFor("Research")).toBe("🔍");
	});

	test("returns icon for Data & Analysis", () => {
		expect(iconFor("Data & Analysis")).toBe("📊");
	});

	test("returns undefined for unknown category", () => {
		expect(iconFor("Nonexistent")).toBeUndefined();
	});

	test("returns icon for every defined category", () => {
		for (const cat of CATEGORIES) {
			expect(iconFor(cat.name)).toBe(cat.icon);
		}
	});
});

// ── count display logic ───────────────────────────────────────────────

describe("count display", () => {
	test("singular memory label for count of 1", () => {
		const count = 1;
		const label = `${count} ${count === 1 ? "category" : "categories"}`;
		expect(label).toBe("1 category");
	});

	test("plural label for count > 1", () => {
		const count: number = 3;
		const label = `${count} ${count === 1 ? "category" : "categories"}`;
		expect(label).toBe("3 categories");
	});

	test("plural label for count 0", () => {
		const count: number = 0;
		const label = `${count} ${count === 1 ? "category" : "categories"}`;
		expect(label).toBe("0 categories");
	});
});
