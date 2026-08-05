import { test, expect, describe } from "bun:test";
import { inputClass } from "../../web/src/lib/styles.js";

// Re-implement pure logic from AgentInputForm.svelte for testing

type FieldDef = {
	type: string;
	label: string;
	default?: unknown;
	required?: boolean;
};
type InputSchema = Record<string, FieldDef>;

function toTitleCase(key: string): string {
	return key
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/[_-]/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

function inferSchema(
	vars: Record<string, unknown>,
	existing: InputSchema,
): InputSchema {
	const extra: InputSchema = {};
	for (const [key, value] of Object.entries(vars)) {
		if (key in existing) continue;
		const type =
			typeof value === "boolean"
				? "boolean"
				: typeof value === "number"
					? "number"
					: "string";
		extra[key] = { type, label: toTitleCase(key), default: value };
	}
	return extra;
}

function buildDefaults(
	s: InputSchema,
	extra: InputSchema,
	overrides: Record<string, unknown>,
): Record<string, unknown> {
	const base = Object.fromEntries(
		Object.entries(s).map(([key, field]) => [
			key,
			field.default ?? (field.type === "boolean" ? false : ""),
		]),
	);
	const extraBase = Object.fromEntries(
		Object.entries(extra).map(([key, field]) => [
			key,
			field.default ?? (field.type === "boolean" ? false : ""),
		]),
	);
	return { ...base, ...extraBase, ...overrides };
}

function cleanInput(
	formData: Record<string, unknown>,
	schema: InputSchema,
): Record<string, unknown> {
	const input: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(schema)) {
		const val = formData[key];
		if (val !== undefined && val !== null && val !== "") {
			input[key] = val;
		} else if (field.type === "boolean") {
			input[key] = val;
		}
	}
	return input;
}

describe("buildDefaults", () => {
	test("boolean field defaults to false", () => {
		const schema: InputSchema = {
			flag: { type: "boolean", label: "Flag" },
		};
		const result = buildDefaults(schema, {}, {});
		expect(result.flag).toBe(false);
	});

	test("string field defaults to empty string", () => {
		const schema: InputSchema = {
			name: { type: "string", label: "Name" },
		};
		const result = buildDefaults(schema, {}, {});
		expect(result.name).toBe("");
	});

	test("explicit default is used", () => {
		const schema: InputSchema = {
			color: { type: "string", label: "Color", default: "blue" },
		};
		const result = buildDefaults(schema, {}, {});
		expect(result.color).toBe("blue");
	});

	test("overrides win over schema defaults", () => {
		const schema: InputSchema = {
			color: { type: "string", label: "Color", default: "blue" },
		};
		const result = buildDefaults(schema, {}, { color: "red" });
		expect(result.color).toBe("red");
	});

	test("extra vars are merged", () => {
		const schema: InputSchema = {
			name: { type: "string", label: "Name" },
		};
		const extra: InputSchema = {
			env: { type: "string", label: "Env", default: "prod" },
		};
		const result = buildDefaults(schema, extra, {});
		expect(result.name).toBe("");
		expect(result.env).toBe("prod");
	});
});

describe("inferSchema", () => {
	test("skips keys already in existing schema", () => {
		const existing: InputSchema = {
			name: { type: "string", label: "Name" },
		};
		const result = inferSchema({ name: "test", extra: "val" }, existing);
		expect(result.name).toBeUndefined();
		expect(result.extra).toBeDefined();
	});

	test("infers boolean type", () => {
		const result = inferSchema({ verbose: true }, {});
		expect(result.verbose!.type).toBe("boolean");
	});

	test("infers number type", () => {
		const result = inferSchema({ count: 42 }, {});
		expect(result.count!.type).toBe("number");
	});

	test("infers string type", () => {
		const result = inferSchema({ greeting: "hello" }, {});
		expect(result.greeting!.type).toBe("string");
	});

	test("title-cases snake_case keys", () => {
		const result = inferSchema({ my_var: "x" }, {});
		expect(result.my_var!.label).toBe("My Var");
	});

	test("title-cases camelCase keys", () => {
		const result = inferSchema({ camelCase: "x" }, {});
		expect(result.camelCase!.label).toBe("Camel Case");
	});

	test("title-cases kebab-case keys", () => {
		const result = inferSchema({ "my-key": "x" }, {});
		expect(result["my-key"]!.label).toBe("My Key");
	});
});

describe("cleanInput", () => {
	test("omits empty string values", () => {
		const schema: InputSchema = {
			name: { type: "string", label: "Name" },
		};
		const result = cleanInput({ name: "" }, schema);
		expect(result.name).toBeUndefined();
	});

	test("keeps numeric zero", () => {
		const schema: InputSchema = {
			count: { type: "number", label: "Count" },
		};
		const result = cleanInput({ count: 0 }, schema);
		expect(result.count).toBe(0);
	});

	test("keeps false for boolean fields", () => {
		const schema: InputSchema = {
			flag: { type: "boolean", label: "Flag" },
		};
		const result = cleanInput({ flag: false }, schema);
		expect(result.flag).toBe(false);
	});

	test("omits undefined values", () => {
		const schema: InputSchema = {
			name: { type: "string", label: "Name" },
		};
		const result = cleanInput({ name: undefined }, schema);
		expect(result.name).toBeUndefined();
	});

	test("omits null values", () => {
		const schema: InputSchema = {
			name: { type: "string", label: "Name" },
		};
		const result = cleanInput({ name: null }, schema);
		expect(result.name).toBeUndefined();
	});

	test("keeps non-empty string values", () => {
		const schema: InputSchema = {
			name: { type: "string", label: "Name" },
		};
		const result = cleanInput({ name: "hello" }, schema);
		expect(result.name).toBe("hello");
	});
});

describe("styles", () => {
	test("inputClass is a non-empty string", () => {
		expect(typeof inputClass).toBe("string");
		expect(inputClass.length).toBeGreaterThan(0);
	});
});

// A `web build > svelte app builds successfully` case used to live here: it
// spawned a full `bun run build` in `web/` and asserted exit code 0, under a
// 180s timeout, skipped whenever `process.env.CI` was set. It is GONE, and
// nothing it asserted went with it.
//
//   - It never gated anything. `test.skip` on CI meant it ran in exactly the
//     one place where a red is advisory (a dev box) and never in the one place
//     where a red blocks a merge.
//   - The property IS gated, by a required check that runs the REAL build:
//     `web/playwright.config.ts:66` boots the mock-tier e2e lane with
//     `PI_SKIP_INIT=1 bun run build && … bun run preview`, so a build that
//     fails takes the whole e2e job down. `release-image.yml` builds it again
//     in the image. Both are stricter than an exit-code assertion.
//   - It cost 40.1s of a 325s backend pool on an idle box — 12% of the whole
//     `bun run test` wall clock — for zero gate value, and the timeout comment
//     conceded it was already flaking under pool contention.
//   - It was a FALSE RED in the mandated agent workflow. `web/` is not a bun
//     workspace, so a fresh `git worktree add` + `bun install` leaves
//     `web/node_modules` absent and this file exits 1 in 0.9s on a tree with
//     nothing wrong with it. Measured, in this worktree, before installing.
//
// Everything above this line is pure form logic and needs none of that.
