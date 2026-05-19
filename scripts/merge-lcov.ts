#!/usr/bin/env bun
/**
 * Merge per-shard lcov.info files into a single coverage/lcov.info.
 *
 * Usage: bun scripts/merge-lcov.ts <glob-for-lcov-files> <output-path>
 * Sums DA per (SF,line) and FNDA per (SF,name); re-emits SF/FNF/FNH/LF/LH.
 * Bun 1.3.x emits no BRDA records, so branch data is intentionally not handled.
 */
import { Glob } from "bun";

type FileRec = {
  fn: Map<string, number>; // fn name -> declared line
  fnda: Map<string, number>; // fn name -> summed hits
  da: Map<number, number>; // line -> summed hits
};

const [globPat, outPath] = Bun.argv.slice(2);
if (!globPat || !outPath) {
  console.error("usage: merge-lcov.ts <glob> <output>");
  process.exit(2);
}

const files = new Map<string, FileRec>();
const rec = (sf: string): FileRec => {
  const existing = files.get(sf);
  if (existing) return existing;
  const r: FileRec = { fn: new Map(), fnda: new Map(), da: new Map() };
  files.set(sf, r);
  return r;
};

const glob = new Glob(globPat);
for await (const path of glob.scan({ absolute: true })) {
  const text = await Bun.file(path).text();
  let cur: FileRec | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      cur = rec(line.slice(3));
    } else if (!cur || line === "end_of_record") {
      cur = null;
    } else if (line.startsWith("FN:")) {
      const [lineNo, name] = line.slice(3).split(",");
      if (lineNo && name) cur.fn.set(name, Number(lineNo));
    } else if (line.startsWith("FNDA:")) {
      const [hits, name] = line.slice(5).split(",");
      if (hits === undefined || name === undefined) continue;
      cur.fnda.set(name, (cur.fnda.get(name) ?? 0) + Number(hits));
    } else if (line.startsWith("DA:")) {
      const [lineNo, hits] = line.slice(3).split(",");
      if (lineNo === undefined || hits === undefined) continue;
      const n = Number(lineNo);
      cur.da.set(n, (cur.da.get(n) ?? 0) + Number(hits));
    }
  }
}

const out: string[] = [];
for (const [sf, r] of files) {
  out.push("TN:");
  out.push(`SF:${sf}`);
  for (const [name, lineNo] of r.fn) out.push(`FN:${lineNo},${name}`);
  let fnh = 0;
  for (const [name, hits] of r.fnda) {
    out.push(`FNDA:${hits},${name}`);
    if (hits > 0) fnh++;
  }
  out.push(`FNF:${r.fn.size}`);
  out.push(`FNH:${fnh}`);
  const sortedDa = [...r.da.entries()].sort((a, b) => a[0] - b[0]);
  let lh = 0;
  for (const [lineNo, hits] of sortedDa) {
    out.push(`DA:${lineNo},${hits}`);
    if (hits > 0) lh++;
  }
  out.push(`LF:${r.da.size}`);
  out.push(`LH:${lh}`);
  out.push("end_of_record");
}

await Bun.write(outPath, out.join("\n") + "\n");
console.log(`merged ${files.size} source files → ${outPath}`);
