import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SDK_PACKAGE,
  SDK_SOURCE_DIR,
  digest,
  driftedSchemas,
  generatedSchemaOutputs,
  readSchemaPlanInputs,
  runSchemaDriftCheck,
  schemaGenerationPlan,
  spawnSchemaGenerate,
  ungeneratedSchemaFiles,
} from "./check-schema-generate-drift.ts";

describe("generatedSchemaOutputs", () => {
  test("derives the checked set from the package's own --out arguments", async () => {
    const manifest = JSON.parse(await readFile(`${SDK_PACKAGE}/package.json`, "utf8")) as { scripts: Record<string, string> };
    const outputs = generatedSchemaOutputs(manifest.scripts["schema:generate"]!);
    const onDisk = (await readdir(SDK_SOURCE_DIR)).filter((name) => name.endsWith(".schema.json"));
    // The checked set is whatever the generator declares; it must be non-empty and
    // agree with the committed set, so a new schema needs no count edit here.
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs.length).toBe(onDisk.length);
    expect(outputs).toContain(`${SDK_SOURCE_DIR}/factory-runner-request.schema.json`);
    expect(outputs).toContain(`${SDK_SOURCE_DIR}/factory-api-response.schema.json`);
    expect(outputs.every((file) => file.endsWith(".schema.json"))).toBe(true);
  });

  test("every committed schema file is produced by the generator, so none is hand-written", async () => {
    const manifest = JSON.parse(await readFile(`${SDK_PACKAGE}/package.json`, "utf8")) as { scripts: Record<string, string> };
    const onDisk = (await readdir(SDK_SOURCE_DIR)).filter((name) => name.endsWith(".schema.json")).map((name) => `${SDK_SOURCE_DIR}/${name}`).sort();
    expect(onDisk.length).toBeGreaterThan(0);
    expect(onDisk.length).toBe(generatedSchemaOutputs(manifest.scripts["schema:generate"]!).length);
    expect(ungeneratedSchemaFiles(onDisk, generatedSchemaOutputs(manifest.scripts["schema:generate"]!))).toEqual([]);
  });

  test("a hand-written schema beside the generated ones is rejected", () => {
    expect(ungeneratedSchemaFiles([`${SDK_SOURCE_DIR}/hand.schema.json`], [`${SDK_SOURCE_DIR}/generated.schema.json`])).toEqual([
      `${SDK_SOURCE_DIR}/hand.schema.json: a *.schema.json file that 'schema:generate' does not produce — generated schemas are the only kind allowed here`,
    ]);
  });

  test("deduplicates and sorts repeated --out targets", () => {
    expect(generatedSchemaOutputs("gen --out src/b.schema.json && gen --out src/a.schema.json && gen --out src/b.schema.json")).toEqual([
      `${SDK_SOURCE_DIR}/a.schema.json`,
      `${SDK_SOURCE_DIR}/b.schema.json`,
    ]);
  });
});

describe("driftedSchemas", () => {
  const before = new Map([["a.schema.json", "aaaa000000000000"], ["b.schema.json", "bbbb111111111111"]]);

  test("identical bytes are not drift", () => {
    expect(driftedSchemas(before, new Map(before))).toEqual([]);
  });

  test("a hand edit is reported with both digests", () => {
    const after = new Map(before).set("a.schema.json", "cccc222222222222");
    expect(driftedSchemas(before, after)).toEqual([
      "a.schema.json: committed bytes (sha256 aaaa00000000) differ from 'schema:generate' output (sha256 cccc22222222) — regenerate, never hand-edit",
    ]);
  });

  test("a committed schema the generator stops producing is reported", () => {
    const after = new Map([["b.schema.json", "bbbb111111111111"]]);
    expect(driftedSchemas(before, after)).toEqual(["a.schema.json: 'schema:generate' did not produce this committed schema"]);
  });

  test("a generated schema nobody committed is reported", () => {
    const after = new Map(before).set("c.schema.json", "dddd333333333333");
    expect(driftedSchemas(before, after)).toEqual(["c.schema.json: 'schema:generate' produced a schema that is not committed"]);
  });
});

describe("digest", () => {
  test("distinguishes a one-byte difference", () => {
    expect(digest(new TextEncoder().encode("{}"))).not.toBe(digest(new TextEncoder().encode("{ }")));
    expect(digest(new TextEncoder().encode("{}"))).toBe(digest(new TextEncoder().encode("{}")));
  });
});

describe("schema drift CLI seam", () => {
  async function committedDigests(): Promise<Map<string, string>> {
    const files = (await readdir(SDK_SOURCE_DIR)).filter((name) => name.endsWith(".schema.json")).sort();
    const entries = await Promise.all(files.map(async (name) => [name, digest(new Uint8Array(await Bun.file(`${SDK_SOURCE_DIR}/${name}`).arrayBuffer()))] as const));
    return new Map(entries);
  }

  test("passes when the generator reproduces the committed bytes, and leaves the tree untouched", async () => {
    const before = await committedDigests();
    const output: string[] = [];
    const log = { log: (value: unknown) => output.push(String(value)), error: (value: unknown) => output.push(String(value)) };
    // A no-op generator stands in for the real one here: the real generator is
    // exercised by the `Factory schema and kernel` lane, and spawning every
    // ts-json-schema-generator pass inside the backend pool would make this
    // suite the slowest file in it.
    expect(await runSchemaDriftCheck({ generate: async () => 0, log })).toBe(0);
    const { onDisk } = await readSchemaPlanInputs();
    expect(output).toEqual([`schema drift gate passed: ${onDisk.length} generated schema(s) match 'schema:generate' byte for byte.`]);
    expect(await committedDigests()).toEqual(before);
  });

  test("a generator that fails cannot report 'no drift'", async () => {
    const before = await committedDigests();
    const output: string[] = [];
    const log = { log: (value: unknown) => output.push(String(value)), error: (value: unknown) => output.push(String(value)) };
    expect(await runSchemaDriftCheck({ generate: async () => 7, log })).toBe(1);
    expect(output).toContain("schema drift gate FAILED: 'schema:generate' did not complete, so drift cannot be ruled out");
    expect(await committedDigests()).toEqual(before);
  });

  test("a malformed repository is reported and no generator runs", async () => {
    const output: string[] = [];
    const log = { log: (value: unknown) => output.push(String(value)), error: (value: unknown) => output.push(String(value)) };
    let generatorRuns = 0;
    const result = await runSchemaDriftCheck({
      readInputs: async () => ({ manifest: { scripts: { build: "tsc" } }, onDisk: [] }),
      generate: async () => {
        generatorRuns++;
        return 0;
      },
      log,
    });
    expect(result).toBe(1);
    expect(generatorRuns, "the generator must not run over a repository the plan already rejected").toBe(0);
    expect(output[0]).toBe("schema drift gate FAILED (1 issue(s)):");
    expect(output[1]).toContain("has no 'schema:generate' script");
  });

  test("the default reader sees the real manifest and the real committed schema set", async () => {
    const { manifest, onDisk } = await readSchemaPlanInputs();
    expect(manifest.scripts?.["schema:generate"]).toContain("ts-json-schema-generator");
    expect(onDisk.length).toBeGreaterThan(0);
    expect(onDisk).toHaveLength(generatedSchemaOutputs(manifest.scripts!["schema:generate"]!).length);
  });

  test("a generator that rewrites a schema is reported as drift and the committed bytes are restored", async () => {
    const before = await committedDigests();
    const target = `${SDK_SOURCE_DIR}/factory-runner-request.schema.json`;
    const output: string[] = [];
    const log = { log: (value: unknown) => output.push(String(value)), error: (value: unknown) => output.push(String(value)) };
    const result = await runSchemaDriftCheck({
      generate: async () => {
        const current = await Bun.file(target).text();
        await Bun.write(target, `${current}\n`);
        return 0;
      },
      log,
    });
    expect(result).toBe(1);
    expect(output.some((line) => line.includes("factory-runner-request.schema.json: committed bytes"))).toBe(true);
    expect(await committedDigests()).toEqual(before);
  });
});

describe("schemaGenerationPlan", () => {
  const generated = `${SDK_SOURCE_DIR}/a.schema.json`;

  test("accepts a manifest whose declared outputs are all committed", () => {
    expect(schemaGenerationPlan({ scripts: { "schema:generate": "gen --out src/a.schema.json" } }, [generated])).toEqual({
      expected: [generated],
      issues: [],
    });
  });

  test("a manifest with no schema:generate script fails closed", () => {
    expect(schemaGenerationPlan({ scripts: { build: "tsc" } }, [generated])).toEqual({
      expected: [],
      issues: [`${SDK_PACKAGE}/package.json has no 'schema:generate' script`],
    });
    expect(schemaGenerationPlan({}, [generated]).issues).toHaveLength(1);
  });

  test("a schema:generate script that names no --out target fails closed", () => {
    expect(schemaGenerationPlan({ scripts: { "schema:generate": "echo nothing" } }, [generated])).toEqual({
      expected: [],
      issues: ["'schema:generate' names no --out target"],
    });
  });

  test("a declared output that is not committed fails closed", () => {
    expect(schemaGenerationPlan({ scripts: { "schema:generate": "gen --out src/a.schema.json" } }, []).issues).toEqual([
      `${generated} is declared by 'schema:generate' but absent from the repository`,
    ]);
  });

  test("a hand-written schema beside the generated ones is reported in the same plan", () => {
    const plan = schemaGenerationPlan({ scripts: { "schema:generate": "gen --out src/a.schema.json" } }, [generated, `${SDK_SOURCE_DIR}/hand.schema.json`]);
    expect(plan.expected).toEqual([generated]);
    expect(plan.issues).toHaveLength(1);
    expect(plan.issues[0]).toContain("hand.schema.json");
  });

  test("the real package manifest and the real committed set produce no plan issue", async () => {
    const manifest = JSON.parse(await readFile(`${SDK_PACKAGE}/package.json`, "utf8")) as { scripts: Record<string, string> };
    const onDisk = (await readdir(SDK_SOURCE_DIR)).filter((name) => name.endsWith(".schema.json")).map((name) => `${SDK_SOURCE_DIR}/${name}`).sort();
    expect(schemaGenerationPlan(manifest, onDisk).issues).toEqual([]);
  });
});

describe("spawnSchemaGenerate", () => {
  function packageWith(script: string): { directory: string; cleanup: () => void } {
    const directory = mkdtempSync(join(tmpdir(), "schema-generate-"));
    Bun.write(join(directory, "package.json"), JSON.stringify({ name: "probe", scripts: { "schema:generate": script } }));
    return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  }

  test("returns 0 and logs nothing when the package script succeeds", async () => {
    const probe = packageWith("true");
    const errors: string[] = [];
    try {
      expect(await spawnSchemaGenerate(probe.directory, { error: (value) => errors.push(String(value)) })).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      probe.cleanup();
    }
  });

  test("returns the failing exit code and reports the generator's own stderr", async () => {
    const probe = packageWith("echo 'generator exploded' >&2; exit 3");
    const errors: string[] = [];
    try {
      expect(await spawnSchemaGenerate(probe.directory, { error: (value) => errors.push(String(value)) })).toBe(3);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("schema:generate exited 3");
      expect(errors[0]).toContain("generator exploded");
    } finally {
      probe.cleanup();
    }
  });
});
