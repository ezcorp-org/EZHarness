import type { AgentContext } from "../../types";
import { listFeatures, getFeatureById } from "../../db/queries/features";
import { getProject, listProjects } from "../../db/queries/projects";
import { listLatestClassifications } from "../../db/queries/feature-classifications";
import { runPrecheck, asFullVerdict } from "./precheck";
import { llmClassify } from "./llm-classify";
import { computeContentHash, withCache } from "./cache";
import { writeReport, type FeatureVerdict } from "./report";
import { logger } from "../../logger";

const log = logger.child("audit.run");

/**
 * Per-run cap. Mirrors the partial-result philosophy from
 * src/runtime/scan/feature-scan.ts — if a project has thousands of
 * features, classify the first N and tag the report as truncated rather
 * than failing the whole run.
 */
const MAX_FEATURES_PER_RUN = 500;

export interface RunAuditResult {
  reportPath: string;
  featureCount: number;
  cacheHits: number;
  llmCalls: number;
  truncated: boolean;
}

export async function runAudit(
  projectId: string,
  projectRoot: string,
  ctx: AgentContext,
): Promise<RunAuditResult> {
  const project = await getProject(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  const allFeatures = await listFeatures(projectId);
  const features = allFeatures.slice(0, MAX_FEATURES_PER_RUN);
  const truncated = allFeatures.length > MAX_FEATURES_PER_RUN;
  const prev = await listLatestClassifications(projectId);

  ctx.log(`Auditing ${features.length} feature(s) in ${project.name}${truncated ? ` (truncated from ${allFeatures.length})` : ""}`);

  const verdicts: FeatureVerdict[] = [];
  let cacheHits = 0;
  let llmCalls = 0;

  for (const f of features) {
    if (ctx.signal.aborted) {
      ctx.log("Audit cancelled", "warn");
      break;
    }
    const withFiles = await getFeatureById(projectId, f.id);
    if (!withFiles) continue;

    const hash = await computeContentHash(withFiles.files, projectRoot);
    const cached = await withCache(f.id, hash, async () => {
      const partial = await runPrecheck(withFiles, projectRoot);
      const needsLlm = !partial.sdk || !partial.ezbutton || !partial.mcp;
      if (!needsLlm) {
        return { surfaces: asFullVerdict(partial), rationale: "" };
      }
      llmCalls += 1;
      const result = await llmClassify(withFiles, partial, projectRoot, ctx);
      return { surfaces: result.surfaces, rationale: result.rationale };
    });

    if (cached.fromCache) cacheHits += 1;
    verdicts.push({
      feature: { id: f.id, name: f.name, description: f.description },
      surfaces: cached.surfaces,
      rationale: cached.rationale,
      fromCache: cached.fromCache,
    });
  }

  const reportPath = await writeReport({
    projectId,
    projectName: project.name,
    projectRoot,
    verdicts,
    prevClassifications: prev,
    truncated,
  });

  ctx.log(`Audit complete: ${verdicts.length} verdicts (${cacheHits} cached, ${llmCalls} LLM), report at ${reportPath}`);
  return { reportPath, featureCount: verdicts.length, cacheHits, llmCalls, truncated };
}

/**
 * Scheduled-run helper: iterates every project and audits each in turn.
 * Used by the optional background timer in src/startup/background-timers.ts.
 * Failures on individual projects are logged and skipped — never let one
 * misconfigured project halt the whole sweep.
 */
export async function runScheduledAudit(ctx: AgentContext): Promise<void> {
  const projects = await listProjects();
  for (const p of projects) {
    if (ctx.signal.aborted) break;
    if (!p.path) continue;
    try {
      await runAudit(p.id, p.path, ctx);
    } catch (e) {
      log.warn("Scheduled audit failed for project", { projectId: p.id, error: String(e) });
    }
  }
}
