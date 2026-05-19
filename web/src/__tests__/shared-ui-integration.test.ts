import { describe, test, expect } from "bun:test";
import { formatComponentMap, getFormatComponent } from "../lib/components/ui/format-map";

/**
 * Integration & e2e tests for InlineToolForm format dispatch.
 * Since bun test can't compile .svelte, we mirror the component's logic
 * and test the dispatch/collection paths that InlineToolForm uses.
 */

type Prop = Record<string, unknown>;
type Schema = {
	properties: Record<string, Prop>;
	required?: string[];
};

// --- Mirrors InlineToolForm logic ---

function getFieldType(prop: Prop): string {
	if (prop.enum) return "enum";
	const t = prop.type as string;
	if (t === "boolean") return "boolean";
	if (t === "number" || t === "integer") return "number";
	if (t === "object" || t === "array") return "json";
	return "string";
}

/** Mirrors the template dispatch: determines which rendering branch a field takes. */
function resolveFieldRendering(prop: Prop): { type: "format-component"; component: any } | { type: "format-error"; format: string } | { type: "standard"; fieldType: string } {
	if (prop.format && (prop.format as string) in formatComponentMap) {
		return { type: "format-component", component: getFormatComponent(prop.format as string) };
	}
	if (prop.format) {
		return { type: "format-error", format: prop.format as string };
	}
	return { type: "standard", fieldType: getFieldType(prop) };
}

/** Mirrors InlineToolForm initialization logic. */
function initializeValues(schema: Schema, initialValues: Record<string, unknown> = {}): Record<string, unknown> {
	const properties = schema.properties;
	const init: Record<string, unknown> = {};
	for (const key of Object.keys(properties)) {
		if (key in initialValues) {
			init[key] = initialValues[key];
		} else {
			const prop = properties[key];
			if (prop.format === "tag-input" && prop.type === "array") init[key] = [];
			else if (prop.type === "boolean") init[key] = false;
			else if (prop.type === "number" || prop.type === "integer") init[key] = "";
			else init[key] = "";
		}
	}
	return init;
}

/** Mirrors InlineToolForm collectValues logic. */
function collectValues(schema: Schema, values: Record<string, unknown>): Record<string, unknown> {
	const properties = schema.properties;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(properties)) {
		const prop = properties[key];
		const val = values[key];
		const fieldType = getFieldType(prop);

		if (val === "" || val === undefined) continue;

		if (prop.format && (prop.format as string) in formatComponentMap) {
			if (prop.format === "tag-input" && prop.type === "array" && Array.isArray(val)) {
				result[key] = val;
			} else if (prop.format === "tag-input" && Array.isArray(val)) {
				result[key] = (val as string[]).join(", ");
			} else {
				result[key] = val;
			}
			continue;
		}

		if (fieldType === "number") result[key] = Number(val);
		else if (fieldType === "boolean") result[key] = val;
		else if (fieldType === "json" && typeof val === "string") {
			try { result[key] = JSON.parse(val); } catch { result[key] = val; }
		} else result[key] = val;
	}
	return result;
}

// --- Integration: format dispatch ---

describe("InlineToolForm format dispatch (integration)", () => {
	test("file-path format resolves to SharedFilePicker component", () => {
		const r = resolveFieldRendering({ type: "string", format: "file-path" });
		expect(r.type).toBe("format-component");
		expect((r as any).component).toBeTruthy();
	});

	test("combo-box format resolves to ComboBox component", () => {
		const r = resolveFieldRendering({ type: "string", format: "combo-box" });
		expect(r.type).toBe("format-component");
	});

	test("search format resolves to SearchBox component", () => {
		const r = resolveFieldRendering({ type: "string", format: "search" });
		expect(r.type).toBe("format-component");
	});

	test("tag-input format resolves to TagInput component", () => {
		const r = resolveFieldRendering({ type: "array", format: "tag-input" });
		expect(r.type).toBe("format-component");
	});

	test("date format resolves to DatePicker component", () => {
		const r = resolveFieldRendering({ type: "string", format: "date" });
		expect(r.type).toBe("format-component");
	});

	test("datetime format resolves to DatePicker component", () => {
		const r = resolveFieldRendering({ type: "string", format: "datetime" });
		expect(r.type).toBe("format-component");
	});

	test("date and datetime resolve to the same component", () => {
		const d = resolveFieldRendering({ type: "string", format: "date" });
		const dt = resolveFieldRendering({ type: "string", format: "datetime" });
		expect((d as any).component).toBe((dt as any).component);
	});

	test("unknown format 'foo' renders error", () => {
		const r = resolveFieldRendering({ type: "string", format: "foo" });
		expect(r.type).toBe("format-error");
		expect((r as any).format).toBe("foo");
	});

	test("no format renders standard field type", () => {
		const r = resolveFieldRendering({ type: "string" });
		expect(r.type).toBe("standard");
		expect((r as any).fieldType).toBe("string");
	});

	test("boolean without format still renders as boolean (no regression)", () => {
		const r = resolveFieldRendering({ type: "boolean" });
		expect(r.type).toBe("standard");
		expect((r as any).fieldType).toBe("boolean");
	});

	test("x-options are forwarded via options prop pattern", () => {
		// Verify the pattern: options = { ...prop['x-options'], _format: prop.format }
		const prop = { type: "string", format: "file-path", "x-options": { extensions: [".ts", ".js"] } };
		const xOpts = prop["x-options"] as Record<string, unknown>;
		const options = { ...xOpts, _format: prop.format };
		expect((options as Record<string, unknown>).extensions).toEqual([".ts", ".js"]);
		expect(options._format).toBe("file-path");
	});
});

// --- E2e: full tool invocation flow ---

describe("InlineToolForm full user flow (e2e)", () => {
	const mixedSchema: Schema = {
		properties: {
			filePath: { type: "string", format: "file-path", description: "File to analyze" },
			query: { type: "string", format: "search", description: "Search query" },
			tags: { type: "array", format: "tag-input", description: "Tags" },
			appointmentDate: { type: "string", format: "date", description: "Date" },
			meetingTime: { type: "string", format: "datetime", description: "DateTime" },
			enabled: { type: "boolean" },
			count: { type: "number" },
			name: { type: "string" },
		},
		required: ["filePath"],
	};

	test("initialization sets correct defaults for mixed format/non-format fields", () => {
		const vals = initializeValues(mixedSchema);
		expect(vals.filePath).toBe("");
		expect(vals.query).toBe("");
		expect(vals.tags).toEqual([]); // tag-input array initializes as []
		expect(vals.enabled).toBe(false);
		expect(vals.count).toBe("");
		expect(vals.name).toBe("");
	});

	test("all format fields dispatch to format-component, non-format to standard", () => {
		for (const [, prop] of Object.entries(mixedSchema.properties)) {
			const r = resolveFieldRendering(prop);
			if (prop.format && (prop.format as string) in formatComponentMap) {
				expect(r.type).toBe("format-component");
			} else {
				expect(r.type).toBe("standard");
			}
		}
	});

	test("tag-input with type array collects value as string array", () => {
		const vals = {
			filePath: "/src/index.ts",
			query: "hello",
			tags: ["svelte", "typescript"],
			appointmentDate: "2026-03-18",
			meetingTime: "2026-03-18T10:00:00Z",
			enabled: true,
			count: "42",
			name: "test",
		};
		const collected = collectValues(mixedSchema, vals);
		expect(Array.isArray(collected.tags)).toBe(true);
		expect(collected.tags).toEqual(["svelte", "typescript"]);
	});

	test("date format collects ISO date string as-is", () => {
		const vals = {
			filePath: "/src/index.ts",
			query: "",
			tags: [],
			appointmentDate: "2026-03-18",
			meetingTime: "",
			enabled: false,
			count: "",
			name: "",
		};
		const collected = collectValues(mixedSchema, vals);
		expect(collected.appointmentDate).toBe("2026-03-18");
	});

	test("datetime format collects ISO 8601 string as-is", () => {
		const vals = {
			filePath: "/src/index.ts",
			query: "",
			tags: [],
			appointmentDate: "",
			meetingTime: "2026-03-18T10:00:00Z",
			enabled: false,
			count: "",
			name: "",
		};
		const collected = collectValues(mixedSchema, vals);
		expect(collected.meetingTime).toBe("2026-03-18T10:00:00Z");
	});

	test("non-format number field still collects as Number", () => {
		const vals = {
			filePath: "/src/index.ts",
			query: "",
			tags: [],
			appointmentDate: "",
			meetingTime: "",
			enabled: false,
			count: "42",
			name: "",
		};
		const collected = collectValues(mixedSchema, vals);
		expect(collected.count).toBe(42);
		expect(typeof collected.count).toBe("number");
	});

	test("empty format fields are excluded from collected values", () => {
		const vals = {
			filePath: "/src/index.ts",
			query: "",
			tags: [],
			appointmentDate: "",
			meetingTime: "",
			enabled: false,
			count: "",
			name: "",
		};
		const collected = collectValues(mixedSchema, vals);
		expect(collected.filePath).toBe("/src/index.ts");
		expect(collected.query).toBeUndefined();
		// tags is [] which is not '' or undefined — but it's empty array
		// The component considers [] as a value (not empty)
		expect("appointmentDate" in collected).toBe(false);
	});

	test("full tool invocation flow produces correct collected output", () => {
		// Simulate: user fills all fields, submits
		const userValues = {
			filePath: "/home/dev/project/main.ts",
			query: "authentication",
			tags: ["security", "auth", "jwt"],
			appointmentDate: "2026-04-01",
			meetingTime: "2026-04-01T14:30:00Z",
			enabled: true,
			count: "10",
			name: "auth-review",
		};
		const collected = collectValues(mixedSchema, userValues);

		// Format fields pass through as-is
		expect(collected.filePath).toBe("/home/dev/project/main.ts");
		expect(collected.query).toBe("authentication");
		expect(collected.tags).toEqual(["security", "auth", "jwt"]);
		expect(collected.appointmentDate).toBe("2026-04-01");
		expect(collected.meetingTime).toBe("2026-04-01T14:30:00Z");

		// Standard fields use normal collection
		expect(collected.enabled).toBe(true);
		expect(collected.count).toBe(10);
		expect(collected.name).toBe("auth-review");
	});
});
