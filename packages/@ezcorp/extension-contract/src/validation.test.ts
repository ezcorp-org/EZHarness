import { describe, expect, test } from "bun:test";
import { assertJson, canonicalJson, compileValueSchema, parseJson, sha256, sealPublishedRelease, validatePublishedRelease, validateInvocationContext, validateManifest, validateResourceLimits, validateWire, validateWorkspaceFiles, validateWorkspacePath, validateArtifactFiles } from "./index";

const manifest = { schemaVersion: 4, name: "echo", version: "1.0.0", description: "Echo", author: { name: "Test" }, permissions: {}, tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, outputSchema: { type: "string" } }] };

describe("data contracts", () => {
  test("compiled schemas reuse exact content without retaining mutable source or byte limits", () => {
    const source = { type: "object", const: { value: "original" }, description: "detached cache probe" };
    const original = compileValueSchema(source);
    expect(compileValueSchema(structuredClone(source))).toBe(original);
    expect(compileValueSchema({ description: source.description, const: { value: "original" }, type: "object" })).toBe(original);
    source.const.value = "changed";
    expect(() => original({ value: "original" })).not.toThrow();
    expect(() => original({ value: "changed" })).toThrow();
    const changed = compileValueSchema(source);
    expect(changed).not.toBe(original);
    expect(() => changed({ value: "changed" })).not.toThrow();
    const bounded = compileValueSchema({ type: "string" }, 4);
    const wider = compileValueSchema({ type: "string" }, 8);
    expect(bounded).not.toBe(wider);
    expect(() => bounded("12345")).toThrow();
    expect(() => wider("12345")).not.toThrow();
  });

  test("compiled schema cache stays bounded and invalid schemas never gain admission", () => {
    const firstSchema = { const: "cache eviction oldest" };
    const first = compileValueSchema(firstSchema);
    const recentSchema = { const: "cache eviction recent" };
    const recent = compileValueSchema(recentSchema);
    for (let index = 0; index < 64; index++) {
      compileValueSchema({ const: `cache eviction ${index}` });
      expect(compileValueSchema(recentSchema)).toBe(recent);
    }
    expect(compileValueSchema(firstSchema)).not.toBe(first);
    for (let index = 0; index < 2; index++) expect(() => compileValueSchema({ $ref: "https://attacker.invalid/schema" })).toThrow();
  });
  test("artifact maps admit sealed dependencies while preserving path and count limits", () => {
    const files = { ".runner/dependencies.json": "x".repeat(21 * 1024 * 1024) };
    expect(validateArtifactFiles(files)).toBe(files);
    expect(() => validateWorkspaceFiles(files)).toThrow();
    expect(() => validateArtifactFiles({ "node_modules/evil": "x" })).toThrow();
    expect(() => validateArtifactFiles(Object.fromEntries(Array.from({ length: 2006 }, (_, index) => [`file${index}`, ""])))).not.toThrow();
    expect(() => validateArtifactFiles(Object.fromEntries(Array.from({ length: 2007 }, (_, index) => [`file${index}`, ""])))).toThrow();
  });
  test("published releases bind source, catalog, checksums and runner artifacts", async () => {
    const sourceFiles = { "extension.ts": "source" };
    const artifacts = { ...sourceFiles, ".runner/extension.js": "compiled" };
    const build = { operationId: "build", state: "succeeded" as const, sourceDigest: await sha256(canonicalJson(sourceFiles)), artifactDigest: await sha256(canonicalJson(artifacts)), imageDigest: "image", manifest: validateManifest(manifest), diagnostics: [], evidence: { protocolVersion: 4 as const, validatorVersion: "v4", tests: [{ name: "fixture", passed: true }], discoveryDigest: await sha256(canonicalJson(manifest)) } };
    const release = await sealPublishedRelease(build, artifacts);
    expect(await validatePublishedRelease(release)).toEqual(release);
    expect(release.sourceFiles).toEqual(sourceFiles);
    expect(release.packageChecksums["extension.ts"]).toBe(await sha256("source"));
    await expect(sealPublishedRelease(build, { ...artifacts, "extension.ts": "tampered" })).rejects.toThrow("artifact digest");
    for (const change of [
      (value: typeof release) => { value.build.state = "failed"; },
      (value: typeof release) => { value.build.evidence.tests = []; },
      (value: typeof release) => { value.build.evidence.tests[0]!.passed = false; },
      (value: typeof release) => { value.sourceFiles[".runner/private"] = "forged"; },
      (value: typeof release) => { value.sourceFiles["extension.ts"] = "tampered"; },
      (value: typeof release) => { value.packageChecksums["extension.ts"] = "tampered"; },
      (value: typeof release) => { value.releaseDigest = "tampered"; },
    ]) {
      const changed = structuredClone(release);
      change(changed);
      await expect(validatePublishedRelease(changed)).rejects.toThrow();
    }
  });
  test("validates every contribution shape with unknown fields denied", () => {
    expect(validateManifest(manifest).name).toBe("echo");
    for (const addition of [{ unknown: true }, { schemaVersion: 3 }, { permissions: { network: true } }, { pages: [{ id: "page", title: 7 }] }, { tools: [{ ...manifest.tools[0], outputSchema: undefined }] }]) expect(() => validateManifest({ ...manifest, ...addition })).toThrow();
    expect(() => validateManifest({ ...manifest, tools: [manifest.tools[0], manifest.tools[0]] })).toThrow("duplicate");
    expect(() => validateManifest({ ...manifest, preprocessors: [{ tool: "missing", accepts: ["text/plain"] }] })).toThrow();
    expect(() => validateManifest({ ...manifest, messageToolbar: [{ id: "bad", icon: "test", tooltip: "x", event: "other:write" }] })).toThrow();
    expect(validateManifest({ ...manifest, skills: [{ name: "help", description: "Help", files: ["SKILL.md"] }], pages: [{ id: "view", title: "View" }], entities: [{ type: "note", label: "Note", pluralLabel: "Notes", schema: { type: "object", properties: { body: { type: "string" } } } }], permissions: { llm: { providers: ["openai"], maxCallsPerHour: 3 }, workflows: { names: ["review"] }, schedule: { crons: ["*/5 * * * *"] } } }).entities).toHaveLength(1);
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

  test("workspace paths cannot escape or shadow directories", () => {
    for (const path of ["../file", "/file", "a/../../file", "a\\b", "C:foo", "a\0b", "a//b", "node_modules/foo", ".git/config", "a/constructor"]) expect(() => validateWorkspacePath(path)).toThrow();
    expect(validateWorkspaceFiles({ "src/main.ts": "export {}", "assets/icon.svg": "<svg/>" })["src/main.ts"]).toBe("export {}");
    expect(() => validateWorkspaceFiles({ src: "file", "src/main.ts": "code" })).toThrow();
    expect(() => validateWorkspaceFiles({ "large.ts": "x".repeat(20 * 1024 * 1024 + 1) })).toThrow();
    expect(validateWorkspaceFiles({})).toEqual({});
  });

  test("schemas validate input and reject unsafe or unbounded evaluation", () => {
    const validate = compileValueSchema(manifest.tools[0]!.inputSchema);
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

  test("canonical digests ignore key order but bind every value", async () => {
    expect(canonicalJson({ second: 2, first: 1 })).toBe(canonicalJson({ first: 1, second: 2 }));
    expect(await sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256(canonicalJson({ allowed: true }))).not.toBe(await sha256(canonicalJson({ allowed: false })));
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
    expect(validateManifest({ ...manifest, methods: [method], dataSchema: { version: "2", readableVersions: ["1", "2"], migrateMethod: "data/migrate" }, permissions: { hostApi: { routes: [{ method: "GET", path: "/api/projects/:id" }], events: false }, custom: { githubProjects: { actions: ["tickets"] } } } }).dataSchema?.version).toBe("2");
    expect(() => validateManifest({ ...manifest, dataSchema: { version: "2", readableVersions: ["1"] } })).toThrow();
    expect(() => validateManifest({ ...manifest, dataSchema: { version: "2", readableVersions: ["2"], migrateMethod: "missing" } })).toThrow();
    expect(() => validateManifest({ ...manifest, permissions: { hostApi: { routes: [{ method: "GET", path: "/api/*" }], events: false } } })).toThrow();
  });
});
