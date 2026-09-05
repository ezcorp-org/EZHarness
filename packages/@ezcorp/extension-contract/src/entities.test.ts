import { expect, test } from "bun:test";
import { EntityValidationError } from "./entities";

test("entity validation errors preserve their diagnostic type and issues", () => {
  const issues: ConstructorParameters<typeof EntityValidationError>[1] = [];
  const error = new EntityValidationError("Record validation failed", issues);
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("EntityValidationError");
  expect(error.message).toBe("Record validation failed");
  expect(error.issues).toBe(issues);
});
