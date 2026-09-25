/**
 * The W19a verdict across passes: `bun summarize.ts <records-dir>`.
 *
 * Each pass judges itself; this judges what only several passes can show.
 * A's and C's staged outputs must be byte-identical across a mode's passes
 * (equal content digests of the stored candidate outputs), the mock's answer
 * must be identical across its passes, and Ollama's answers are recorded as
 * they came, next to the temperature and seed they were pinned with. Writes
 * `summary.json` and exits non-zero when any criterion fails.
 */
import { join } from "node:path";

const dir = process.argv[2]!;
type Node = { stored?: Record<string, unknown> | null; candidateOutput?: { digest?: string } | null; operations?: Array<{ usage?: unknown; providerReceiptDigest?: unknown }> };
type Record_ = { label: string; outcome?: string; failure?: string; startedAt?: string; finishedAt?: string; pin?: { provider?: string; model?: string; configuration?: unknown } | null; checks?: Array<{ check: string; ok: boolean }>; run?: { timeline?: string[] }; evidence?: { nodes?: Record<string, Node> } };

async function load(label: string): Promise<Record_ | undefined> {
  const file = Bun.file(join(dir, `${label}.json`));
  return await file.exists() ? await file.json() as Record_ : undefined;
}

const criteria: Array<{ criterion: string; ok: boolean; detail?: unknown }> = [];
const modes: Record<string, unknown> = {};
for (const mode of ["ollama", "mock"]) {
  const passes = await Promise.all([1, 2, 3].map((pass) => load(`${mode}-${pass}`)));
  const node = (record: Record_ | undefined, name: string) => record?.evidence?.nodes?.[name];
  const digests = (name: string) => passes.map((record) => node(record, name)?.candidateOutput?.digest ?? null);
  const answers = passes.map((record) => (node(record, "infer")?.stored?.answer as string | undefined) ?? null);
  criteria.push({ criterion: `${mode}: three of three passes passed`, ok: passes.every((record) => record?.outcome === "passed"), detail: passes.map((record) => ({ label: record?.label ?? null, outcome: record?.outcome ?? "absent", failure: record?.failure ?? null })) });
  for (const name of ["prepare", "combine"]) {
    const seen = digests(name);
    criteria.push({ criterion: `${mode}: ${name}'s staged output is byte-identical across passes`, ok: seen.every((value) => value !== null && value === seen[0]), detail: seen });
  }
  if (mode === "mock") criteria.push({ criterion: "mock: infer's answer is identical across passes", ok: answers.every((value) => value !== null && value === answers[0]), detail: answers });
  modes[mode] = {
    pin: passes[0]?.pin ?? null,
    answers,
    usage: passes.map((record) => node(record, "infer")?.operations?.[0]?.usage ?? null),
    providerReceiptDigests: passes.map((record) => node(record, "infer")?.operations?.[0]?.providerReceiptDigest ?? null),
    summaries: passes.map((record) => node(record, "combine")?.stored?.summary ?? null),
    prepareDigests: digests("prepare"),
    combineDigests: digests("combine"),
    windows: passes.map((record) => ({ startedAt: record?.startedAt ?? null, finishedAt: record?.finishedAt ?? null })),
  };
}
const answersEqual = (modes.ollama as { answers: unknown[] }).answers.every((value, _index, all) => value === all[0]);
const controls: Record<string, unknown> = {};
for (const label of ["control-no-pin", "control-missing-model"]) {
  const record = await load(label);
  criteria.push({ criterion: `${label}: every refusal named`, ok: record?.outcome === "passed", detail: record?.checks ?? record?.failure ?? "absent" });
  controls[label] = { outcome: record?.outcome ?? "absent", timeline: record?.run?.timeline ?? null, checks: record?.checks ?? null };
}
{
  // The forced-failure control: the pass must fail by its own named check, and
  // what it left behind must hold (verify-diagnostics.ts).
  const record = await load("control-forced-failure");
  const file = Bun.file(join(dir, "control-forced-failure.diagnostics-check.json"));
  const check = await file.exists() ? await file.json() as { ok?: boolean; problems?: string[] } : undefined;
  const forced = record?.outcome === "failed" && String(record.failure ?? "").includes("forced failure: the diagnostics control fails this pass on purpose");
  criteria.push({ criterion: "control-forced-failure: the pass failed on purpose and left every process log and readiness file", ok: forced && check?.ok === true, detail: { outcome: record?.outcome ?? "absent", problems: check?.problems ?? "no check" } });
  controls["control-forced-failure"] = { outcome: record?.outcome ?? "absent", diagnostics: check ?? null };
}
const summary = {
  generatedAt: new Date().toISOString(),
  verdict: criteria.every((entry) => entry.ok) ? "passed" : "failed",
  criteria,
  modes,
  ollamaDeterminism: {
    recordedAsIs: true,
    answersIdenticalAcrossPasses: answersEqual,
    pinnedSampling: (modes.ollama as { pin?: { configuration?: unknown } }).pin?.configuration ?? null,
  },
  controls,
};
await Bun.write(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ verdict: summary.verdict, failed: criteria.filter((entry) => !entry.ok).map((entry) => entry.criterion) }, null, 2));
process.exit(summary.verdict === "passed" ? 0 : 1);
