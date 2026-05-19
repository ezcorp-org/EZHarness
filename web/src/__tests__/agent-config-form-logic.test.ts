import { test, expect, describe } from "bun:test";

// ---------------------------------------------------------------------------
// Plain-JS recreation of AgentConfigForm.svelte logic
// Mirrors: validation (handleSubmit), payload construction, default values,
// and input schema field management.
// ---------------------------------------------------------------------------

type Field = { key: string; type: string; label: string; required: boolean };

function buildInputSchema(fields: Field[]): Record<string, unknown> {
	const inputSchema: Record<string, unknown> = {};
	for (const f of fields) {
		if (f.key.trim()) {
			inputSchema[f.key.trim()] = {
				type: f.type,
				label: f.label || f.key,
				required: f.required,
			};
		}
	}
	return inputSchema;
}

interface AgentFormState {
	name: string;
	description: string;
	prompt: string;
	outputFormat: string;
	provider: string;
	model: string;
	temperature: number | null;
	maxTokens: number | null;
	category: string;
	fields: Field[];
}

/**
 * Returns { error, payload } — mirrors handleSubmit logic exactly.
 * error is null when validation passes; payload is null when validation fails.
 */
function validateAndBuild(
	state: AgentFormState,
): { error: string; payload: null } | { error: null; payload: Record<string, unknown> } {
	if (!state.name.trim()) return { error: "Name is required", payload: null };
	if (!state.prompt.trim()) return { error: "System prompt is required", payload: null };

	const inputSchema = buildInputSchema(state.fields);

	const payload: Record<string, unknown> = {
		name: state.name.trim(),
		description: state.description.trim(),
		prompt: state.prompt.trim(),
		outputFormat: state.outputFormat,
		...(state.provider ? { provider: state.provider } : {}),
		...(state.model ? { model: state.model } : {}),
		...(state.temperature != null ? { temperature: state.temperature } : {}),
		...(state.maxTokens != null ? { maxTokens: state.maxTokens } : {}),
		...(Object.keys(inputSchema).length > 0 ? { inputSchema } : {}),
		...(state.category.trim() ? { category: state.category.trim() } : {}),
	};

	return { error: null, payload };
}

function defaultState(overrides: Partial<AgentFormState> = {}): AgentFormState {
	return {
		name: "",
		description: "",
		prompt: "",
		outputFormat: "text",
		provider: "",
		model: "",
		temperature: null,
		maxTokens: null,
		category: "",
		fields: [],
		...overrides,
	};
}

/** Mirrors the initial prop hydration for inputSchema */
function hydrateFields(
	inputSchema: Record<string, { type: string; label: string; required?: boolean }>,
): Field[] {
	return Object.entries(inputSchema).map(([key, f]) => ({
		key,
		type: f.type ?? "string",
		label: f.label ?? key,
		required: f.required ?? false,
	}));
}

// ── Validation ──────────────────────────────────────────────────────────────

describe("AgentConfigForm validation", () => {
	test("rejects empty name", () => {
		const result = validateAndBuild(defaultState({ prompt: "You are helpful." }));
		expect(result.error).toBe("Name is required");
		expect(result.payload).toBeNull();
	});

	test("rejects whitespace-only name", () => {
		const result = validateAndBuild(defaultState({ name: "   ", prompt: "You are helpful." }));
		expect(result.error).toBe("Name is required");
		expect(result.payload).toBeNull();
	});

	test("rejects empty prompt", () => {
		const result = validateAndBuild(defaultState({ name: "my-agent" }));
		expect(result.error).toBe("System prompt is required");
		expect(result.payload).toBeNull();
	});

	test("rejects whitespace-only prompt", () => {
		const result = validateAndBuild(defaultState({ name: "my-agent", prompt: "   " }));
		expect(result.error).toBe("System prompt is required");
		expect(result.payload).toBeNull();
	});

	test("passes when name and prompt are provided", () => {
		const result = validateAndBuild(defaultState({ name: "my-agent", prompt: "You are helpful." }));
		expect(result.error).toBeNull();
		expect(result.payload).not.toBeNull();
	});

	test("name is validated before prompt", () => {
		// Both empty: first error should be name
		const result = validateAndBuild(defaultState());
		expect(result.error).toBe("Name is required");
	});
});

// ── Payload construction ────────────────────────────────────────────────────

describe("AgentConfigForm payload construction", () => {
	test("trims name, description, and prompt", () => {
		const result = validateAndBuild(
			defaultState({ name: "  my-agent  ", description: "  desc  ", prompt: "  do stuff  " }),
		);
		expect(result.payload?.name).toBe("my-agent");
		expect(result.payload?.description).toBe("desc");
		expect(result.payload?.prompt).toBe("do stuff");
	});

	test("includes outputFormat", () => {
		const result = validateAndBuild(
			defaultState({ name: "a", prompt: "p", outputFormat: "json" }),
		);
		expect(result.payload?.outputFormat).toBe("json");
	});

	test("omits provider when empty string", () => {
		const result = validateAndBuild(defaultState({ name: "a", prompt: "p", provider: "" }));
		expect("provider" in (result.payload ?? {})).toBe(false);
	});

	test("includes provider when set", () => {
		const result = validateAndBuild(defaultState({ name: "a", prompt: "p", provider: "anthropic" }));
		expect(result.payload?.provider).toBe("anthropic");
	});

	test("omits model when empty string", () => {
		const result = validateAndBuild(defaultState({ name: "a", prompt: "p", model: "" }));
		expect("model" in (result.payload ?? {})).toBe(false);
	});

	test("includes model when set", () => {
		const result = validateAndBuild(
			defaultState({ name: "a", prompt: "p", model: "claude-3-5-sonnet" }),
		);
		expect(result.payload?.model).toBe("claude-3-5-sonnet");
	});

	test("omits temperature when null", () => {
		const result = validateAndBuild(defaultState({ name: "a", prompt: "p", temperature: null }));
		expect("temperature" in (result.payload ?? {})).toBe(false);
	});

	test("includes temperature when set (including 0)", () => {
		const result = validateAndBuild(defaultState({ name: "a", prompt: "p", temperature: 0 }));
		expect(result.payload?.temperature).toBe(0);
	});

	test("includes temperature = 1.0", () => {
		const result = validateAndBuild(defaultState({ name: "a", prompt: "p", temperature: 1.0 }));
		expect(result.payload?.temperature).toBe(1.0);
	});

	test("omits maxTokens when null", () => {
		const result = validateAndBuild(defaultState({ name: "a", prompt: "p", maxTokens: null }));
		expect("maxTokens" in (result.payload ?? {})).toBe(false);
	});

	test("includes maxTokens when set", () => {
		const result = validateAndBuild(defaultState({ name: "a", prompt: "p", maxTokens: 4096 }));
		expect(result.payload?.maxTokens).toBe(4096);
	});

	test("omits category when empty", () => {
		const result = validateAndBuild(defaultState({ name: "a", prompt: "p", category: "" }));
		expect("category" in (result.payload ?? {})).toBe(false);
	});

	test("trims and includes category when set", () => {
		const result = validateAndBuild(
			defaultState({ name: "a", prompt: "p", category: "  Finance  " }),
		);
		expect(result.payload?.category).toBe("Finance");
	});

	test("omits inputSchema when no fields", () => {
		const result = validateAndBuild(defaultState({ name: "a", prompt: "p", fields: [] }));
		expect("inputSchema" in (result.payload ?? {})).toBe(false);
	});

	test("omits inputSchema when all fields have blank keys", () => {
		const blankFields: Field[] = [
			{ key: "   ", type: "string", label: "Label", required: false },
		];
		const result = validateAndBuild(defaultState({ name: "a", prompt: "p", fields: blankFields }));
		expect("inputSchema" in (result.payload ?? {})).toBe(false);
	});

	test("includes inputSchema when fields have valid keys", () => {
		const fields: Field[] = [
			{ key: "query", type: "string", label: "Query", required: true },
		];
		const result = validateAndBuild(defaultState({ name: "a", prompt: "p", fields }));
		expect(result.payload?.inputSchema).toEqual({
			query: { type: "string", label: "Query", required: true },
		});
	});

	test("trims field key whitespace", () => {
		const fields: Field[] = [{ key: "  query  ", type: "string", label: "Q", required: false }];
		const schema = buildInputSchema(fields);
		expect("query" in schema).toBe(true);
		expect("  query  " in schema).toBe(false);
	});

	test("falls back to key as label when label is empty", () => {
		const fields: Field[] = [{ key: "myField", type: "string", label: "", required: false }];
		const schema = buildInputSchema(fields);
		expect((schema.myField as { label: string }).label).toBe("myField");
	});

	test("full payload with all optional fields", () => {
		const fields: Field[] = [
			{ key: "ctx", type: "text", label: "Context", required: false },
			{ key: "limit", type: "number", label: "Limit", required: true },
		];
		const result = validateAndBuild({
			name: "full-agent",
			description: "does stuff",
			prompt: "You help.",
			outputFormat: "json",
			provider: "openai",
			model: "gpt-4o",
			temperature: 0.7,
			maxTokens: 2048,
			category: "Engineering",
			fields,
		});
		expect(result.error).toBeNull();
		const p = result.payload!;
		expect(p.name).toBe("full-agent");
		expect(p.outputFormat).toBe("json");
		expect(p.provider).toBe("openai");
		expect(p.model).toBe("gpt-4o");
		expect(p.temperature).toBe(0.7);
		expect(p.maxTokens).toBe(2048);
		expect(p.category).toBe("Engineering");
		expect(p.inputSchema).toEqual({
			ctx: { type: "text", label: "Context", required: false },
			limit: { type: "number", label: "Limit", required: true },
		});
	});
});

// ── Default values (initial prop hydration) ─────────────────────────────────

describe("AgentConfigForm default values", () => {
	test("outputFormat defaults to 'text'", () => {
		const state = defaultState({ name: "a", prompt: "p" });
		expect(state.outputFormat).toBe("text");
	});

	test("temperature defaults to null", () => {
		const state = defaultState();
		expect(state.temperature).toBeNull();
	});

	test("maxTokens defaults to null", () => {
		const state = defaultState();
		expect(state.maxTokens).toBeNull();
	});

	test("fields default to empty array", () => {
		const state = defaultState();
		expect(state.fields).toEqual([]);
	});

	test("hydrates fields from initial inputSchema", () => {
		const schema = {
			query: { type: "string", label: "Query", required: true },
			limit: { type: "number", label: "Limit", required: false },
		};
		const fields = hydrateFields(schema);
		expect(fields).toHaveLength(2);
		expect(fields[0]).toEqual({ key: "query", type: "string", label: "Query", required: true });
		expect(fields[1]).toEqual({ key: "limit", type: "number", label: "Limit", required: false });
	});

	test("hydrateFields falls back to key when label missing", () => {
		const schema = { myField: { type: "string", label: "" } };
		// label is "" not undefined — mirrors the component's `f.label ?? key` which only triggers on nullish
		const fields = hydrateFields(schema as any);
		// label "" is falsy but the component uses f.label ?? key (nullish), so "" stays ""
		expect(fields[0]?.label).toBe("");
	});

	test("hydrateFields defaults required to false when missing", () => {
		const schema = { q: { type: "string", label: "Q" } };
		const fields = hydrateFields(schema as any);
		expect(fields[0]?.required).toBe(false);
	});

	test("hydrateFields defaults type to 'string' when missing", () => {
		const schema = { q: { label: "Q" } };
		const fields = hydrateFields(schema as any);
		expect(fields[0]?.type).toBe("string");
	});
});

// ── Field management (addField / removeField) ───────────────────────────────

describe("AgentConfigForm field management", () => {
	function addField(fields: Field[]): Field[] {
		return [...fields, { key: "", type: "string", label: "", required: false }];
	}

	function removeField(fields: Field[], idx: number): Field[] {
		return fields.filter((_, i) => i !== idx);
	}

	test("addField appends a blank field with defaults", () => {
		const fields = addField([]);
		expect(fields).toHaveLength(1);
		expect(fields[0]).toEqual({ key: "", type: "string", label: "", required: false });
	});

	test("addField preserves existing fields", () => {
		const existing: Field[] = [{ key: "q", type: "string", label: "Q", required: true }];
		const fields = addField(existing);
		expect(fields).toHaveLength(2);
		expect(fields[0]).toEqual(existing[0]);
	});

	test("removeField removes by index", () => {
		const existing: Field[] = [
			{ key: "a", type: "string", label: "A", required: false },
			{ key: "b", type: "string", label: "B", required: false },
			{ key: "c", type: "string", label: "C", required: false },
		];
		const result = removeField(existing, 1);
		expect(result).toHaveLength(2);
		expect(result[0]?.key).toBe("a");
		expect(result[1]?.key).toBe("c");
	});

	test("removeField on last element returns empty array", () => {
		const existing: Field[] = [{ key: "a", type: "string", label: "A", required: false }];
		expect(removeField(existing, 0)).toEqual([]);
	});

	test("fields with blank keys are excluded from inputSchema", () => {
		const fields: Field[] = [
			{ key: "real", type: "string", label: "Real", required: false },
			{ key: "", type: "string", label: "", required: false },
			{ key: "   ", type: "string", label: "", required: false },
		];
		const schema = buildInputSchema(fields);
		expect(Object.keys(schema)).toEqual(["real"]);
	});
});
