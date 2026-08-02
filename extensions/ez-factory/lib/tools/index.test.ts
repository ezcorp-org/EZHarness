/**
 * The handler map, and the two things about it that are invisible in a
 * diff: that the manifest and the dispatcher agree on the tool set, and
 * that not one tool declares an `rbacScope`.
 */
import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@ezcorp/sdk";

import config from "../../ezcorp.config";
import { makeFakeFs } from "../../__tests__/fake-fs";
import {
  EMIT_ARTIFACT_TOOL,
  FACTORY_TOOL_NAMES,
  READ_FILES_TOOL,
  WRITE_FILE_TOOL,
  createFactoryToolHandlers,
} from "./index";

// Typed as the DECLARED manifest shape, not the config literal's inferred
// one. `defineExtension` returns `T` exactly, so `rbacScope` — optional and
// absent from every tool here — is not on the inferred type at all, and the
// absence assertion below would not compile against it.
const manifestTools: ToolDefinition[] = config.tools ?? [];

describe("the manifest and the dispatcher name the same tools", () => {
  test("FACTORY_TOOL_NAMES is exactly the manifest's tool list", () => {
    // Declaring a tool in one place and not the other does not fail at
    // install: the manifest advertises a tool the subprocess never
    // answers, and the call surfaces as an opaque dispatch error at run
    // time. This is the check that turns that into a red test.
    const declared: string[] = [...FACTORY_TOOL_NAMES];
    expect(declared).toEqual(manifestTools.map((t) => t.name));
  });

  test("the handler map serves exactly those names", () => {
    const { deps } = makeFakeFs({});
    expect(Object.keys(createFactoryToolHandlers(deps)).sort()).toEqual(
      [...FACTORY_TOOL_NAMES].sort(),
    );
  });

  test("the three tools are the ones designed, and run_command/http_fetch are CUT", () => {
    expect([...FACTORY_TOOL_NAMES]).toEqual([READ_FILES_TOOL, WRITE_FILE_TOOL, EMIT_ARTIFACT_TOOL]);
    expect(manifestTools.map((t) => t.name)).not.toContain("run_command");
    expect(manifestTools.map((t) => t.name)).not.toContain("http_fetch");
  });
});

describe("no tool declares an rbacScope", () => {
  test("every declared tool omits rbacScope", () => {
    // `ToolExecutor.executeToolCall` enforces a declared scope against a
    // project DERIVED FROM THE CONVERSATION, and a workflow tool step runs
    // under the synthetic key `workflow-run:<uuid>` — a conversation that
    // does not exist and has no project. A scope here would deny every
    // call made from the only place these tools are called from.
    //
    // Absence is the design, and absence is invisible in a diff.
    for (const tool of manifestTools) {
      expect(tool.rbacScope).toBeUndefined();
    }
    expect(manifestTools.length).toBe(3);
  });

  test("the console scopes still exist — they are for buttons, not tools", () => {
    const scopes = (config.permissions?.rbacScopes ?? []).map((s) => s.name);
    expect(scopes).toEqual(["manage-jobs", "run-job", "approve-gate"]);
  });
});

describe("outcome → wire result", () => {
  test("a successful call becomes a non-error text result", async () => {
    const { deps } = makeFakeFs({ "/proj/a.md": "hi" });
    const handler = createFactoryToolHandlers(deps)[READ_FILES_TOOL];
    const result = await handler?.({ globs: ["**/*.md"] });

    expect(result?.isError).toBe(false);
    expect(result?.content).toHaveLength(1);
    expect(result?.content[0]?.type).toBe("text");
    const payload = JSON.parse(result?.content[0]?.text ?? "{}") as { files: unknown[] };
    expect(payload.files).toHaveLength(1);
  });

  test("a rejected call becomes an error result carrying the code", async () => {
    const { deps } = makeFakeFs({});
    const handler = createFactoryToolHandlers(deps)[EMIT_ARTIFACT_TOOL];
    const result = await handler?.({ runId: "r1", name: "../escape", content: "x" });

    expect(result?.isError).toBe(true);
    expect((result as unknown as { code?: string })?.code).toBe("invalid-name");
  });
});
