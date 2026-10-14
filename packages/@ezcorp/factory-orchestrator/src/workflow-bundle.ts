/**
 * The factory workflow bundle: made once at image build time, verified at every worker start.
 *
 * Temporal runs workflow code from a webpack bundle. Making that bundle at run
 * time loads webpack and its SWC native addon, and the 1.16.13 addon must first
 * write itself into a writable, executable user cache. The shipped orchestrator
 * container has a read-only root and a noexec /tmp, and that isolation stays: so
 * no compiler runs in production. The image build writes the bundle and a record
 * of its SHA-256 digest beside it; the worker loads the bundle through
 * `loadFactoryWorkflowBundle`, which refuses a missing bundle or one whose bytes
 * do not match the build's record, by name.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Named apart from `workflow-bundle.js`, which `tsc` emits for this module into the same `dist`.
export const FACTORY_WORKFLOW_BUNDLE_FILE = "factory-workflow.bundle.js";
export const FACTORY_WORKFLOW_BUNDLE_RECORD_FILE = "factory-workflow.bundle.json";
export const FACTORY_WORKFLOW_BUNDLE_SCHEMA = "factory.workflow-bundle.v1";

/** Where the image build writes the bundle: the package's `dist`, from `src` or from `dist` alike. */
export const FACTORY_WORKFLOW_BUNDLE_DIRECTORY = fileURLToPath(new URL("../dist/", import.meta.url));

export type FactoryWorkflowBundleErrorCode = "factory_workflow_bundle_missing" | "factory_workflow_bundle_record_invalid" | "factory_workflow_bundle_digest_mismatch";

export class FactoryWorkflowBundleError extends Error {
  readonly code: FactoryWorkflowBundleErrorCode;
  constructor(code: FactoryWorkflowBundleErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "FactoryWorkflowBundleError";
  }
}

/** The bundle the worker runs, with the digest it was verified against. */
export interface FactoryWorkflowBundle {
  readonly code: string;
  readonly sha256: string;
}

export interface FactoryWorkflowBundleRecord {
  readonly schemaVersion: typeof FACTORY_WORKFLOW_BUNDLE_SCHEMA;
  readonly sha256: string;
  readonly bytes: number;
}

/** What makes the bundle: Temporal's webpack bundler, injected so only the build entry loads it. */
export type FactoryWorkflowBundler = (options: { readonly workflowsPath: string }) => Promise<{ readonly code: string }>;

export function factoryWorkflowBundleDigest(code: string): string {
  return `sha256:${createHash("sha256").update(code, "utf8").digest("hex")}`;
}

function validRecord(value: unknown): value is FactoryWorkflowBundleRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3 && record.schemaVersion === FACTORY_WORKFLOW_BUNDLE_SCHEMA
    && typeof record.sha256 === "string" && /^sha256:[0-9a-f]{64}$/.test(record.sha256)
    && Number.isSafeInteger(record.bytes) && (record.bytes as number) > 0;
}

async function readText(path: string, what: string): Promise<string> {
  try { return await readFile(path, "utf8"); }
  catch (error) { throw new FactoryWorkflowBundleError("factory_workflow_bundle_missing", `the ${what} ${path} is not readable (${(error as NodeJS.ErrnoException).code ?? "error"})`); }
}

/** Load the build's bundle and refuse it unless its bytes match the build's digest record. */
export async function loadFactoryWorkflowBundle(directory: string = FACTORY_WORKFLOW_BUNDLE_DIRECTORY): Promise<FactoryWorkflowBundle> {
  const recordPath = resolve(directory, FACTORY_WORKFLOW_BUNDLE_RECORD_FILE);
  const recordText = await readText(recordPath, "bundle record");
  let record: unknown;
  try { record = JSON.parse(recordText); } catch { record = undefined; }
  if (!validRecord(record)) throw new FactoryWorkflowBundleError("factory_workflow_bundle_record_invalid", `the bundle record ${recordPath} is malformed`);
  const code = await readText(resolve(directory, FACTORY_WORKFLOW_BUNDLE_FILE), "bundle");
  const sha256 = factoryWorkflowBundleDigest(code);
  if (sha256 !== record.sha256 || Buffer.byteLength(code, "utf8") !== record.bytes) {
    throw new FactoryWorkflowBundleError("factory_workflow_bundle_digest_mismatch", `the bundle in ${directory} is ${sha256}, the build recorded ${record.sha256}`);
  }
  return Object.freeze({ code, sha256 });
}

/** Build time only: bundle the workflow code and write it with its digest record. */
export async function writeFactoryWorkflowBundle(directory: string, bundle: FactoryWorkflowBundler): Promise<FactoryWorkflowBundleRecord> {
  const workflowsPath = fileURLToPath(new URL(`./workflow.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url));
  const { code } = await bundle({ workflowsPath });
  const record: FactoryWorkflowBundleRecord = { schemaVersion: FACTORY_WORKFLOW_BUNDLE_SCHEMA, sha256: factoryWorkflowBundleDigest(code), bytes: Buffer.byteLength(code, "utf8") };
  await mkdir(directory, { recursive: true });
  // The record is written last, through a rename, so a bundle without its record never looks complete.
  await writeFile(resolve(directory, FACTORY_WORKFLOW_BUNDLE_FILE), code);
  const temporary = resolve(directory, `${FACTORY_WORKFLOW_BUNDLE_RECORD_FILE}.tmp`);
  await writeFile(temporary, `${JSON.stringify(record)}\n`);
  await rename(temporary, resolve(directory, FACTORY_WORKFLOW_BUNDLE_RECORD_FILE));
  return record;
}
