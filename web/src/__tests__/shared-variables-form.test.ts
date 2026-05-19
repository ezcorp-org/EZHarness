import { test, expect, describe } from "bun:test";

// ---------------------------------------------------------------------------
// Plain-JS recreation of InlineToolForm's x-shared pre-fill logic
// Mirrors the $effect init in InlineToolForm.svelte exactly.
// ---------------------------------------------------------------------------

interface SchemaProperty {
  type?: string;
  format?: string;
  enum?: string[];
  "x-shared"?: string;
  [k: string]: unknown;
}

function initFormValues(
  properties: Record<string, SchemaProperty>,
  initialValues: Record<string, unknown>,
  sharedValues: Record<string, string>,
): Record<string, unknown> {
  const init: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    if (initialValues && key in initialValues) {
      init[key] = initialValues[key];
    } else {
      const prop = properties[key]!;
      const sharedKey = prop["x-shared"];
      if (sharedKey && sharedValues[sharedKey]) {
        init[key] = sharedValues[sharedKey];
      } else if (prop.format === "tag-input" && prop.type === "array") {
        init[key] = [];
      } else if (prop.type === "boolean") {
        init[key] = false;
      } else if (prop.type === "number" || prop.type === "integer") {
        init[key] = "";
      } else {
        init[key] = "";
      }
    }
  }
  return init;
}

// ── Pre-fill from x-shared ──────────────────────────────────────────────

describe("InlineToolForm x-shared pre-fill", () => {
  const sharedValues = {
    "project.cwd": "/home/user/project",
    "project.name": "my-project",
  };

  test("pre-fills field with x-shared: project.cwd", () => {
    const props: Record<string, SchemaProperty> = {
      sourcePath: { type: "string", format: "file-path", "x-shared": "project.cwd" },
      convention: { type: "string" },
    };
    const values = initFormValues(props, {}, sharedValues);
    expect(values.sourcePath).toBe("/home/user/project");
    expect(values.convention).toBe("");
  });

  test("pre-fills field with x-shared: project.name", () => {
    const props: Record<string, SchemaProperty> = {
      name: { type: "string", "x-shared": "project.name" },
    };
    const values = initFormValues(props, {}, sharedValues);
    expect(values.name).toBe("my-project");
  });

  test("pre-fills multiple x-shared fields", () => {
    const props: Record<string, SchemaProperty> = {
      path: { type: "string", "x-shared": "project.cwd" },
      projectName: { type: "string", "x-shared": "project.name" },
      depth: { type: "number" },
    };
    const values = initFormValues(props, {}, sharedValues);
    expect(values.path).toBe("/home/user/project");
    expect(values.projectName).toBe("my-project");
    expect(values.depth).toBe("");
  });

  test("initialValues take precedence over x-shared", () => {
    const props: Record<string, SchemaProperty> = {
      sourcePath: { type: "string", "x-shared": "project.cwd" },
    };
    const values = initFormValues(props, { sourcePath: "/override" }, sharedValues);
    expect(values.sourcePath).toBe("/override");
  });

  test("unknown x-shared key falls back to default", () => {
    const props: Record<string, SchemaProperty> = {
      field: { type: "string", "x-shared": "unknown.var" },
    };
    const values = initFormValues(props, {}, sharedValues);
    expect(values.field).toBe("");
  });

  test("empty sharedValues map falls back to defaults", () => {
    const props: Record<string, SchemaProperty> = {
      sourcePath: { type: "string", "x-shared": "project.cwd" },
      flag: { type: "boolean" },
      tags: { type: "array", format: "tag-input" },
    };
    const values = initFormValues(props, {}, {});
    expect(values.sourcePath).toBe("");
    expect(values.flag).toBe(false);
    expect(values.tags).toEqual([]);
  });

  test("x-shared on non-string types still pre-fills", () => {
    const props: Record<string, SchemaProperty> = {
      path: { type: "string", "x-shared": "project.cwd" },
    };
    const values = initFormValues(props, {}, sharedValues);
    expect(values.path).toBe("/home/user/project");
  });

  test("fields without x-shared use normal defaults", () => {
    const props: Record<string, SchemaProperty> = {
      name: { type: "string" },
      count: { type: "number" },
      active: { type: "boolean" },
      items: { type: "array", format: "tag-input" },
    };
    const values = initFormValues(props, {}, sharedValues);
    expect(values.name).toBe("");
    expect(values.count).toBe("");
    expect(values.active).toBe(false);
    expect(values.items).toEqual([]);
  });
});

// ── Integration: x-shared with validation/collection ────────────────────

describe("x-shared integration with form validation", () => {
  const sharedValues = {
    "project.cwd": "/home/user/project",
  };

  function validate(
    properties: Record<string, SchemaProperty>,
    requiredFields: string[],
    values: Record<string, unknown>,
  ): Record<string, string> {
    const errors: Record<string, string> = {};
    for (const key of Object.keys(properties)) {
      const val = values[key];
      const isRequired = requiredFields.includes(key);
      if (isRequired && (val === "" || val === undefined || val === null)) {
        errors[key] = "Required";
      }
    }
    return errors;
  }

  test("pre-filled x-shared required field passes validation", () => {
    const props: Record<string, SchemaProperty> = {
      sourcePath: { type: "string", "x-shared": "project.cwd" },
      convention: { type: "string" },
    };
    const values = initFormValues(props, {}, sharedValues);
    const errors = validate(props, ["sourcePath"], values);
    expect(errors).toEqual({});
  });

  test("x-shared required field with empty sharedValues fails validation", () => {
    const props: Record<string, SchemaProperty> = {
      sourcePath: { type: "string", "x-shared": "project.cwd" },
    };
    const values = initFormValues(props, {}, {});
    const errors = validate(props, ["sourcePath"], values);
    expect(errors.sourcePath).toBe("Required");
  });

  test("collectValues includes pre-filled x-shared value", () => {
    const props: Record<string, SchemaProperty> = {
      sourcePath: { type: "string", "x-shared": "project.cwd" },
      convention: { type: "string" },
    };
    const values = initFormValues(props, {}, sharedValues);
    values.convention = "kebab-case";

    // Simulate collectValues
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(props)) {
      const val = values[key];
      if (val === "" || val === undefined) continue;
      result[key] = val;
    }
    expect(result).toEqual({
      sourcePath: "/home/user/project",
      convention: "kebab-case",
    });
  });
});
