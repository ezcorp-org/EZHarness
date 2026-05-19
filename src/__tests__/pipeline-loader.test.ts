import { describe, test, expect, afterAll } from "bun:test";
import { loadYamlPipelines } from "../runtime/pipeline-loader";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Create a temp directory for all tests, cleaned up afterwards
const dir = mkdtempSync(join(tmpdir(), "pipeline-loader-test-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────

function writeYaml(filename: string, content: string) {
  writeFileSync(join(dir, filename), content, "utf8");
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("loadYamlPipelines", () => {
  test("returns empty array for empty directory", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "pipeline-empty-"));
    try {
      const pipelines = await loadYamlPipelines(emptyDir);
      expect(pipelines).toEqual([]);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test("loads a valid pipeline YAML file", async () => {
    writeYaml(
      "review.pipeline.yaml",
      `name: review
description: Code review pipeline
steps:
  - name: analyze
    agent: code-analyzer
  - name: report
    agent: report-writer
    dependsOn:
      - analyze
`,
    );

    const pipelines = await loadYamlPipelines(dir);

    const review = pipelines.find((p) => p.name === "review");
    expect(review).toBeDefined();
    expect(review!.name).toBe("review");
    expect(review!.description).toBe("Code review pipeline");
    expect(review!.steps).toHaveLength(2);
    expect(review!.steps[0]!.name).toBe("analyze");
    expect(review!.steps[0]!.agent).toBe("code-analyzer");
    expect(review!.steps[1]!.name).toBe("report");
    expect(review!.steps[1]!.dependsOn).toEqual(["analyze"]);
  });

  test("defaults description to empty string when omitted", async () => {
    writeYaml(
      "no-desc.pipeline.yaml",
      `name: nodesc
steps:
  - name: step1
    agent: some-agent
`,
    );

    const pipelines = await loadYamlPipelines(dir);

    const p = pipelines.find((p) => p.name === "nodesc");
    expect(p).toBeDefined();
    expect(p!.description).toBe("");
  });

  test("skips pipeline missing required name field", async () => {
    writeYaml(
      "no-name.pipeline.yaml",
      `description: Missing name
steps:
  - name: step1
    agent: some-agent
`,
    );

    const pipelines = await loadYamlPipelines(dir);

    // No pipeline with undefined name should appear
    const bad = pipelines.find((p) => p.description === "Missing name");
    expect(bad).toBeUndefined();
  });

  test("skips pipeline with no steps array", async () => {
    writeYaml(
      "no-steps.pipeline.yaml",
      `name: nosteps
description: Has no steps field
`,
    );

    const pipelines = await loadYamlPipelines(dir);

    const bad = pipelines.find((p) => p.name === "nosteps");
    expect(bad).toBeUndefined();
  });

  test("skips pipeline with empty steps array", async () => {
    writeYaml(
      "empty-steps.pipeline.yaml",
      `name: emptysteps
description: Steps array is empty
steps: []
`,
    );

    const pipelines = await loadYamlPipelines(dir);

    const bad = pipelines.find((p) => p.name === "emptysteps");
    expect(bad).toBeUndefined();
  });

  test("skips pipeline where steps is not an array", async () => {
    writeYaml(
      "steps-not-array.pipeline.yaml",
      `name: stepsnotarray
description: Steps is a string, not array
steps: "do something"
`,
    );

    const pipelines = await loadYamlPipelines(dir);

    const bad = pipelines.find((p) => p.name === "stepsnotarray");
    expect(bad).toBeUndefined();
  });

  test("skips malformed YAML without throwing", async () => {
    writeYaml(
      "malformed.pipeline.yaml",
      `name: [this is not valid yaml
steps:
  - ???: bad: yaml: {{{
`,
    );

    // Should not throw; malformed files are skipped
    const pipelines = await loadYamlPipelines(dir);
    const bad = pipelines.find((p) => p.name === "malformed");
    expect(bad).toBeUndefined();
  });

  test("only matches *.pipeline.yaml files, not other YAML files", async () => {
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

    const pipelines = await loadYamlPipelines(dir);

    expect(pipelines.find((p) => p.name === "shouldbeignored")).toBeUndefined();
    expect(pipelines.find((p) => p.name === "alsoignored")).toBeUndefined();
  });

  test("loads multiple valid pipeline files", async () => {
    const multiDir = mkdtempSync(join(tmpdir(), "pipeline-multi-"));
    try {
      writeFileSync(
        join(multiDir, "alpha.pipeline.yaml"),
        `name: alpha\nsteps:\n  - name: a\n    agent: agent-a\n`,
        "utf8",
      );
      writeFileSync(
        join(multiDir, "beta.pipeline.yaml"),
        `name: beta\nsteps:\n  - name: b\n    agent: agent-b\n`,
        "utf8",
      );

      const pipelines = await loadYamlPipelines(multiDir);

      expect(pipelines).toHaveLength(2);
      const names = pipelines.map((p) => p.name).sort();
      expect(names).toEqual(["alpha", "beta"]);
    } finally {
      rmSync(multiDir, { recursive: true, force: true });
    }
  });

  test("loads inputSchema when present", async () => {
    writeYaml(
      "with-schema.pipeline.yaml",
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

    const pipelines = await loadYamlPipelines(dir);

    const p = pipelines.find((p) => p.name === "withschema");
    expect(p).toBeDefined();
    expect(p!.inputSchema).toBeDefined();
    expect(p!.inputSchema!["repoUrl"]!.type).toBe("string");
    expect(p!.inputSchema!["repoUrl"]!.required).toBe(true);
  });

  test("loads step input mappings when present", async () => {
    writeYaml(
      "step-inputs.pipeline.yaml",
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

    const pipelines = await loadYamlPipelines(dir);

    const p = pipelines.find((p) => p.name === "stepinputs");
    expect(p).toBeDefined();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal template placeholder under test
    expect(p!.steps[0]!.input).toEqual({ url: "${repoUrl}" });
    expect(p!.steps[1]!.dependsOn).toEqual(["fetch"]);
  });

  test("valid pipelines are not affected by co-located invalid files", async () => {
    const mixedDir = mkdtempSync(join(tmpdir(), "pipeline-mixed-"));
    try {
      writeFileSync(
        join(mixedDir, "good.pipeline.yaml"),
        `name: good\nsteps:\n  - name: s\n    agent: a\n`,
        "utf8",
      );
      writeFileSync(
        join(mixedDir, "bad.pipeline.yaml"),
        `name: [broken yaml`,
        "utf8",
      );

      const pipelines = await loadYamlPipelines(mixedDir);

      expect(pipelines).toHaveLength(1);
      expect(pipelines[0]!.name).toBe("good");
    } finally {
      rmSync(mixedDir, { recursive: true, force: true });
    }
  });
});
