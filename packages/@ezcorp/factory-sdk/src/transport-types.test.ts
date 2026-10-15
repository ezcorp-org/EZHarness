import { describe, expect, test } from "bun:test";
import { factoryChildRunId, FACTORY_TRANSPORT_COMMAND_BYTES_LIMIT, MAX_TRANSPORT_ENVELOPE_BYTES } from "./transport-types";

describe("factory transport bounds", () => {
  test("reserves space for private claim and settlement wrappers", () => {
    expect(FACTORY_TRANSPORT_COMMAND_BYTES_LIMIT).toBe(64 * 1024);
    expect(MAX_TRANSPORT_ENVELOPE_BYTES).toBe(68 * 1024);
  });
  test("uses a canonical bounded child identity", () => {
    const command = { id: "command", nodeId: "child", candidateGeneration: 2 };
    expect(factoryChildRunId("parent", command)).toMatch(/^child-[a-f0-9]{64}$/);
    expect(factoryChildRunId("parent", command)).toBe(factoryChildRunId("parent", command));
    expect(factoryChildRunId("parent", command)).not.toBe(factoryChildRunId("other", command));
  });
});
