import { afterEach, expect, test } from "bun:test";
import { createRuntimeExtension, createSession } from "./index";
import { getChannel, __resetChannelForTests } from "../runtime/channel";
import { createToolDispatcher } from "../runtime/rpc";

afterEach(__resetChannelForTests);

test("runtime vocabulary uses invocation-bound host calls without starting legacy transport", async () => {
  const results: any[] = [];
  let session: ReturnType<typeof createSession>;
  const extension = await createRuntimeExtension({
    manifest: { schemaVersion: 4, name: "runtime", version: "1.0.0", description: "Runtime", author: { name: "Test" }, permissions: { storage: true }, tools: [{ name: "read", description: "Read", inputSchema: { type: "object" } }] },
    register() {
      getChannel().start();
      createToolDispatcher({ read: async () => ({ content: [{ type: "text", text: await getChannel().request<string>("ezcorp/storage-get", { key: "greeting" }) }], isError: false }) });
      getChannel().onRequest("page/render", () => ({ title: "Page" }));
    },
  });
  await expect(getChannel().request("ezcorp/storage-get", {})).rejects.toThrow("active invocation");
  expect(extension.manifest.methods?.map(method => method.name)).toEqual(["page/render"]);
  session = createSession(extension, async frame => {
    const message = JSON.parse(frame);
    results.push(message);
    if (message.method) await session.receive({ jsonrpc: "2.0", id: message.id, result: "Hello" });
  });
  const context = { invocationId: "read", workerId: "worker", releaseId: "release", principalId: "alice", scopeId: "conversation", token: "token", deadline: Date.now() + 5000 };
  await session.receive({ jsonrpc: "2.0", id: "read", method: "extension/invoke", params: { name: "read", input: {}, context } });
  expect(results[0].params.context).toEqual(context);
  expect(results.at(-1).result.content[0].text).toBe("Hello");
  expect(() => getChannel().onRequest("new/method", () => null)).toThrow("registered before");
  session.close();
});
