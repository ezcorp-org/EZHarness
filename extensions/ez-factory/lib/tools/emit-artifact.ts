/**
 * `emit_artifact` — publish a run's work product under the extension's own
 * data directory.
 *
 * Destination is fixed, never supplied:
 * `<projectRoot>/.ezcorp/extension-data/ez-factory/artifacts/<runId>/<name>`.
 * The caller contributes two SLUGS, and the path is assembled from them —
 * so a traversal is not "rejected by a check", it is unrepresentable. A
 * `name` of `../../etc/passwd` never reaches a join, because `/` is not in
 * the slug alphabet at all. `src/extensions/CLAUDE.md` makes
 * `.ezcorp/extension-data/<name>/` the binding home for extension state,
 * and the subprocess sandbox grants exactly that directory read-write
 * (`src/extensions/subprocess.ts` pushes it onto `rwPaths`).
 *
 * ── This tool does NOT sanitize, and that is the point ─────────────────
 *
 * `content` here is whatever a pipeline computed — and if it came from the
 * repository, it came through `read_files`, which already sanitized and
 * redacted it. Re-running the sanitizer would double-frame text that is
 * already framed and would flatten a draft an agent deliberately
 * formatted. The invariant is stated at the READ boundary precisely so
 * that every downstream consumer can be written this simply.
 * `emit-artifact.test.ts` pins the consequence: a secret present in the
 * source file is already `[REDACTED]` by the time it is written here.
 */
import { join } from "node:path";

import {
  ARTIFACT_DIR_SEGMENTS,
  MAX_ARTIFACT_NAME_LEN,
  MAX_RUN_ID_LEN,
  ToolInputError,
  type ToolDeps,
  type ToolOutcome,
  assertSlug,
  optionalString,
  requireContent,
  requireObject,
  requireSlug,
  runIdFromConversation,
  runTool,
  writeAndDescribe,
} from "./shared";

export const EMIT_ARTIFACT_TOOL = "emit_artifact";

/** Project-root-relative directory a run's artifacts live in. Exported so
 *  a console page can link to it without re-deriving the layout. */
export function artifactDir(runId: string): string {
  return [...ARTIFACT_DIR_SEGMENTS, runId].join("/");
}

export function createEmitArtifact(deps: ToolDeps) {
  return async function emitArtifact(input: unknown): Promise<ToolOutcome> {
    return runTool(EMIT_ARTIFACT_TOOL, async () => {
      const args = requireObject(input);
      const projectRoot = deps.projectRoot();
      // `runId` is DERIVED, not required. A workflow template has no way
      // to name its own run — the ref language has no `$run.*` root — so
      // it comes from the host's conversation coordinate, which a run
      // cannot forge. An explicit `runId` overrides for a chat-driven
      // call, and is then as untrusted as `name`: same slug validation.
      const explicitRunId = optionalString(args, "runId");
      const runId =
        explicitRunId !== undefined && explicitRunId !== ""
          ? assertSlug(explicitRunId, "runId", MAX_RUN_ID_LEN)
          : derivedRunId(deps);
      const name = requireSlug(args, "name", MAX_ARTIFACT_NAME_LEN);
      const content = requireContent(args, "content");

      const relPath = `${artifactDir(runId)}/${name}`;
      const absPath = join(projectRoot, ...ARTIFACT_DIR_SEGMENTS, runId, name);

      return writeAndDescribe(deps, absPath, relPath, content);
    });
  };
}

/**
 * The run id the host bound to this call, validated as a path segment.
 *
 * Rejects rather than inventing a fallback. A call with no workflow run
 * and no explicit `runId` has no partition to write into, and dropping
 * every such artifact into a shared directory would let two runs
 * overwrite each other's output with nothing reporting it.
 */
function derivedRunId(deps: ToolDeps): string {
  const runId = runIdFromConversation(deps.conversationId());
  if (runId === undefined) {
    throw new ToolInputError(
      "no-run-context",
      'no workflow run is bound to this call, so there is no artifact directory to write into — pass an explicit "runId"',
    );
  }
  return assertSlug(runId, "runId", MAX_RUN_ID_LEN);
}
