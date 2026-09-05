import { expect, test } from "bun:test";
import { createRuntimeExtension, type ExtensionContext } from "@ezcorp/sdk/v4";
import { JsonRpcError } from "@ezcorp/sdk/runtime";
import manifest from "./ezcorp.config";

test("spawn requests retain their options, errors and assignment event delivery", async () => {
  let implementation!: typeof import("./index");
  const extension = await createRuntimeExtension({ manifest, register: async () => {
    implementation = await import("./index");
    implementation.start();
  } });
  const handle = { subConversationId: "sub", agentRunId: "run", taskId: "task", assignmentId: "assignment" };
  const requests: unknown[] = [];
  let failure: Error | undefined;
  const context: ExtensionContext = { invocation: { invocationId: "spawn", workerId: "worker", releaseId: "release", principalId: "user", scopeId: "scope", token: "token", deadline: Date.now() + 10_000 }, signal: new AbortController().signal, call: async (method, input) => { expect(method).toBe("ezcorp/spawn-assignment"); requests.push(input); if (failure) throw failure; return { v: 1, ...handle }; } };
  expect(await implementation.tools.spawn_one!({ task: 1 })).toMatchObject({ content: [{ text: "spawn_one requires string 'task'" }], isError: true });
  expect(await extension.invoke("spawn_one", { task: "Do work", agentConfigId: "config", agentName: "Agent", title: "Title" }, context)).toMatchObject({ content: [{ text: JSON.stringify(handle) }], isError: false });
  expect(requests).toEqual([{ v: 1, task: "Do work", agentConfigId: "config", agentName: "Agent", title: "Title" }]);
  expect(await extension.invoke("spawn_one", { task: "Do work" }, context)).toMatchObject({ isError: true, content: [{ text: "spawnAssignment: one of 'agentConfigId' or 'agentName' is required" }] });
  failure = new JsonRpcError(-32001, "denied", { reason: "permission" });
  expect(await extension.invoke("spawn_one", { task: "Do work", agentName: "Agent" }, context)).toMatchObject({ isError: true, content: [{ text: JSON.stringify({ code: -32001, message: "denied", data: { reason: "permission" } }) }] });
  failure = new Error("offline");
  expect(await extension.invoke("spawn_one", { task: "Do work", agentName: "Agent" }, context)).toMatchObject({ isError: true, content: [{ text: "offline" }] });
  const update = { taskId: "task", assignmentId: "assignment", status: "completed" };
  await extension.dispatch("ezcorp/event/task:assignment_update", update, context);
  expect(await extension.invoke("drain_updates", {}, context)).toMatchObject({ content: [{ text: JSON.stringify([update]) }] });
  expect(await extension.invoke("drain_updates", {}, context)).toMatchObject({ content: [{ text: "[]" }] });
});
