/**
 * Shared primitives for CI registration tests.
 *
 * Every `scripts/factory-*-registration.test.ts` asks the same two questions:
 * "does a workflow actually RUN this producer?" and "is this source floored at
 * 100 in the coverage thresholds?". Each file had its own copy of both, so a
 * fix to one (for example, ignoring a needle that only appears in a comment)
 * never reached the others. These are the single definitions.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A required producer: a reviewable label plus the exact text a workflow must contain. */
export type RequiredProducer = readonly [label: string, needle: string];

/**
 * Strip `#` comments so a producer can never be "registered" by a comment that
 * merely mentions it. A `#` inside a quoted string is left alone.
 */
export function workflowCommands(workflow: string): string {
  return workflow
    .split("\n")
    .map((line) => {
      let quote: string | undefined;
      for (let index = 0; index < line.length; index++) {
        const character = line[index]!;
        if (quote) {
          if (character === quote) quote = undefined;
        } else if (character === '"' || character === "'") {
          quote = character;
        } else if (character === "#" && (index === 0 || /\s/.test(line[index - 1]!))) {
          return line.slice(0, index).trimEnd();
        }
      }
      return line;
    })
    .join("\n");
}

/** Labels of every required producer the workflow does not actually run. */
export function missingProducers(workflow: string, required: readonly RequiredProducer[]): string[] {
  const commands = workflowCommands(workflow);
  return required.filter(([, needle]) => !commands.includes(needle)).map(([label]) => label);
}

/** Sources without an exact 100% floor in scripts/coverage-thresholds.json. */
export function missingThresholds(thresholds: string, sources: readonly string[]): string[] {
  return sources.filter((source) => !thresholds.includes(`"${source}": 100`)).map((source) => `${source} threshold`);
}

/**
 * The command a factory storage shard step runs (db-postgres.yml factory-storage). The step names no suite: the
 * command derives its suites from tests/postgres, so a new suite runs in a shard without a list to edit.
 */
export const STORAGE_SHARD_COMMAND = "bun scripts/factory-storage-shard.ts";

/**
 * The storage shards' suites: every suite that no other producer names and that is not a recorded local-only gap.
 * `producers` is every workflow's commands plus the scripts they invoke; the storage step itself names no suite.
 */
export function storageSuites(producers: string, suites: readonly string[], localOnly: readonly string[]): string[] {
  const unnamed = new Set(missingProducers(producers, suites.map((suite) => [suite, suite] as const)));
  return suites.filter((suite) => unnamed.has(suite) && !localOnly.includes(suite));
}

/** `producers` plus the storage suites when its commands run the storage shard command: the suites it really runs. */
export function withStorageSuites(producers: string, storage: readonly string[]): string {
  return workflowCommands(producers).includes(STORAGE_SHARD_COMMAND) ? [producers, ...storage].join("\n") : producers;
}

/** Each suite in no shard or in more than one, and each shard entry that is not a suite. Empty for an exact partition. */
export function shardFindings(suites: readonly string[], shards: readonly (readonly string[])[]): string[] {
  const homes = (suite: string) => shards.flatMap((shard, index) => shard.filter((entry) => entry === suite).map(() => index + 1));
  return [
    ...suites.flatMap((suite) => {
      const found = homes(suite);
      return found.length === 1 ? [] : [found.length === 0 ? `${suite} is in no shard` : `${suite} is in shards ${found.join(", ")}`];
    }),
    ...shards.flatMap((shard, index) => shard.filter((entry) => !suites.includes(entry)).map((entry) => `${entry} in shard ${index + 1} is not a storage suite`)),
  ];
}

/**
 * The literal GitHub expression `${{ <expression> }}` as it appears in workflow text. A test that states workflow text
 * builds it here, so the text is never a plain string that only looks like a JS template.
 */
export function ghExpr(expression: string): string {
  return `\${{ ${expression} }}`;
}

export interface WorkflowStep { readonly id?: string; readonly if?: string; readonly uses?: string; readonly run?: string; readonly name?: string; readonly shell?: string; readonly "continue-on-error"?: boolean | string; readonly env?: Readonly<Record<string, string>>; readonly with?: Readonly<Record<string, string | number | boolean>> }
/** A job runs steps, or calls a reusable workflow (`uses: ./.github/workflows/<file>`). */
export interface WorkflowJob { readonly name?: string; readonly uses?: string; readonly "timeout-minutes"?: number; readonly needs?: string | readonly string[]; readonly strategy?: { readonly matrix?: Readonly<Record<string, unknown>> }; readonly steps?: readonly WorkflowStep[] }
export interface Workflow { readonly file: string; readonly text: string; readonly jobs: Record<string, WorkflowJob> }

/** Every workflow file in `dir`, sorted by name, with its text and its parsed jobs. */
export function readWorkflows(dir: string): Workflow[] {
  return readdirSync(dir).filter((file) => /\.ya?ml$/.test(file)).sort().map((file) => {
    const text = readFileSync(join(dir, file), "utf8");
    return { file, text, jobs: (Bun.YAML.parse(text) as { jobs?: Record<string, WorkflowJob> }).jobs ?? {} };
  });
}

/**
 * A step that runs the backend suite pools: scripts/test.sh or scripts/test-coverage.sh, directly or through their
 * package.json aliases (`bun run test`, `bun run test:coverage`; never `bun run test:sdk` or another `test:*` script).
 */
export function runsBackendSuites(run: string): boolean {
  return /\bscripts\/(?:test|test-coverage)\.sh\b|\bbun run (?:test|test:coverage)(?=\s|$)/m.test(run);
}

/** One step a job must prepare with a shared action, and whether that action ran before it in the same job. */
export interface PreparedStep { readonly where: string; readonly preceded: boolean }

/**
 * Each run step that `needs(run, step)` selects, with whether a step that `prepares` selects ran earlier in the same job.
 * The step is passed too, for a selection that also reads the step's `env` (a host-shard coverage step sets SHARD_INDEX).
 */
export function stepsNeedingPreparation(workflows: readonly Workflow[], prepares: (step: WorkflowStep) => boolean, needs: (run: string, step: WorkflowStep) => boolean): PreparedStep[] {
  const found: PreparedStep[] = [];
  for (const { file, jobs } of workflows) {
    for (const [id, job] of Object.entries(jobs)) {
      let installed = false;
      for (const step of job.steps ?? []) {
        if (prepares(step)) installed = true;
        if (step.run !== undefined && needs(step.run, step)) found.push({ where: `${file} ${id} (${job.name ?? id}): ${step.name ?? step.run.split("\n")[0]}`, preceded: installed });
      }
    }
  }
  return found;
}

/** {@link stepsNeedingPreparation} where the preparation is a shared action (a `uses:` value). */
export function stepsNeedingAction(workflows: readonly Workflow[], action: string, needs: (run: string, step: WorkflowStep) => boolean): PreparedStep[] {
  return stepsNeedingPreparation(workflows, (step) => step.uses === action, needs);
}
