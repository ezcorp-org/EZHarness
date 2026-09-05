import { expect, test } from "bun:test";
import { createRuntimeExtension } from "@ezcorp/sdk/v4";
import { createToolDispatcher } from "@ezcorp/sdk/runtime";

test("v4 git reads use the host-selected project, never a caller host path", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const extension = await createRuntimeExtension({
    manifest: { schemaVersion: 4, name: "git-broker-test", version: "1.0.0", description: "Git broker test", author: { name: "Test" }, permissions: { shell: true }, tools: [{ name: "read", description: "Read git head", inputSchema: { type: "object" } }] },
    register: async () => {
      const { readGitHead } = await import("./index");
      createToolDispatcher({ read: async () => ({ content: [{ type: "text", text: JSON.stringify(await readGitHead("/untrusted/caller/path")) }] }) });
    },
  });
  const head = { hash: "a".repeat(40), subject: "Approved project" };
  const result = await extension.invoke("read", {}, {
    invocation: { invocationId: "read", workerId: "worker", releaseId: "release", principalId: "user", scopeId: "project", token: "test", deadline: Date.now() + 5000 },
    signal: new AbortController().signal,
    call: async (method, input) => { calls.push({ method, input }); return head; },
  });
  expect(result).toMatchObject({ content: [{ text: JSON.stringify(head) }] });
  expect(calls).toEqual([{ method: "ezcorp/project.gitHead", input: {} }]);
});
