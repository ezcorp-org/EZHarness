import type { PipelineDefinition } from "../types";
import { parse } from "yaml";
import { logger } from "../logger";
const log = logger.child("pipeline");

export async function loadYamlPipelines(
  dir: string,
): Promise<PipelineDefinition[]> {
  const pipelines: PipelineDefinition[] = [];
  const glob = new Bun.Glob("*.pipeline.yaml");

  for await (const file of glob.scan({ cwd: dir, absolute: true })) {
    try {
      const content = await Bun.file(file).text();
      const def = parse(content) as PipelineDefinition;

      if (!def.name || !Array.isArray(def.steps) || def.steps.length === 0) {
        log.warn("Skipping pipeline: missing required name or steps", { file });
        continue;
      }

      def.description ??= "";
      pipelines.push(def);
    } catch (err) {
      log.warn("Failed to load pipeline", { file, error: String(err) });
    }
  }

  return pipelines;
}
