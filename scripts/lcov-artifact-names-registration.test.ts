/**
 * No two coverage artifacts may write the same file name into the coverage gate's merged download (W4H-15).
 *
 * The `Per-file coverage gate` job (ci.yml) downloads every `lcov-cov-*` artifact of its run into ONE folder with
 * `merge-multiple: true` and then merges `coverage-artifacts/*.info`. An artifact that uploads one file puts that
 * file's base name at the folder root, so two producers that both upload `…/lcov.info` overwrite each other and the
 * gate silently loses a producer's records. Hosted run 37743486763 (1b96d2730) lost six of seven: the seven producers
 * in ci.yml and in the reusable db-postgres.yml it calls all uploaded `lcov.info`, and the merged LCOV had no records
 * for factory-orchestrator, factory-transport, the Python runner or the reference image.
 *
 * Its reach: single-file `.info` uploads, whose name the workflow states, in the gate's workflow and the reusable
 * workflows it calls directly. A directory upload (`path: coverage-shard`) carries the names its producer script
 * writes (lcov_<shard>_<leg>.info, lcov_security.info, lcov_web_vitest_<i>.info); the workflow text does not show them.
 */
import { describe, expect, test } from "bun:test";
import { basename, join, resolve } from "node:path";
import { type Workflow, type WorkflowJob, readWorkflows } from "./lib/ci-registration.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const UPLOAD = /^actions\/upload-artifact@/;
const DOWNLOAD = /^actions\/download-artifact@/;
const REUSABLE = /^\.\/\.github\/workflows\/([^/]+\.ya?ml)$/;
/** A matrix expression in an artifact name: the one upload step becomes one artifact per matrix entry. */
const MATRIX = /\$\{\{/;

/** A download step that merges every artifact matching `pattern` into `folder`, and the workflows whose artifacts it sees. */
export interface MergedDownload { readonly where: string; readonly pattern: string; readonly folder: string; readonly run: readonly Workflow[] }

/** Every merging download step. Its run is its own workflow plus each reusable workflow that workflow calls. */
export function mergedDownloads(workflows: readonly Workflow[]): MergedDownload[] {
  return workflows.flatMap((workflow) => {
    const called = new Set(Object.values(workflow.jobs).map((job) => REUSABLE.exec(job.uses ?? "")?.[1]));
    const run = [workflow, ...workflows.filter(({ file }) => called.has(file))];
    return Object.entries(workflow.jobs).flatMap(([id, job]) => (job.steps ?? []).flatMap((step) => {
      const options = step.with ?? {};
      if (!DOWNLOAD.test(step.uses ?? "") || options["merge-multiple"] !== true || typeof options.pattern !== "string") return [];
      return [{ where: `${workflow.file} ${id} (${job.name ?? id})`, pattern: options.pattern, folder: String(options.path ?? "."), run }];
    }));
  });
}

/** One upload the download receives: its artifact name and, for a single `.info` file, the name it writes at the folder root. */
export interface LandedUpload { readonly artifact: string; readonly file?: string }

/** Every upload in the download's run whose artifact name matches the download's pattern. */
export function landedUploads(download: MergedDownload): LandedUpload[] {
  const glob = new Bun.Glob(download.pattern);
  return download.run.flatMap(({ jobs }) => Object.values(jobs).flatMap((job) => (job.steps ?? []).flatMap((step) => {
    const { name, path } = step.with ?? {};
    if (!UPLOAD.test(step.uses ?? "") || typeof name !== "string" || !glob.match(name)) return [];
    return [{ artifact: name, file: typeof path === "string" && path.endsWith(".info") ? basename(path) : undefined }];
  })));
}

/** Each file name that more than one artifact writes into the same merged download, with the artifacts that write it. */
export function lcovNameCollisions(workflows: readonly Workflow[]): string[] {
  return mergedDownloads(workflows).flatMap((download) => {
    const writers = new Map<string, string[]>();
    for (const { artifact, file } of landedUploads(download)) {
      if (file !== undefined) writers.set(file, [...(writers.get(file) ?? []), ...(MATRIX.test(artifact) ? [`${artifact} (every matrix entry)`, ""] : [artifact])]);
    }
    return [...writers]
      .filter(([, artifacts]) => artifacts.length > 1)
      .map(([file, artifacts]) => `${download.where}: ${file} is written into ${download.folder} by ${artifacts.filter(Boolean).sort().join(", ")}`);
  });
}

/** A workflow from YAML text, the way readWorkflows builds one. */
function workflowOf(file: string, text: string): Workflow {
  return { file, text, jobs: (Bun.YAML.parse(text) as { jobs?: Record<string, WorkflowJob> }).jobs ?? {} };
}

const GATE = "ci.yml coverage (Per-file coverage gate)";
/** The seven single-file producers of hosted run 37743486763, each with the file name it now uploads. */
const SINGLE_FILE_PRODUCERS = {
  "lcov-cov-factory-assurance-release": "lcov_factory_assurance_release.info",
  "lcov-cov-factory-compute-admissions": "lcov_factory_compute_admissions.info",
  "lcov-cov-factory-orchestrator": "lcov_factory_orchestrator.info",
  "lcov-cov-factory-pool": "lcov_factory_pool.info",
  "lcov-cov-factory-provisioning": "lcov_factory_provisioning.info",
  "lcov-cov-factory-python": "lcov_factory_python.info",
  "lcov-cov-factory-storage": "lcov_factory_storage.info",
};

describe("coverage artifacts write distinct file names into the gate's merged download (W4H-15)", () => {
  const workflows = readWorkflows(join(REPO_ROOT, ".github/workflows"));

  test("no two lcov-cov-* artifacts write the same file name into the Per-file coverage gate's download", () => {
    expect(lcovNameCollisions(workflows)).toEqual([]);
  });

  test("the gate merges lcov-cov-* from ci.yml and db-postgres.yml, and every single-file producer names its own file", () => {
    const gate = mergedDownloads(workflows).find(({ where }) => where === GATE)!;
    expect(gate).toMatchObject({ pattern: "lcov-cov-*", folder: "coverage-artifacts" });
    expect(gate.run.map(({ file }) => file)).toEqual(["ci.yml", "db-postgres.yml"]);
    const singles = landedUploads(gate).filter((upload) => upload.file !== undefined);
    expect(Object.fromEntries(singles.map(({ artifact, file }) => [artifact, file]))).toEqual(SINGLE_FILE_PRODUCERS);
    expect(singles).toHaveLength(7);
  });

  test("a producer in each workflow put back on lcov.info is red by name", () => {
    const back = (file: string, from: string, to: string) => {
      const workflow = workflows.find((candidate) => candidate.file === file)!;
      expect(workflow.text).toContain(from);
      return workflowOf(file, workflow.text.replace(from, to));
    };
    const red = workflows.map((workflow) =>
      workflow.file === "ci.yml" ? back("ci.yml", "path: coverage-shard/lcov_factory_orchestrator.info", "path: coverage-shard/lcov.info")
      : workflow.file === "db-postgres.yml" ? back("db-postgres.yml", "path: coverage-factory-pool/lcov_factory_pool.info", "path: coverage-factory-pool/lcov.info")
      : workflow);
    expect(lcovNameCollisions(red)).toEqual([`${GATE}: lcov.info is written into coverage-artifacts by lcov-cov-factory-orchestrator, lcov-cov-factory-pool`]);
  });

  test("only a merging download by pattern, its called workflows, single .info files and matching names count", () => {
    const upload = (name: string, path: string) => ({ uses: "actions/upload-artifact@v7", with: { name, path } });
    const download = (options: Record<string, string | boolean>) => ({ steps: [{ uses: "actions/download-artifact@v8", with: { path: "merged", ...options } }] });
    const runs: Workflow[] = [
      { file: "called.yml", text: "", jobs: { producer: { steps: [upload("cov-called", "a/lcov.info")] } } },
      { file: "lonely.yml", text: "", jobs: { producer: { steps: [upload("cov-lonely", "b/lcov.info")] } } },
      {
        file: "main.yml",
        text: "",
        jobs: {
          caller: { uses: "./.github/workflows/called.yml" },
          one: { steps: [upload("cov-one", "c/lcov.info"), upload("other-one", "d/lcov.info"), upload("cov-dir", "coverage-shard")] },
          matrix: { steps: [upload("cov-m-${{ matrix.i }}", "e/lcov_m.info"), upload("cov-n", "f/lcov.json")] },
          merged: download({ pattern: "cov-*", "merge-multiple": true }),
          apart: download({ pattern: "cov-*", "merge-multiple": false }),
          byName: download({ name: "cov-one", "merge-multiple": true }),
        },
      },
    ];
    expect(mergedDownloads(runs).map(({ where, run }) => [where, run.map(({ file }) => file)])).toEqual([["main.yml merged (merged)", ["main.yml", "called.yml"]]]);
    expect(lcovNameCollisions(runs)).toEqual([
      "main.yml merged (merged): lcov.info is written into merged by cov-called, cov-one",
      "main.yml merged (merged): lcov_m.info is written into merged by cov-m-${{ matrix.i }} (every matrix entry)",
    ]);
  });
});
