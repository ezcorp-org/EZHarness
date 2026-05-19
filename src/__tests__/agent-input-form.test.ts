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

describe("web build", () => {
	// In CI / Docker the SvelteKit build is already run during image creation
	// (Dockerfile.test line: `bun run build`). Re-running it here competes for
	// CPU/memory with parallel test processes and causes flaky timeouts.
	const skip = !!process.env.CI;

	(skip ? test.skip : test)(
		"svelte app builds successfully",
		async () => {
			const { join } = require("node:path");
			const webDir = join(import.meta.dir, "../../web");
			const proc = Bun.spawn([process.execPath, "run", "build"], {
				cwd: webDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			if (exitCode !== 0) {
				const stderr = await new Response(proc.stderr).text();
				console.error("Build stderr:", stderr);
			}
			expect(exitCode).toBe(0);
		},
		{ timeout: 60_000 },
	);
});
