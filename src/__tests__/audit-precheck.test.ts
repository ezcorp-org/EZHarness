import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrecheck, asFullVerdict } from "../runtime/audit/precheck";
import type { FeatureWithFiles } from "../db/queries/features";

let projectRoot: string;

beforeAll(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "audit-precheck-"));
});

afterAll(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function writeFixture(rel: string, content: string): void {
  const abs = join(projectRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function feat(name: string, relpaths: string[]): FeatureWithFiles {
  return {
    id: `id-${name}`,
    projectId: "proj",
    name,
    description: "",
    source: "user",
    originPath: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    files: relpaths.map((relpath) => ({
      featureId: `id-${name}`,
      relpath,
      source: "scan" as const,
      addedAt: new Date(),
    })),
  };
}

describe("runPrecheck — path rules", () => {
  test("ezcorp.config.ts file flips both SDK and MCP to true via precheck (extension → meta-tool)", async () => {
    writeFixture("docs/extensions/examples/auto-note/ezcorp.config.ts", "// stub");
    const v = await runPrecheck(
      feat("auto-note", ["docs/extensions/examples/auto-note/ezcorp.config.ts"]),
      projectRoot,
    );
    expect(v.sdk?.exposed).toBe(true);
    expect(v.sdk?.via).toBe("precheck");
    // Extensions are reachable via the `extension_search` MCP meta-tool, so
    // precheck stamps MCP=true with evidence pointing at the meta-tool.
    expect(v.mcp?.exposed).toBe(true);
    expect(v.mcp?.via).toBe("precheck");
    expect(v.mcp?.evidence).toContain("extension_search");
  });

  test("file under packages/@ezcorp/sdk flips SDK only (SDK source is not an extension)", async () => {
    writeFixture("packages/@ezcorp/sdk/src/runtime/storage.ts", "// stub");
    const v = await runPrecheck(
      feat("sdk-storage", ["packages/@ezcorp/sdk/src/runtime/storage.ts"]),
      projectRoot,
    );
    expect(v.sdk?.exposed).toBe(true);
    // SDK-source files are NOT extensions, so MCP stays undecided here.
    expect(v.mcp).toBeUndefined();
  });

  test(".svelte file under web/src/lib/components/ez/ flips EzButton", async () => {
    writeFixture("web/src/lib/components/ez/EzButton.svelte", "<div />");
    const v = await runPrecheck(
      feat("ez-button", ["web/src/lib/components/ez/EzButton.svelte"]),
      projectRoot,
    );
    expect(v.ezbutton?.exposed).toBe(true);
  });

  test("file under packages/@ezcorp/ai-kit/src/mcp/ flips MCP via path rule (no grep needed)", async () => {
    writeFixture("packages/@ezcorp/ai-kit/src/mcp/server.ts", "// no server.tool here");
    const v = await runPrecheck(
      feat("mcp-server", ["packages/@ezcorp/ai-kit/src/mcp/server.ts"]),
      projectRoot,
    );
    expect(v.mcp?.exposed).toBe(true);
    expect(v.mcp?.via).toBe("precheck");
  });
});

describe("runPrecheck — content grep rules", () => {
  test("MCP-path file with server.tool( call flips MCP via grep", async () => {
    writeFixture("packages/foo/mcp/registrar.ts", "server.tool('x', 'desc', schema, handler);");
    const v = await runPrecheck(
      feat("mcp-registrar", ["packages/foo/mcp/registrar.ts"]),
      projectRoot,
    );
    expect(v.mcp?.exposed).toBe(true);
  });
});

describe("runPrecheck — empty / undecided", () => {
  test("feature with no surface signals leaves all surfaces undefined", async () => {
    writeFixture("src/util/random-helper.ts", "export function noop() {}");
    const v = await runPrecheck(
      feat("random-helper", ["src/util/random-helper.ts"]),
      projectRoot,
    );
    expect(v.sdk).toBeUndefined();
    expect(v.ezbutton).toBeUndefined();
    expect(v.mcp).toBeUndefined();
  });

  test("binary-extension files are skipped during grep", async () => {
    // .png is in BINARY_EXTENSIONS — even with grep markers "in" the file
    // (impossible but pretend) we should not open it. Use a non-existent
    // file; since the file doesn't exist it's also a no-op.
    const v = await runPrecheck(
      feat("only-image", ["assets/foo.png"]),
      projectRoot,
    );
    expect(v.ezbutton).toBeUndefined();
    expect(v.mcp).toBeUndefined();
  });
});

describe("asFullVerdict", () => {
  test("fills missing surfaces with exposed=false / via=precheck", () => {
    const full = asFullVerdict({
      sdk: { exposed: true, via: "precheck", evidence: "x" },
    });
    expect(full.sdk.exposed).toBe(true);
    expect(full.ezbutton.exposed).toBe(false);
    expect(full.ezbutton.via).toBe("precheck");
    expect(full.mcp.exposed).toBe(false);
  });

  test("preserves all fields when all three are provided", () => {
    const full = asFullVerdict({
      sdk: { exposed: true, via: "precheck" },
      ezbutton: { exposed: false, via: "llm", evidence: "no ui" },
      mcp: { exposed: true, via: "llm", evidence: "callable" },
    });
    expect(full.ezbutton.via).toBe("llm");
    expect(full.mcp.evidence).toBe("callable");
  });
});
