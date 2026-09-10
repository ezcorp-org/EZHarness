import { controlActor, controlFixture, } from "./helpers/extension-control-fixture";
import { createExtensionFiles, extensionControlTools } from "../extensions/extension-control";
import { scaffoldWorkspace } from "@ezcorp/sdk/scaffold";
import { assertJson, compileValueSchema, parseJson, validateInvocationContext, validateManifest, validateResourceLimits, validateWire } from "@ezcorp/extension-contract";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadManifest, loadManifestFresh } from "../extensions/loader";


const contractManifest = { schemaVersion: 4, name: "echo", version: "1.0.0", description: "Echo", author: { name: "Test" }, permissions: {}, tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, outputSchema: { type: "string" } }] };

async function assertHostSdkRefusal(config: string | undefined): Promise<boolean> {
  const directory = await mkdtemp(join(tmpdir(), "sdk-host-load-"));
  const marker = join(directory, "executed");
  try {
    await Bun.write(join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 2, name: "legacy-json" }));
    if (config) await Bun.write(join(directory, "ezcorp.config.ts"), `await Bun.write(${JSON.stringify(marker)}, "executed"); ${config}`);
    await expect(loadManifest(directory)).rejects.toMatchObject({ code: "EXTENSION_V4_REQUIRED" });
    await expect(loadManifestFresh(directory)).rejects.toMatchObject({ code: "EXTENSION_V4_REQUIRED" });
    expect(await Bun.file(marker).exists()).toBe(false);
    return false;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("SDK host consumer refuses a missing local configuration", async () => { expect(await assertHostSdkRefusal(undefined)).toBe(false); });

  test("describes one SDK contract with nested tested source and no approval tool", async () => {
    const { control } = controlFixture();
    expect(await control.execute(controlActor, "extensions_describe", {})).toMatchObject({ schemaVersion: 4, sdk: "@ezcorp/sdk/v4", runtime: { helpers: "@ezcorp/sdk" }, browser: { sdk: "@ezcorp/sdk/browser", config: "ezcorp.browser.json", configFields: ["schemaVersion", "entrypoint", "html", "styles", "tools"], preview: "/extensions/<name>/preview?conversationId=<owned-id>" } });
    const files = createExtensionFiles("safe-name", "test");
    expect(files).toEqual(scaffoldWorkspace({ name: "safe-name", description: "test" }).files);
    expect(files["extension.ts"]).toContain("defineExtension");
    expect(files["src/echo.test.ts"]).toContain("expect");
    expect(() => createExtensionFiles("../escape")).toThrow("lowercase");
    expect(extensionControlTools.map((tool) => tool.name)).not.toContain("extensions_approve");
  });

  test("validates every contribution shape with unknown fields denied", () => {
    expect(validateManifest(contractManifest).name).toBe("echo");
    for (const addition of [{ unknown: true }, { schemaVersion: 3 }, { permissions: { network: true } }, { pages: [{ id: "page", title: 7 }] }, { tools: [{ ...contractManifest.tools[0], outputSchema: undefined }] }]) expect(() => validateManifest({ ...contractManifest, ...addition })).toThrow();
    expect(() => validateManifest({ ...contractManifest, tools: [contractManifest.tools[0], contractManifest.tools[0]] })).toThrow("duplicate");
    expect(() => validateManifest({ ...contractManifest, preprocessors: [{ tool: "missing", accepts: ["text/plain"] }] })).toThrow();
    expect(() => validateManifest({ ...contractManifest, messageToolbar: [{ id: "bad", icon: "test", tooltip: "x", event: "other:write" }] })).toThrow();
    expect(validateManifest({ ...contractManifest, skills: [{ name: "help", description: "Help", files: ["SKILL.md"] }], pages: [{ id: "view", title: "View" }], entities: [{ type: "note", label: "Note", pluralLabel: "Notes", schema: { type: "object", properties: { body: { type: "string" } } } }], permissions: { llm: { providers: ["openai"], maxCallsPerHour: 3 }, workflows: { names: ["review"] }, schedule: { crons: ["*/5 * * * *"] } } }).entities).toHaveLength(1);
  });

  test("rejects executable data without running accessors", () => {
    let accessed = false;
    const accessor = Object.defineProperty({}, "secret", { enumerable: true, get() { accessed = true; return "leak"; } });
    for (const invalid of [accessor, new Date(), { value: undefined }, { value: () => 1 }, { value: Infinity }, JSON.parse('{"__proto__":{"evil":true}}'), new Array(2)]) expect(() => assertJson(invalid)).toThrow();
    expect(accessed).toBe(false);
    const cycle: unknown[] = []; cycle.push(cycle);
    expect(() => assertJson(cycle)).toThrow();
    expect(() => parseJson('"éé"', 4)).toThrow();
    expect(() => parseJson("{bad}")).toThrow();
  });

  test("schemas validate input and reject unsafe or unbounded evaluation", () => {
    const validate = compileValueSchema(contractManifest.tools[0]!.inputSchema);
    expect(() => validate({ text: "hello" })).not.toThrow();
    for (const input of [{}, { text: 5 }, { text: "ok", secret: "extra" }]) expect(() => validate(input)).toThrow();
    const local = compileValueSchema({ type: "object", properties: { text: { $ref: "#/$defs/text" } }, $defs: { text: { type: "string", pattern: "^[a-z]+$" } } });
    expect(() => local({ text: "hello" })).not.toThrow();
    expect(() => local({ text: "123" })).toThrow();
    expect(() => compileValueSchema({ $ref: "https://attacker/schema" })).toThrow();
    expect(() => compileValueSchema({ $ref: "#/$defs/self", $defs: { self: { $ref: "#/$defs/self" } } })).toThrow();
    expect(() => compileValueSchema({ type: "string", pattern: "(a)\\1" })).toThrow();
    expect(() => compileValueSchema({ type: "string", invalid: true })).toThrow();
    const regex = compileValueSchema({ type: "string", pattern: "(a+)+$" });
    const before = Date.now();
    expect(() => regex(`${"a".repeat(20_000)}!`)).toThrow();
    expect(Date.now() - before).toBeLessThan(2000);
  });

  test("resource and identity inputs fail closed", () => {
    const limits = { memoryBytes: 128000000, cpuMillis: 500, pids: 32, tmpBytes: 1000, outputBytes: 1000, timeoutMs: 1000 };
    expect(validateResourceLimits(limits)).toEqual(limits);
    expect(() => validateResourceLimits({ ...limits, pids: -1 })).toThrow();
    expect(() => validateResourceLimits({ ...limits, flags: ["--privileged"] })).toThrow();
    expect(() => validateInvocationContext({ invocationId: "x", workerId: "w", releaseId: "r", principalId: "", scopeId: "s", token: "t", deadline: 1 })).toThrow();
    expect(() => validateWire("buildResult", { state: "succeeded" })).toThrow();
  });

  test("formats and presentation hints keep validation separate from UI annotations", () => {
    for (const [format, valid, invalid] of [["date", "2024-02-29", "2024-02-31"], ["date-time", "2024-02-29T12:00:00Z", "yesterday"], ["uri", "https://example.com", "not a uri"], ["email", "person@example.com", "not an email"], ["uuid", "12345678-1234-1234-1234-123456789abc", "123"]]) {
      const check = compileValueSchema({ type: "string", format });
      expect(() => check(valid)).not.toThrow();
      expect(() => check(invalid)).toThrow();
    }
    expect(() => compileValueSchema({ type: "string", format: "combo-box", "x-options": { options: ["one"] }, "x-shared": "project.cwd" })("one")).not.toThrow();
    expect(() => compileValueSchema({ type: "string", format: "unknown" })).toThrow();
    expect(() => compileValueSchema({ type: "string", "x-shared": true })).toThrow();
    expect(() => compileValueSchema({ type: "string", "x-options": true })).toThrow();
  });

  test("data schema changes require declared migration methods and safe compatibility versions", () => {
    const method = { name: "data/migrate", inputSchema: { type: "object" }, outputSchema: { type: "object" } };
    expect(validateManifest({ ...contractManifest, methods: [method], dataSchema: { version: "2", readableVersions: ["1", "2"], migrateMethod: "data/migrate" }, permissions: { hostApi: { routes: [{ method: "GET", path: "/api/projects/:id" }], events: false }, custom: { githubProjects: { actions: ["tickets"] } } } }).dataSchema?.version).toBe("2");
    expect(() => validateManifest({ ...contractManifest, dataSchema: { version: "2", readableVersions: ["1"] } })).toThrow();
    expect(() => validateManifest({ ...contractManifest, dataSchema: { version: "2", readableVersions: ["2"], migrateMethod: "missing" } })).toThrow();
    expect(() => validateManifest({ ...contractManifest, permissions: { hostApi: { routes: [{ method: "GET", path: "/api/*" }], events: false } } })).toThrow();
  });
