import { afterEach, beforeEach, spyOn } from "bun:test";
import * as toolCalls from "../../db/queries/tool-calls";

export function mockToolEventPersistence(): Parameters<typeof toolCalls.persistToolCall>[] {
  const records: Parameters<typeof toolCalls.persistToolCall>[] = [];
  let restore: (() => void) | undefined;
  beforeEach(() => {
    records.length = 0;
    const spy = spyOn(toolCalls, "persistToolCall").mockImplementation(async (row, event) => {
      if (event && (event.conversationId !== row.conversationId || !event.id)) throw new Error("Invalid host tool event binding in unit fixture");
      records.push([row, event]);
    });
    restore = () => spy.mockRestore();
  });
  afterEach(() => restore?.());
  return records;
}
