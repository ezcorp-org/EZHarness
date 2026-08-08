import { test, expect, describe } from "bun:test";
import { projectPathSchema, validationError } from "../../lib/server/security/validation";
import * as z from "zod";

test("converts ZodError into structured field error response", async () => {
  const schema = z.object({ name: z.string(), age: z.number() });
  let error: z.ZodError;
  try {
    schema.parse({ name: 123, age: "x" });
  } catch (e) {
    error = e as z.ZodError;
  }

  const response = validationError(error!);
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.error).toBe("Validation failed");
  expect(body.fields.name).toBeDefined();
  expect(body.fields.age).toBeDefined();
});

test("handles nested paths joined with dot", async () => {
  const schema = z.object({ address: z.object({ city: z.string() }) });
  let error: z.ZodError;
  try {
    schema.parse({ address: { city: 42 } });
  } catch (e) {
    error = e as z.ZodError;
  }

  const response = validationError(error!);
  const body = await response.json();
  expect(body.fields["address.city"]).toBeDefined();
});

/**
 * `projects.path` is an absolute CONTAINER path handed straight to
 * `resolve()` and to the `shell` tool's `cwd`. The routes used to take
 * `z.string()` and check only emptiness; these are the two shapes that got
 * through that gap on a real instance, and neither failed at the time.
 *
 * The messages are asserted, not just the rejection: a working directory is
 * typed by hand, so what it says when you get it wrong IS the feature.
 */
describe("projectPathSchema", () => {
  /**
   * The message a caller would actually surface for `path` — the same
   * `issues[0]` expression both routes answer with, so a wording change that
   * broke the UI would break this too.
   */
  function reject(path: string): string {
    const parsed = projectPathSchema.safeParse(path);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("unreachable — asserted above");
    return parsed.error.issues[0]?.message ?? "Invalid project path";
  }

  function accept(path: string): void {
    expect(projectPathSchema.safeParse(path).success).toBe(true);
  }

  test("a relative path is rejected as not absolute", () => {
    // Real row: `app/ezAppTest`. resolve() rooted it at the server cwd, so it
    // pointed at /app/web/app/ezAppTest — which never existed.
    expect(reject("app/ezAppTest")).toContain("absolute");
  });

  test("a typed tilde path is rejected as not absolute", () => {
    expect(reject("~/projects/herdr")).toContain("absolute");
  });

  test("a RESOLVED tilde path is rejected for the tilde itself", () => {
    // `/app/web/~/projects/<name>` is the form that reached disk: absolute,
    // so only the tilde-segment rule catches it. 270 MB went here.
    const message = reject("/app/web/~/projects/herdr");
    expect(message).toContain("~");
    expect(message).toContain("not expanded");
  });

  test("a .. segment is rejected", () => {
    expect(reject("/app/web/../../etc")).toContain("..");
  });

  test("an empty path is rejected as required", () => {
    expect(reject("")).toContain("required");
  });

  test("the projects bind and a project under it are accepted", () => {
    accept("/app/web/.ezcorp/projects");
    accept("/app/web/.ezcorp/projects/ezmind");
  });

  test("the seeded roots outside the bind keep working", () => {
    // `global` is `/` and `self` is `/repo`. The rule is SHAPE, not location:
    // requiring paths under the bind would break both.
    accept("/");
    accept("/repo");
    accept("/app");
  });

  test("a tilde or dots INSIDE a segment are legal directory names", () => {
    // Rejecting every string containing "~" or ".." would be stricter than
    // the failures justify, which is why both guards split on "/" first.
    accept("/app/web/.ezcorp/projects/my~project");
    accept("/app/web/.ezcorp/projects/v1..2");
  });

  test("only the FIRST issue is surfaced, and it is the specific one", () => {
    // Both routes answer `issues[0]?.message`. A path can trip more than one
    // rule at a time, so pin which message a user actually sees rather than
    // leaving it to zod's issue ordering by accident.
    const parsed = projectPathSchema.safeParse("~/../x");
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("unreachable — asserted above");
    expect(parsed.error.issues[0]?.message).toContain("absolute");
  });
});
