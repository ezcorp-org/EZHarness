/**
 * Tests for src/extensions/shared-variables.ts — the `x-shared` schema
 * annotation that auto-fills tool args with server-side resolved values
 * (e.g., project.cwd, project.name). Pure functions, no DB/filesystem.
 */
import { test, expect, describe } from "bun:test";
import { basename } from "node:path";
import {
  resolveSharedVariables,
  getSharedDefaults,
  SHARED_VARIABLE_RESOLVERS,
} from "../extensions/shared-variables";

const schemaWithCwd = {
  properties: {
    dir: { type: "string", "x-shared": "project.cwd" },
    label: { type: "string" },
  },
};

const schemaWithMultipleShared = {
  properties: {
    cwd: { type: "string", "x-shared": "project.cwd" },
    name: { type: "string", "x-shared": "project.name" },
  },
};

describe("SHARED_VARIABLE_RESOLVERS", () => {
  test("project.cwd returns current process cwd", () => {
    const r = SHARED_VARIABLE_RESOLVERS["project.cwd"];
    expect(r).toBeDefined();
    expect(r!()).toBe(process.cwd());
  });

  test("project.name returns basename of cwd", () => {
    const r = SHARED_VARIABLE_RESOLVERS["project.name"];
    expect(r).toBeDefined();
    expect(r!()).toBe(basename(process.cwd()));
  });

  test("only the two documented resolvers are registered", () => {
    // Prevents accidental additions slipping in un-audited.
    expect(Object.keys(SHARED_VARIABLE_RESOLVERS).sort()).toEqual([
      "project.cwd",
      "project.name",
    ]);
  });
});

describe("resolveSharedVariables", () => {
  test("fills missing arg from resolver", () => {
    const out = resolveSharedVariables(schemaWithCwd, { label: "x" });
    expect(out.dir).toBe(process.cwd());
    expect(out.label).toBe("x");
  });

  test("fills empty-string arg from resolver", () => {
    const out = resolveSharedVariables(schemaWithCwd, { dir: "", label: "x" });
    expect(out.dir).toBe(process.cwd());
  });

  test("fills null arg from resolver", () => {
    const out = resolveSharedVariables(schemaWithCwd, { dir: null, label: "x" });
    expect(out.dir).toBe(process.cwd());
  });

  test("does NOT overwrite explicit non-empty values", () => {
    const out = resolveSharedVariables(schemaWithCwd, { dir: "/custom" });
    expect(out.dir).toBe("/custom");
  });

  test("returns new object — does not mutate input args", () => {
    const input = { label: "x" };
    const out = resolveSharedVariables(schemaWithCwd, input);
    expect(out).not.toBe(input);
    expect(input).toEqual({ label: "x" }); // unchanged
    expect(out.dir).toBe(process.cwd());
  });

  test("properties without x-shared are left alone", () => {
    const out = resolveSharedVariables(schemaWithCwd, {});
    expect(out.dir).toBe(process.cwd()); // x-shared filled
    // `label` has no x-shared and no value — must remain absent.
    expect("label" in out).toBe(false);
  });

  test("schema without properties returns args reference unchanged", () => {
    const input = { dir: "", keep: "yes" };
    const out = resolveSharedVariables({}, input);
    // No properties means the function short-circuits and returns args as-is.
    expect(out).toEqual(input);
    expect(out).toBe(input);
  });

  test("unknown x-shared key is silently ignored (no resolver)", () => {
    const schema = {
      properties: { weird: { "x-shared": "not.a.real.resolver" } },
    };
    const out = resolveSharedVariables(schema, {});
    // No resolver, no fill — arg stays unset.
    expect("weird" in out).toBe(false);
  });

  test("multiple x-shared fields fill independently", () => {
    const out = resolveSharedVariables(schemaWithMultipleShared, {});
    expect(out.cwd).toBe(process.cwd());
    expect(out.name).toBe(basename(process.cwd()));
  });
});

describe("getSharedDefaults", () => {
  test("returns a map of x-shared fields to resolved values", () => {
    const defaults = getSharedDefaults(schemaWithMultipleShared);
    expect(defaults).toEqual({
      cwd: process.cwd(),
      name: basename(process.cwd()),
    });
  });

  test("fields without x-shared are excluded", () => {
    const defaults = getSharedDefaults(schemaWithCwd);
    expect(Object.keys(defaults)).toEqual(["dir"]);
  });

  test("schema without properties returns empty object", () => {
    expect(getSharedDefaults({})).toEqual({});
  });

  test("unknown x-shared keys are skipped", () => {
    const schema = {
      properties: {
        good: { "x-shared": "project.cwd" },
        bad: { "x-shared": "no.such.resolver" },
      },
    };
    const defaults = getSharedDefaults(schema);
    expect(defaults.good).toBe(process.cwd());
    expect("bad" in defaults).toBe(false);
  });
});
