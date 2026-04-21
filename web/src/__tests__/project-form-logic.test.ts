import { test, expect, describe } from "bun:test";

// ---------------------------------------------------------------------------
// Plain-JS recreation of ProjectForm.svelte logic
// Mirrors: variable parsing (JSON / string fallback), hashColor, payload
// construction, and var entry management.
// ---------------------------------------------------------------------------

// ── Variable parsing ─────────────────────────────────────────────────────────
// Mirrors the handleSubmit loop exactly:
//   try { JSON.parse(v) } catch { v }

function parseVariables(varEntries: [string, string][]): Record<string, unknown> {
	const variables: Record<string, unknown> = {};
	for (const [k, v] of varEntries) {
		if (k.trim()) {
			try {
				variables[k.trim()] = JSON.parse(v);
			} catch {
				variables[k.trim()] = v;
			}
		}
	}
	return variables;
}

describe("ProjectForm variable parsing", () => {
	test("parses JSON number value", () => {
		expect(parseVariables([["port", "3000"]])).toEqual({ port: 3000 });
	});

	test("parses JSON boolean true", () => {
		expect(parseVariables([["flag", "true"]])).toEqual({ flag: true });
	});

	test("parses JSON boolean false", () => {
		expect(parseVariables([["flag", "false"]])).toEqual({ flag: false });
	});

	test("parses JSON null", () => {
		expect(parseVariables([["val", "null"]])).toEqual({ val: null });
	});

	test("parses JSON array", () => {
		expect(parseVariables([["tags", '["a","b"]']])).toEqual({ tags: ["a", "b"] });
	});

	test("parses JSON object", () => {
		expect(parseVariables([["cfg", '{"x":1}']])).toEqual({ cfg: { x: 1 } });
	});

	test("falls back to raw string for plain text", () => {
		expect(parseVariables([["env", "production"]])).toEqual({ env: "production" });
	});

	test("falls back to raw string for partial JSON", () => {
		expect(parseVariables([["bad", "{not json}"]])).toEqual({ bad: "{not json}" });
	});

	test("skips entries with empty key", () => {
		const result = parseVariables([["", "value"]]);
		expect(Object.keys(result)).toHaveLength(0);
	});

	test("skips entries with whitespace-only key", () => {
		const result = parseVariables([["   ", "value"]]);
		expect(Object.keys(result)).toHaveLength(0);
	});

	test("trims key whitespace", () => {
		const result = parseVariables([["  API_KEY  ", "secret"]]);
		expect("API_KEY" in result).toBe(true);
		expect("  API_KEY  " in result).toBe(false);
	});

	test("handles multiple entries, mixed types", () => {
		const result = parseVariables([
			["PORT", "8080"],
			["DEBUG", "true"],
			["NAME", "my-project"],
			["TAGS", '["x","y"]'],
		]);
		expect(result).toEqual({
			PORT: 8080,
			DEBUG: true,
			NAME: "my-project",
			TAGS: ["x", "y"],
		});
	});

	test("empty varEntries produce empty variables", () => {
		expect(parseVariables([])).toEqual({});
	});

	test("empty value string parses as empty string (JSON.parse throws)", () => {
		// JSON.parse("") throws — so falls back to raw ""
		const result = parseVariables([["key", ""]]);
		expect(result.key).toBe("");
	});

	test("quoted string value parses as JSON string", () => {
		const result = parseVariables([["msg", '"hello world"']]);
		expect(result.msg).toBe("hello world");
	});
});

// ── hashColor ────────────────────────────────────────────────────────────────
// Mirrors the hashColor function in ProjectForm.svelte exactly.

const BG_COLORS = [
	"bg-blue-600", "bg-green-600", "bg-purple-600", "bg-orange-600",
	"bg-pink-600", "bg-teal-600", "bg-indigo-600", "bg-red-600",
];

function hashColor(n: string): string {
	let hash = 0;
	for (let i = 0; i < n.length; i++) hash = (hash * 31 + n.charCodeAt(i)) | 0;
	return BG_COLORS[Math.abs(hash) % BG_COLORS.length]!;
}

describe("ProjectForm hashColor", () => {
	test("returns a value from BG_COLORS", () => {
		expect(BG_COLORS).toContain(hashColor("my-project"));
	});

	test("is deterministic — same input yields same color", () => {
		expect(hashColor("hello")).toBe(hashColor("hello"));
	});

	test("different names can yield different colors", () => {
		// Not guaranteed, but empirically true for these two
		const colors = new Set(["Alpha", "Beta", "Gamma", "Delta", "Epsilon"].map(hashColor));
		// At minimum, we should get more than one distinct color across 5 names
		expect(colors.size).toBeGreaterThan(1);
	});

	test("empty string returns a color without throwing", () => {
		expect(() => hashColor("")).not.toThrow();
		expect(BG_COLORS).toContain(hashColor(""));
	});

	test("single character returns a color", () => {
		expect(BG_COLORS).toContain(hashColor("P"));
	});

	test("long string returns a color", () => {
		expect(BG_COLORS).toContain(hashColor("a".repeat(200)));
	});
});

// ── Payload construction ─────────────────────────────────────────────────────
// Mirrors handleSubmit: onsubmit({ name, path, icon, variables })

interface ProjectPayload {
	name: string;
	path: string;
	icon: string | null;
	variables: Record<string, unknown>;
}

function buildProjectPayload(
	name: string,
	path: string,
	icon: string | null,
	varEntries: [string, string][],
): ProjectPayload {
	const variables = parseVariables(varEntries);
	return { name, path, icon, variables };
}

describe("ProjectForm payload construction", () => {
	test("basic payload with name and path", () => {
		const payload = buildProjectPayload("my-project", "/home/user/proj", null, []);
		expect(payload).toEqual({ name: "my-project", path: "/home/user/proj", icon: null, variables: {} });
	});

	test("includes icon when provided", () => {
		const payload = buildProjectPayload("p", "/tmp", "data:image/png;base64,abc", []);
		expect(payload.icon).toBe("data:image/png;base64,abc");
	});

	test("icon is null when not set", () => {
		const payload = buildProjectPayload("p", "/tmp", null, []);
		expect(payload.icon).toBeNull();
	});

	test("variables are included from varEntries", () => {
		const payload = buildProjectPayload("p", "/tmp", null, [
			["PORT", "3000"],
			["ENV", "dev"],
		]);
		expect(payload.variables).toEqual({ PORT: 3000, ENV: "dev" });
	});

	test("empty varEntries result in empty variables object", () => {
		const payload = buildProjectPayload("p", "/tmp", null, []);
		expect(payload.variables).toEqual({});
	});

	test("varEntries with blank keys are excluded from variables", () => {
		const payload = buildProjectPayload("p", "/tmp", null, [
			["", "ignored"],
			["KEY", "val"],
		]);
		expect(Object.keys(payload.variables)).toEqual(["KEY"]);
	});
});

// ── Default varEntries hydration ─────────────────────────────────────────────
// Mirrors: project?.variables
//   ? Object.entries(project.variables).map(([k,v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])
//   : [["", ""]]

function hydrateVarEntries(variables?: Record<string, unknown>): [string, string][] {
	if (!variables) return [["", ""]];
	return Object.entries(variables).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
}

describe("ProjectForm varEntries hydration from project", () => {
	test("no project → single blank entry", () => {
		expect(hydrateVarEntries(undefined)).toEqual([["", ""]]);
	});

	test("string values are kept as-is", () => {
		const result = hydrateVarEntries({ ENV: "production" });
		expect(result).toEqual([["ENV", "production"]]);
	});

	test("number values are JSON-serialized", () => {
		const result = hydrateVarEntries({ PORT: 3000 } as any);
		expect(result).toEqual([["PORT", "3000"]]);
	});

	test("boolean values are JSON-serialized", () => {
		const result = hydrateVarEntries({ DEBUG: true } as any);
		expect(result).toEqual([["DEBUG", "true"]]);
	});

	test("array values are JSON-serialized", () => {
		const result = hydrateVarEntries({ TAGS: ["a", "b"] } as any);
		expect(result).toEqual([["TAGS", '["a","b"]']]);
	});

	test("mixed types are handled correctly", () => {
		const result = hydrateVarEntries({ NAME: "proj", PORT: 8080, FLAG: false } as any);
		expect(result).toContainEqual(["NAME", "proj"]);
		expect(result).toContainEqual(["PORT", "8080"]);
		expect(result).toContainEqual(["FLAG", "false"]);
	});

	test("hydrated entries round-trip through parseVariables", () => {
		const original = { NAME: "proj", PORT: 8080, TAGS: ["x", "y"], FLAG: true };
		const entries = hydrateVarEntries(original as any);
		const parsed = parseVariables(entries as [string, string][]);
		expect(parsed).toEqual(original);
	});
});

// ── Var entry management (addVar / removeVar) ────────────────────────────────

describe("ProjectForm var entry management", () => {
	function addVar(entries: [string, string][]): [string, string][] {
		return [...entries, ["", ""]];
	}

	function removeVar(entries: [string, string][], idx: number): [string, string][] {
		return entries.filter((_, i) => i !== idx);
	}

	test("addVar appends blank entry", () => {
		const result = addVar([]);
		expect(result).toEqual([["", ""]]);
	});

	test("addVar preserves existing entries", () => {
		const existing: [string, string][] = [["KEY", "val"]];
		const result = addVar(existing);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual(["KEY", "val"]);
		expect(result[1]).toEqual(["", ""]);
	});

	test("removeVar removes by index", () => {
		const entries: [string, string][] = [["A", "1"], ["B", "2"], ["C", "3"]];
		const result = removeVar(entries, 1);
		expect(result).toEqual([["A", "1"], ["C", "3"]]);
	});

	test("removeVar on last element returns empty array", () => {
		expect(removeVar([["K", "v"]], 0)).toEqual([]);
	});

	test("removeVar does not mutate original", () => {
		const entries: [string, string][] = [["A", "1"], ["B", "2"]];
		removeVar(entries, 0);
		expect(entries).toHaveLength(2);
	});
});
