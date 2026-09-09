import { expect, test } from "bun:test";
import { createRuntimeExtension, type ExtensionContext } from "@ezcorp/sdk/v4";
import manifest from "./ezcorp.config";

test("registered event delivery buffers payloads and drain clears exactly once", async () => {
  const extension = await createRuntimeExtension({ manifest, register: async () => {
    const implementation = await import("./index");
    implementation.start();
  } });
  const context: ExtensionContext = { invocation: { invocationId: "event", workerId: "worker", releaseId: "release", principalId: "user", scopeId: "scope", token: "token", deadline: Date.now() + 10_000 }, signal: new AbortController().signal, call: async () => { throw new Error("Unexpected host request"); } };
  const payload = { conversationId: "conversation", tasks: [{ id: "task" }] };
  await extension.dispatch("ezcorp/event/task:snapshot", payload, context);
  expect(await extension.invoke("drain_received", {}, context)).toMatchObject({ content: [{ text: JSON.stringify([payload]) }], isError: false });
  expect(await extension.invoke("drain_received", {}, context)).toMatchObject({ content: [{ text: "[]" }], isError: false });
});
