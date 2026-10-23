// uncovered.ts <worktree> <base> <lcov> <file...>: changed lines (vs base, incl. working tree) with zero hits.
import { readFileSync } from "node:fs";
const [worktree, base, lcov, ...files] = process.argv.slice(2);
const hits = new Map<string, Map<number, number>>();
let current = "";
for (const line of readFileSync(lcov!, "utf8").split("\n")) {
  if (line.startsWith("SF:")) { current = line.slice(3).replace(`${worktree}/`, ""); hits.set(current, hits.get(current) ?? new Map()); }
  else if (line.startsWith("DA:")) { const [n, h] = line.slice(3).split(","); const m = hits.get(current)!; m.set(Number(n), Math.max(m.get(Number(n)) ?? 0, Number(h))); }
}
for (const file of files) {
  const diff = Bun.spawnSync(["git", "-C", worktree!, "diff", "-U0", base!, "--", file]).stdout.toString();
  const changed: number[] = [];
  const untracked = Bun.spawnSync(["git", "-C", worktree!, "ls-files", "--error-unmatch", file]).exitCode !== 0;
  if (untracked) readFileSync(`${worktree}/${file}`, "utf8").split("\n").forEach((_, i) => changed.push(i + 1));
  for (const m of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) { const start = Number(m[1]); const count = m[2] === undefined ? 1 : Number(m[2]); for (let i = 0; i < count; i++) changed.push(start + i); }
  const map = hits.get(file);
  if (!map) { console.log(`${file}: NOT IN LCOV`); continue; }
  const missed = changed.filter((n) => map.has(n) && map.get(n) === 0);
  console.log(`${file}: changed ${changed.length}, instrumented-missed ${missed.length}${missed.length ? ` -> ${missed.join(",")}` : ""}`);
}
