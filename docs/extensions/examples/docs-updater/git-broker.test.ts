import { expect, test } from "bun:test";
import { createRuntimeExtension } from "@ezcorp/sdk/v4";
import { createToolDispatcher } from "@ezcorp/sdk/runtime";

test("v4 git inspection sends only closed operations and a commit hash", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const sinceHash = "a".repeat(40);
  const extension = await createRuntimeExtension({
    manifest: { schemaVersion: 4, name: "git-broker-test", version: "1.0.0", description: "Git broker test", author: { name: "Test" }, permissions: { shell: true }, tools: [{ name: "inspect", description: "Inspect git", inputSchema: { type: "object" } }] },
    register: async () => {
      const { readGitHead, readCommitSubjects, readOriginUrl } = await import("./index");
      createToolDispatcher({ inspect: async () => ({ content: [{ type: "text", text: JSON.stringify([await readGitHead("/untrusted"), await readCommitSubjects("/untrusted", sinceHash), await readOriginUrl("/untrusted")]) }] }) });
    },
  });
  const head = { hash: "b".repeat(40), subject: "Current" };
  const result = await extension.invoke("inspect", {}, {
    invocation: { invocationId: "inspect", workerId: "worker", releaseId: "release", principalId: "user", scopeId: "project", token: "test", deadline: Date.now() + 5000 },
    signal: new AbortController().signal,
    call: async (method, input) => { calls.push({ method, input }); return method.endsWith("gitHead") ? head : method.endsWith("commitSubjects") ? ["Current"] : "https://github.com/owner/project.git"; },
  });
  expect(result).toMatchObject({ content: [{ text: JSON.stringify([head, ["Current"], "https://github.com/owner/project.git"]) }] });
  expect(calls).toEqual([{ method: "ezcorp/project.gitHead", input: {} }, { method: "ezcorp/project.commitSubjects", input: { sinceHash } }, { method: "ezcorp/project.origin", input: {} }]);
});
