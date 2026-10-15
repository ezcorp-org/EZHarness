#!/usr/bin/env node
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";

const [coverageDirectory, bundlePath, sourceMapPath, outputPath, canonicalSource] = process.argv.slice(2);
if (!coverageDirectory || !bundlePath || !sourceMapPath || !outputPath || !canonicalSource) {
  throw new Error("usage: node-v8-to-lcov <v8-dir> <bundle> <map> <output> <canonical-source>");
}

const requireFromWorker = createRequire(resolve("node_modules/.bun/source-map@0.7.6/node_modules/source-map/source-map.js"));
const { SourceMapConsumer } = requireFromWorker("source-map");
const bundle = await readFile(bundlePath, "utf8");
const lineOffsets = [0];
for (let offset = 0; offset < bundle.length; offset += 1) if (bundle.charCodeAt(offset) === 10) lineOffsets.push(offset + 1);

const rangeSets = [];
for (const name of await readdir(coverageDirectory)) {
  if (!name.endsWith(".json")) continue;
  const receipt = JSON.parse(await readFile(resolve(coverageDirectory, name), "utf8"));
  for (const script of receipt.result ?? []) {
    if (!script.url.includes(bundlePath.split("/").at(-1))) continue;
    rangeSets.push((script.functions ?? []).flatMap((fn) => fn.ranges ?? []));
  }
}
if (rangeSets.length === 0) throw new Error("Temporal workflow bundle has no V8 coverage receipt");

function hitAt(offset) {
  let highest = 0;
  for (const ranges of rangeSets) {
    let selected;
    for (const range of ranges) {
      if (range.startOffset > offset || range.endOffset <= offset) continue;
      if (!selected || range.endOffset - range.startOffset < selected.endOffset - selected.startOffset) selected = range;
    }
    highest = Math.max(highest, selected?.count ?? 0);
  }
  return highest;
}

const inlineMap = bundle.match(/sourceMappingURL=data:application\/json[^,]*;base64,([A-Za-z0-9+/=]+)\s*$/)?.[1];
const rawMap = inlineMap
  ? JSON.parse(Buffer.from(inlineMap, "base64").toString("utf8"))
  : JSON.parse(await readFile(sourceMapPath, "utf8"));
const consumer = await new SourceMapConsumer(rawMap);
const hits = new Map();
const sourceLines = (await readFile(resolve(canonicalSource), "utf8")).split("\n");
consumer.eachMapping((mapping) => {
  if (!mapping.source?.endsWith(canonicalSource) || mapping.originalLine == null) return;
  if (sourceLines[mapping.originalLine - 1]?.trim() === "}") return;
  const generatedOffset = (lineOffsets[mapping.generatedLine - 1] ?? 0) + mapping.generatedColumn;
  const count = hitAt(generatedOffset);
  hits.set(mapping.originalLine, Math.max(hits.get(mapping.originalLine) ?? 0, count));
});
consumer.destroy();
if (hits.size === 0) throw new Error(`source map contains no canonical mappings for ${canonicalSource}`);

const source = relative(process.cwd(), resolve(canonicalSource));
let lcov = `TN:ezcorp-node-v8\nSF:${source}\n`;
for (const [line, count] of [...hits].sort(([left], [right]) => left - right)) lcov += `DA:${line},${count}\n`;
lcov += `LF:${hits.size}\nLH:${[...hits.values()].filter((count) => count > 0).length}\nend_of_record\n`;
await writeFile(outputPath, lcov);
