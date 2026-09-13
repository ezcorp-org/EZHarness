import { describe, expect, test } from "bun:test";
import { FACTORY_TRANSPORT_COMMAND_BYTES_LIMIT, MAX_TRANSPORT_ENVELOPE_BYTES } from "./transport-types";

describe("factory transport bounds", () => {
  test("reserves space for private claim and settlement wrappers", () => {
    expect(FACTORY_TRANSPORT_COMMAND_BYTES_LIMIT).toBe(64 * 1024);
    expect(MAX_TRANSPORT_ENVELOPE_BYTES).toBe(68 * 1024);
  });
});
