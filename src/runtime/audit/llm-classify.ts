import { join } from "node:path";
import type { AgentContext } from "../../types";
import type { FeatureWithFiles } from "../../db/queries/features";
import type { SurfaceVerdict, SurfaceVerdicts } from "../../db/schema";
import { asFullVerdict, type PartialVerdict } from "./precheck";

/**
 * LLM-judged surface classifier. Only invoked when at least one surface
 * was left undecided by precheck (see run.ts). Precheck wins on conflict
 * — the merge step at the bottom never overwrites a precheck verdict.
 *
 * JSON-output handling mirrors src/runtime/config-to-agent.ts:91-99 —
 * try/parse with a structured-failure fallback (asFullVerdict so the
 * classifier never throws and the audit run can keep going).
 */

const LLM_FILE_HEAD_LINES = 80;
const LLM_TOTAL_BUDGET_BYTES = 8_192;

const SYSTEM_PROMPT = `You are a coverage auditor for the EZCorp codebase. Given a feature (name, description, file list, and optional file headers), decide whether it should be exposed via each of three "outward" surfaces:

  - sdk: programmatic, schema-stable, sandboxable interface in packages/@ezcorp/sdk (tools/skills/agents declared via defineExtension())
  - ezbutton: page-mounted UI capability that the Ez panel should be able to read or invoke (uses <EzContext> on a route)
  - mcp: programmatic tool useful to external LLM clients via the MCP server (no GUI dependency, schema-able I/O)

Respond with STRICT JSON only — no markdown, no prose, no code fences:
{
  "sdk":      { "exposed": <bool>, "evidence": "<short reason>" },
  "ezbutton": { "exposed": <bool>, "evidence": "<short reason>" },
  "mcp":      { "exposed": <bool>, "evidence": "<short reason>" },
  "rationale": "<one paragraph overall>"
}`;

interface LlmShape {
  sdk?: { exposed?: unknown; evidence?: unknown };
  ezbutton?: { exposed?: unknown; evidence?: unknown };
  mcp?: { exposed?: unknown; evidence?: unknown };
  rationale?: unknown;
}

async function buildUserPrompt(
  feature: FeatureWithFiles,
  projectRoot: string,
): Promise<string> {
  const lines: string[] = [];
  lines.push(`Feature: ${feature.name}`);
  if (feature.description) lines.push(`Description: ${feature.description}`);
  lines.push(`Files (${feature.files.length}):`);
  for (const f of feature.files.slice(0, 50)) lines.push(`  - ${f.relpath}`);
  if (feature.files.length > 50) lines.push(`  … and ${feature.files.length - 50} more`);

  let budget = LLM_TOTAL_BUDGET_BYTES;
  lines.push("");
  lines.push("File headers (top of file, truncated):");
  for (const f of feature.files) {
    if (budget <= 0) break;
    try {
      const file = Bun.file(join(projectRoot, f.relpath));
      if (!(await file.exists())) continue;
      const head = (await file.text()).split("\n").slice(0, LLM_FILE_HEAD_LINES).join("\n");
      const slice = head.slice(0, budget);
      lines.push(`--- ${f.relpath} ---`);
      lines.push(slice);
      budget -= slice.length + f.relpath.length + 10;
    } catch {
      // skip unreadable file
    }
  }
  return lines.join("\n");
}

function coerceVerdict(raw: { exposed?: unknown; evidence?: unknown } | undefined): SurfaceVerdict | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (typeof raw.exposed !== "boolean") return undefined;
  return {
    exposed: raw.exposed,
    via: "llm",
    evidence: typeof raw.evidence === "string" ? raw.evidence : undefined,
  };
}

export interface LlmClassifyResult {
  surfaces: SurfaceVerdicts;
  rationale: string;
}

export async function llmClassify(
  feature: FeatureWithFiles,
  partial: PartialVerdict,
  projectRoot: string,
  ctx: AgentContext,
): Promise<LlmClassifyResult> {
  const userPrompt = await buildUserPrompt(feature, projectRoot);

  let parsed: LlmShape | undefined;
  let rationale = "";
  try {
    const response = await ctx.llm.complete(
      [{ role: "user", content: userPrompt }],
      { system: SYSTEM_PROMPT },
    );
    const text: string = response?.text ?? "";
    rationale = "";
    parsed = JSON.parse(text) as LlmShape;
    if (typeof parsed?.rationale === "string") rationale = parsed.rationale;
  } catch (err) {
    ctx.log(`llmClassify: parse failed for ${feature.name}: ${String(err)}`, "warn");
    return { surfaces: asFullVerdict(partial), rationale: "" };
  }

  const llmSurfaces = {
    sdk: coerceVerdict(parsed?.sdk),
    ezbutton: coerceVerdict(parsed?.ezbutton),
    mcp: coerceVerdict(parsed?.mcp),
  };

  // Merge: precheck wins on conflict, LLM fills the gaps.
  const merged: PartialVerdict = {
    sdk: partial.sdk ?? llmSurfaces.sdk,
    ezbutton: partial.ezbutton ?? llmSurfaces.ezbutton,
    mcp: partial.mcp ?? llmSurfaces.mcp,
  };

  return { surfaces: asFullVerdict(merged), rationale };
}
