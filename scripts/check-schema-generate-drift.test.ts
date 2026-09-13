import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import {
  SDK_PACKAGE,
  SDK_SOURCE_DIR,
  digest,
  driftedSchemas,
  generatedSchemaOutputs,
  runSchemaDriftCheck,
  ungeneratedSchemaFiles,
} from "./check-schema-generate-drift.ts";

describe("generatedSchemaOutputs", () => {
  test("derives the checked set from the package's own --out arguments", async () => {
    const manifest = JSON.parse(await readFile(`${SDK_PACKAGE}/package.json`, "utf8")) as { scripts: Record<string, string> };
    const outputs = generatedSchemaOutputs(manifest.scripts["schema:generate"]!);
    expect(outputs.length).toBe(8);
    expect(outputs).toContain(`${SDK_SOURCE_DIR}/factory-runner-request.schema.json`);
    expect(outputs).toContain(`${SDK_SOURCE_DIR}/factory-api-response.schema.json`);
    expect(outputs.every((file) => file.endsWith(".schema.json"))).toBe(true);
  });

  test("every committed schema file is produced by the generator, so none is hand-written", async () => {
    const manifest = JSON.parse(await readFile(`${SDK_PACKAGE}/package.json`, "utf8")) as { scripts: Record<string, string> };
    const onDisk = (await readdir(SDK_SOURCE_DIR)).filter((name) => name.endsWith(".schema.json")).map((name) => `${SDK_SOURCE_DIR}/${name}`).sort();
    expect(onDisk.length).toBe(8);
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
    // exercised by the `Factory schema and kernel` lane, and spawning eight
    // ts-json-schema-generator passes inside the backend pool would make this
    // suite the slowest file in it.
    expect(await runSchemaDriftCheck({ generate: async () => 0, log })).toBe(0);
    expect(output).toEqual(["schema drift gate passed: 8 generated schema(s) match 'schema:generate' byte for byte."]);
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
