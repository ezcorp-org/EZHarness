import { expect, spyOn, test } from "bun:test";
import { getChannel } from "@ezcorp/sdk/runtime";
import { tools, start } from "./index";

test("task snapshots validate their id and forward explicit payloads", async () => {
  const request = spyOn(getChannel(), "request").mockResolvedValue({ ok: true });
  try {
    expect(await tools.emit_snapshot!({ taskId: 1 })).toMatchObject({ isError: true });
    expect(request).not.toHaveBeenCalled();
    for (const input of [{ taskId: "task" }, { taskId: "task", conversationId: "forged" }]) {
      expect(await tools.emit_snapshot!(input)).toMatchObject({ content: [{ text: "emitted snapshot for task task" }], isError: false });
    }
    expect(request).toHaveBeenNthCalledWith(1, "ezcorp/emit-task-event", { v: 1, type: "snapshot", payload: { activeTaskId: "task", tasks: [{ id: "task", title: "integration test task", description: "", status: "pending", assignments: [], subtasks: [], priority: 1, createdAt: expect.any(String) }] } });
    expect(request.mock.calls[1]?.[1]).toMatchObject({ conversationId: "forged" });
  } finally { request.mockRestore(); }
});
test("task event start registers its real dispatcher", () => {
  const channel = getChannel();
  const run = spyOn(channel, "start").mockImplementation(() => {});
  const register = spyOn(channel, "onRequest");
  try { start(); expect(run).toHaveBeenCalledTimes(1); expect(register).toHaveBeenCalledWith("tools/call", expect.any(Function)); }
  finally { run.mockRestore(); register.mockRestore(); }
});
