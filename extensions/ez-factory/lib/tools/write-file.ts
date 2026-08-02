/**
 * `write_file` — write one file inside the active project, optionally
 * under a compare-and-swap precondition.
 *
 * ── Why `ifMatch` exists ───────────────────────────────────────────────
 *
 * A factory pipeline is a read → think → write loop, and the `think` step
 * is an LLM that may take minutes. Nothing stops a person (or a second
 * run of the same job — jobs are install-wide) from editing the file in
 * between. Without a precondition the pipeline silently reverts their
 * edit and reports success. `ifMatch` turns that into a failed step with
 * both hashes in the message.
 *
 * It is OPTIONAL rather than mandatory because the common case — writing
 * a file the pipeline just created under `artifacts/` — has nothing to
 * compare against, and a mandatory precondition would only train authors
 * to pass a hash they did not check.
 *
 * ── Why 4 MB is safe here and 200 KB is the ceiling for `read_files` ───
 *
 * This tool's STEP OUTPUT is `{path, bytes, sha256}` — tens of bytes,
 * whatever the payload. The large value only ever appears in
 * `workflow_step_runs.resolved_input`, which is pure telemetry: a resume
 * recomputes the mapping from `cursor` + `stepResults` and never reads it
 * (`MAX_RESOLVED_INPUT_BYTES`'s own doc comment). Truncation there costs
 * an operator trace detail and costs correctness nothing.
 */
import {
  ToolInputError,
  type ToolDeps,
  type ToolOutcome,
  optionalString,
  requireContent,
  requireObject,
  requireString,
  resolveWithinRoot,
  runTool,
  sha256Hex,
  writeAndDescribe,
} from "./shared";

export const WRITE_FILE_TOOL = "write_file";

/** `ifMatch` value asserting the file does not exist yet. */
export const IF_MATCH_ABSENT = "absent";

const SHA256_RE = /^[0-9a-f]{64}$/;

export function createWriteFile(deps: ToolDeps) {
  return async function writeFile(input: unknown): Promise<ToolOutcome> {
    return runTool(WRITE_FILE_TOOL, async () => {
      const args = requireObject(input);
      const projectRoot = deps.projectRoot();
      const relPath = requireString(args, "path");
      const absPath = resolveWithinRoot(projectRoot, relPath, "path");
      // Over `MAX_WRITE_BYTES` is REJECTED, not truncated — a partially
      // written artifact that reports success is the failure mode
      // invariant E exists to prevent.
      const content = requireContent(args, "content");
      const ifMatch = optionalString(args, "ifMatch");

      if (ifMatch !== undefined) {
        // A malformed precondition is malformed INPUT, not a soft "no
        // precondition". Treating an unparseable hash as "skip the check"
        // would turn a typo into a silent blind overwrite.
        if (ifMatch !== IF_MATCH_ABSENT && !SHA256_RE.test(ifMatch)) {
          throw new ToolInputError(
            "invalid-input",
            `"ifMatch" must be "${IF_MATCH_ABSENT}" or a 64-char lowercase hex sha256`,
          );
        }
        const exists = await deps.fs.exists(absPath);
        if (ifMatch === IF_MATCH_ABSENT) {
          if (exists) {
            throw new ToolInputError(
              "precondition-failed",
              `"${relPath}" already exists but ifMatch was "${IF_MATCH_ABSENT}"`,
            );
          }
        } else if (!exists) {
          throw new ToolInputError(
            "precondition-failed",
            `"${relPath}" does not exist but ifMatch named a sha256`,
          );
        } else {
          const actual = await sha256Hex(await deps.fs.read(absPath));
          if (actual !== ifMatch) {
            throw new ToolInputError(
              "precondition-failed",
              `"${relPath}" has sha256 ${actual}, not the ${ifMatch} ifMatch named — ` +
                "it changed since it was read; refusing to overwrite",
            );
          }
        }
      }

      return writeAndDescribe(deps, absPath, relPath, content);
    });
  };
}
