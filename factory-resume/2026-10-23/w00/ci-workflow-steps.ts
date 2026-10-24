// w00/ci-workflow-steps.ts <workflow.yml> (integrator-5, 2026-10-17; team-lead's ruling a8b7283108caee00): the ONE reader of a GitHub
// workflow's run steps (file -> step -> env), for lane-forms-leg.py (ownership and the exact step form) and later 75i (each pg file's CI
// step env). Run from the root of the tree under test; Bun's own YAML parser (no second parser). Prints one JSON line per (test file,
// step): {file, workflow, job, step, line, env, run}. env = workflow env, then job env, then step env (later wins), values as strings.
// Files: every *.test.ts path written literally in the step's run, plus every one written literally in a repo script that the run calls
// as "bash scripts/<x>.sh" (one level). A step without a run, or whose run names no test file, prints nothing. Exit 2 on a bad call or an
// unreadable/unparsable workflow (named on stderr).
const path = process.argv[2];
if (!path) { console.error("usage: ci-workflow-steps.ts <workflow.yml>"); process.exit(2); }
let text: string, y: any;
try { text = await Bun.file(path).text(); y = Bun.YAML.parse(text); } catch (e) { console.error(`ci-workflow-steps: cannot read ${path}: ${e}`); process.exit(2); }
const lines = text.split("\n");
const TEST = /(?:\.\/)?((?:tests|src|packages|web|scripts)\/[A-Za-z0-9_.\/@-]+\.test\.ts)/g;
const str = (o: any) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, String(v)]));
for (const [job, j] of Object.entries<any>(y?.jobs ?? {})) {
  let from = lines.findIndex((l) => l === `  ${job}:`);
  for (const s of j.steps ?? []) {
    const at = s.name ? lines.findIndex((l, i) => i > from && l.trim() === `- name: ${s.name}`) : -1;
    if (at > from) from = at;
    if (typeof s.run !== "string") continue;
    const files = new Set<string>([...s.run.matchAll(TEST)].map((m) => m[1]));
    for (const m of s.run.matchAll(/\bbash\s+(scripts\/[A-Za-z0-9_.\/-]+\.sh)\b/g)) {
      const f = Bun.file(m[1]);
      if (await f.exists()) for (const t of (await f.text()).matchAll(TEST)) files.add(t[1]);
    }
    const env = { ...str(y.env), ...str(j.env), ...str(s.env) };
    for (const file of [...files].sort()) console.log(JSON.stringify({ file, workflow: path, job, step: s.name ?? "", line: at + 1, env, run: s.run }));
  }
}
