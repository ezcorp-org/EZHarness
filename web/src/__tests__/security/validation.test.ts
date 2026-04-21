import { test, expect } from "bun:test";
import { validationError } from "../../lib/server/security/validation";
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
