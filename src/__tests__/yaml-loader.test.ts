import { test, expect, describe, afterAll } from "bun:test";
import { loadYamlAgents } from "../runtime/yaml-loader";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "pi-yaml-test-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadYamlAgents", () => {
  test("loads valid YAML agent", async () => {
    writeFileSync(
      join(dir, "reviewer.agent.yaml"),
      `name: reviewer
description: Reviews code
capabilities:
  - llm
prompt: You are a code reviewer.
outputFormat: text
`,
    );

    const agents = await loadYamlAgents(dir);

    expect(agents.size).toBe(1);
    expect(agents.has("reviewer")).toBe(true);

    const agent = agents.get("reviewer")!;
    expect(agent.name).toBe("reviewer");
    expect(agent.description).toBe("Reviews code");
    expect(agent.capabilities).toEqual(["llm"]);
    expect(typeof agent.execute).toBe("function");
  });

  test("skips YAML without name or prompt", async () => {
    writeFileSync(
      join(dir, "bad.agent.yaml"),
      `description: Missing name and prompt\ncapabilities:\n  - llm\n`,
    );

    const agents = await loadYamlAgents(dir);

    // Should still have the reviewer from previous test, but not 'bad'
    expect(agents.has("bad")).toBe(false);
  });

  test("defaults capabilities and description", async () => {
    writeFileSync(
      join(dir, "minimal.agent.yaml"),
      `name: minimal\nprompt: Do something.\n`,
    );

    const agents = await loadYamlAgents(dir);

    const agent = agents.get("minimal")!;
    expect(agent.capabilities).toEqual(["llm"]);
    expect(agent.description).toBe("");
  });

  test("returns empty map for directory with no YAML agents", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "pi-yaml-empty-"));
    try {
      const agents = await loadYamlAgents(emptyDir);
      expect(agents.size).toBe(0);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
