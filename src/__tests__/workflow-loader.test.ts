import { describe, test, expect, afterAll } from "bun:test";
import { loadYamlWorkflows } from "../runtime/workflow-loader";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Create a temp directory for all tests, cleaned up afterwards
const dir = mkdtempSync(join(tmpdir(), "workflow-loader-test-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────

function writeYaml(filename: string, content: string) {
  writeFileSync(join(dir, filename), content, "utf8");
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("loadYamlWorkflows", () => {
  test("returns empty array for empty directory", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "workflow-empty-"));
    try {
      const workflows = await loadYamlWorkflows(emptyDir);
      expect(workflows).toEqual([]);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test("loads a valid *.workflow.yaml file", async () => {
    writeYaml(
      "review.workflow.yaml",
      `name: review
description: Code review workflow
steps:
  - name: analyze
    agent: code-analyzer
  - name: report
    agent: report-writer
    dependsOn:
      - analyze
`,
    );

    const workflows = await loadYamlWorkflows(dir);

    const review = workflows.find((p) => p.name === "review");
    expect(review).toBeDefined();
    expect(review!.name).toBe("review");
    expect(review!.description).toBe("Code review workflow");
    expect(review!.steps).toHaveLength(2);
    expect(review!.steps[0]!.name).toBe("analyze");
    expect(review!.steps[0]!.agent).toBe("code-analyzer");
    expect(review!.steps[1]!.name).toBe("report");
    expect(review!.steps[1]!.dependsOn).toEqual(["analyze"]);
  });

  test("loads a legacy *.pipeline.yaml file (deprecated glob still supported)", async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "workflow-legacy-"));
    try {
      writeFileSync(
        join(legacyDir, "old.pipeline.yaml"),
        `name: legacy\nsteps:\n  - name: s\n    agent: a\n`,
        "utf8",
      );
      const workflows = await loadYamlWorkflows(legacyDir);
      expect(workflows.find((w) => w.name === "legacy")).toBeDefined();
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  test("defaults description to empty string when omitted", async () => {
    writeYaml(
      "no-desc.workflow.yaml",
      `name: nodesc
steps:
  - name: step1
    agent: some-agent
`,
    );

    const workflows = await loadYamlWorkflows(dir);

    const p = workflows.find((p) => p.name === "nodesc");
    expect(p).toBeDefined();
    expect(p!.description).toBe("");
  });

  test("skips workflow missing required name field", async () => {
    writeYaml(
      "no-name.workflow.yaml",
      `description: Missing name
steps:
  - name: step1
    agent: some-agent
`,
    );

    const workflows = await loadYamlWorkflows(dir);

    const bad = workflows.find((p) => p.description === "Missing name");
    expect(bad).toBeUndefined();
  });

  test("skips workflow with no steps array", async () => {
    writeYaml(
      "no-steps.workflow.yaml",
      `name: nosteps
description: Has no steps field
`,
    );

    const workflows = await loadYamlWorkflows(dir);

    const bad = workflows.find((p) => p.name === "nosteps");
    expect(bad).toBeUndefined();
  });

  test("skips workflow with empty steps array", async () => {
    writeYaml(
      "empty-steps.workflow.yaml",
      `name: emptysteps
description: Steps array is empty
steps: []
`,
    );

    const workflows = await loadYamlWorkflows(dir);

    const bad = workflows.find((p) => p.name === "emptysteps");
    expect(bad).toBeUndefined();
  });

  test("skips a workflow that fails definition-time validation (transform without output)", async () => {
    writeYaml(
      "bad-transform.workflow.yaml",
      `name: badtransform
steps:
  - name: shape
    kind: transform
`,
    );

    const workflows = await loadYamlWorkflows(dir);
    expect(workflows.find((p) => p.name === "badtransform")).toBeUndefined();
  });

  test("skips workflow where steps is not an array", async () => {
    writeYaml(
      "steps-not-array.workflow.yaml",
      `name: stepsnotarray
description: Steps is a string, not array
steps: "do something"
`,
    );

    const workflows = await loadYamlWorkflows(dir);

    const bad = workflows.find((p) => p.name === "stepsnotarray");
    expect(bad).toBeUndefined();
  });

  test("skips malformed YAML without throwing", async () => {
    writeYaml(
      "malformed.workflow.yaml",
      `name: [this is not valid yaml
steps:
  - ???: bad: yaml: {{{
`,
    );

    // Should not throw; malformed files are skipped
    const workflows = await loadYamlWorkflows(dir);
    const bad = workflows.find((p) => p.name === "malformed");
    expect(bad).toBeUndefined();
  });

  test("only matches workflow/pipeline suffixes, not other YAML files", async () => {
    writeYaml(
      "ignored.yaml",
      `name: shouldbeignored
steps:
  - name: step1
    agent: agent1
`,
    );
    writeYaml(
      "also-ignored.agent.yaml",
      `name: alsoignored
steps:
  - name: step1
    agent: agent1
`,
    );

    const workflows = await loadYamlWorkflows(dir);

    expect(workflows.find((p) => p.name === "shouldbeignored")).toBeUndefined();
    expect(workflows.find((p) => p.name === "alsoignored")).toBeUndefined();
  });

  test("loads multiple valid workflow files", async () => {
    const multiDir = mkdtempSync(join(tmpdir(), "workflow-multi-"));
    try {
      writeFileSync(
        join(multiDir, "alpha.workflow.yaml"),
        `name: alpha\nsteps:\n  - name: a\n    agent: agent-a\n`,
        "utf8",
      );
      writeFileSync(
        join(multiDir, "beta.workflow.yaml"),
        `name: beta\nsteps:\n  - name: b\n    agent: agent-b\n`,
        "utf8",
      );

      const workflows = await loadYamlWorkflows(multiDir);

      expect(workflows).toHaveLength(2);
      const names = workflows.map((p) => p.name).sort();
      expect(names).toEqual(["alpha", "beta"]);
    } finally {
      rmSync(multiDir, { recursive: true, force: true });
    }
  });

  test("loads inputSchema when present", async () => {
    writeYaml(
      "with-schema.workflow.yaml",
      `name: withschema
steps:
  - name: process
    agent: processor
inputSchema:
  repoUrl:
    type: string
    label: Repository URL
    required: true
`,
    );

    const workflows = await loadYamlWorkflows(dir);

    const p = workflows.find((p) => p.name === "withschema");
    expect(p).toBeDefined();
    expect(p!.inputSchema).toBeDefined();
    expect(p!.inputSchema!["repoUrl"]!.type).toBe("string");
    expect(p!.inputSchema!["repoUrl"]!.required).toBe(true);
  });

  test("loads step input mappings when present", async () => {
    writeYaml(
      "step-inputs.workflow.yaml",
      `name: stepinputs
steps:
  - name: fetch
    agent: fetcher
    input:
      url: "\${repoUrl}"
  - name: analyze
    agent: analyzer
    dependsOn:
      - fetch
`,
    );

    const workflows = await loadYamlWorkflows(dir);

    const p = workflows.find((p) => p.name === "stepinputs");
    expect(p).toBeDefined();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal template placeholder under test
    expect(p!.steps[0]!.input).toEqual({ url: "${repoUrl}" });
    expect(p!.steps[1]!.dependsOn).toEqual(["fetch"]);
  });

  test("valid workflows are not affected by co-located invalid files", async () => {
    const mixedDir = mkdtempSync(join(tmpdir(), "workflow-mixed-"));
    try {
      writeFileSync(
        join(mixedDir, "good.workflow.yaml"),
        `name: good\nsteps:\n  - name: s\n    agent: a\n`,
        "utf8",
      );
      writeFileSync(
        join(mixedDir, "bad.workflow.yaml"),
        `name: [broken yaml`,
        "utf8",
      );

      const workflows = await loadYamlWorkflows(mixedDir);

      expect(workflows).toHaveLength(1);
      expect(workflows[0]!.name).toBe("good");
    } finally {
      rmSync(mixedDir, { recursive: true, force: true });
    }
  });
});
