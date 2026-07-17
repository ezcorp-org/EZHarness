import type { WorkflowDefinition } from "../types";
import { parse } from "yaml";
import { logger } from "../logger";
import { validateWorkflow } from "./workflow-validator";

const log = logger.child("workflow");

/**
 * Load YAML workflow definitions from `dir`. Globs both the current
 * `*.workflow.yaml` and the legacy `*.pipeline.yaml` naming (a one-release
 * deprecation — legacy files load but warn). Each file is parsed and run
 * through the shared {@link validateWorkflow}; an invalid file is skipped
 * with a warning (warn-and-continue, never throws) — the same posture as
 * the historical loader, now backed by the full validator.
 */
export async function loadYamlWorkflows(
  dir: string,
): Promise<WorkflowDefinition[]> {
  const workflows: WorkflowDefinition[] = [];

  await scanGlob(dir, "*.workflow.yaml", false, workflows);
  await scanGlob(dir, "*.pipeline.yaml", true, workflows);

  return workflows;
}

async function scanGlob(
  dir: string,
  pattern: string,
  deprecated: boolean,
  out: WorkflowDefinition[],
): Promise<void> {
  const glob = new Bun.Glob(pattern);

  for await (const file of glob.scan({ cwd: dir, absolute: true })) {
    try {
      const content = await Bun.file(file).text();
      const def = parse(content) as WorkflowDefinition;

      const errors = validateWorkflow(def);
      if (errors.length > 0) {
        log.warn("Skipping invalid workflow", { file, errors });
        continue;
      }

      if (deprecated) {
        log.warn(
          "Loaded a *.pipeline.yaml workflow — this suffix is deprecated, rename to *.workflow.yaml",
          { file },
        );
      }

      def.description ??= "";
      out.push(def);
    } catch (err) {
      log.warn("Failed to load workflow", { file, error: String(err) });
    }
  }
}
