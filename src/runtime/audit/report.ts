import { join } from "node:path";
import type { Feature, FeatureClassification, SurfaceVerdicts } from "../../db/schema";

/**
 * Markdown gap report writer. Output goes to
 *   <projectRoot>/.ezcorp/audit-reports/<projectName>-<YYYY-MM-DD>.md
 * which is gitignored (mirrors the extension-data convention).
 */

export interface FeatureVerdict {
  feature: Pick<Feature, "id" | "name" | "description">;
  surfaces: SurfaceVerdicts;
  rationale: string;
  fromCache: boolean;
}

function todayIso(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64) || "project";
}

function mark(exposed: boolean): string {
  return exposed ? "✓" : "✗";
}

function summaryTable(verdicts: FeatureVerdict[]): string {
  const lines = [
    "| Feature | SDK | EzButton | MCP | Source |",
    "|---|---|---|---|---|",
  ];
  for (const v of verdicts) {
    const sdkVia = v.surfaces.sdk.via;
    const sources = [v.surfaces.sdk.via, v.surfaces.ezbutton.via, v.surfaces.mcp.via];
    const allPrecheck = sources.every((s) => s === "precheck");
    const sourceLabel = allPrecheck ? "precheck" : sources.includes("llm") ? "mixed/llm" : sdkVia;
    lines.push(
      `| ${v.feature.name} | ${mark(v.surfaces.sdk.exposed)} | ${mark(v.surfaces.ezbutton.exposed)} | ${mark(v.surfaces.mcp.exposed)} | ${sourceLabel} |`,
    );
  }
  return lines.join("\n");
}

function gapSection(title: string, verdicts: FeatureVerdict[], pick: (v: SurfaceVerdicts) => { exposed: boolean; evidence?: string }): string {
  const missing = verdicts.filter((v) => !pick(v.surfaces).exposed);
  if (missing.length === 0) return `### ${title}\n\n_None — full coverage._\n`;
  const lines: string[] = [`### ${title}`, ""];
  for (const v of missing) {
    const ev = pick(v.surfaces).evidence ?? "";
    lines.push(`- **${v.feature.name}** — ${ev}${v.rationale ? ` _(${v.rationale})_` : ""}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Surface the *why* behind every ✓ verdict that carries an evidence
 * string. Without this, readers never see why an extension is treated as
 * MCP-exposed (the precheck stamp says "covered by extension_search MCP
 * meta-tool"), and lose the architectural rationale embedded in the
 * verdict. Failures already show evidence in the gap sections.
 */
function coverageNotesSection(verdicts: FeatureVerdict[]): string {
  const surfaces: Array<[keyof SurfaceVerdicts, string]> = [
    ["sdk", "SDK"],
    ["ezbutton", "EzButton"],
    ["mcp", "MCP"],
  ];
  const lines: string[] = [];
  for (const v of verdicts) {
    for (const [key, label] of surfaces) {
      const s = v.surfaces[key];
      if (!s.exposed) continue;
      if (!s.evidence) continue;
      lines.push(`- **${v.feature.name}** · ${label} ✓ — ${s.evidence}`);
    }
  }
  if (lines.length === 0) return "_No exposed surfaces with evidence to report._\n";
  return lines.join("\n") + "\n";
}

function deltaSection(
  current: FeatureVerdict[],
  prev: FeatureClassification[],
): string {
  if (prev.length === 0) return "_No prior run to diff against._\n";
  const prevById = new Map<string, FeatureClassification>();
  for (const p of prev) prevById.set(p.featureId, p);
  const currentIds = new Set(current.map((c) => c.feature.id));

  const flips: string[] = [];
  const added: string[] = [];
  for (const v of current) {
    const p = prevById.get(v.feature.id);
    if (!p) {
      added.push(`- **${v.feature.name}** _(new)_`);
      continue;
    }
    const surfaces: Array<keyof SurfaceVerdicts> = ["sdk", "ezbutton", "mcp"];
    for (const s of surfaces) {
      if (p.surfaces[s].exposed !== v.surfaces[s].exposed) {
        flips.push(
          `- **${v.feature.name}** · ${s}: ${mark(p.surfaces[s].exposed)} → ${mark(v.surfaces[s].exposed)}`,
        );
      }
    }
  }
  const removed: string[] = [];
  for (const p of prev) {
    if (!currentIds.has(p.featureId)) removed.push(`- _featureId ${p.featureId}_ (deleted since last run)`);
  }

  const blocks: string[] = [];
  if (added.length) blocks.push("**New features**\n" + added.join("\n"));
  if (flips.length) blocks.push("**Verdict flips**\n" + flips.join("\n"));
  if (removed.length) blocks.push("**Deleted features**\n" + removed.join("\n"));
  if (blocks.length === 0) return "_No changes since last run._\n";
  return blocks.join("\n\n") + "\n";
}

export interface WriteReportInput {
  projectId: string;
  projectName: string;
  projectRoot: string;
  verdicts: FeatureVerdict[];
  prevClassifications: FeatureClassification[];
  truncated?: boolean;
  now?: Date;
}

export async function writeReport(input: WriteReportInput): Promise<string> {
  const { projectId, projectName, projectRoot, verdicts, prevClassifications, truncated } = input;
  const date = todayIso(input.now);
  const filename = `${slugify(projectName)}-${date}.md`;
  const outDir = join(projectRoot, ".ezcorp", "audit-reports");
  const outPath = join(outDir, filename);

  const cacheHits = verdicts.filter((v) => v.fromCache).length;
  const llmSurfaces = verdicts.flatMap((v) => [v.surfaces.sdk, v.surfaces.ezbutton, v.surfaces.mcp]).filter((s) => s.via === "llm").length;

  const sections: string[] = [];
  sections.push(`# Surface Coverage Audit — ${projectName}`);
  sections.push("");
  sections.push(`_Generated ${date} · project \`${projectId}\` · ${verdicts.length} features · ${cacheHits} from cache · ${llmSurfaces} LLM verdicts_`);
  if (truncated) sections.push(`\n> ⚠️ Run truncated — feature count exceeded MAX_FEATURES_PER_RUN. See run.ts.`);
  sections.push("");
  sections.push("## Summary");
  sections.push("");
  sections.push(summaryTable(verdicts));
  sections.push("");
  sections.push("## Gaps");
  sections.push("");
  sections.push(gapSection("Missing SDK exposure", verdicts, (s) => s.sdk));
  sections.push(gapSection("Missing EzButton exposure", verdicts, (s) => s.ezbutton));
  sections.push(gapSection("Missing MCP exposure", verdicts, (s) => s.mcp));
  sections.push("## Coverage notes");
  sections.push("");
  sections.push(coverageNotesSection(verdicts));
  sections.push("## Delta from last run");
  sections.push("");
  sections.push(deltaSection(verdicts, prevClassifications));

  const content = sections.join("\n");
  await Bun.write(outPath, content);
  return outPath;
}
