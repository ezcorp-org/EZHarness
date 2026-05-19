#!/usr/bin/env bun
// extension-author — bundled extension that scaffolds, validates, and
// stages new EZCorp extensions for the in-app LLM. The reverse-RPC
// `ezcorp/drafts` (host-side: src/extensions/drafts-handler.ts) is the
// only host capability beyond filesystem; the bundled-only allowlist
// gates it.
//
// Storage convention: every draft lands at
//   <projectRoot>/.ezcorp/extension-data/extension-author/drafts/<userId>/<draftId>/
// matching `permissions.filesystem` declared in ezcorp.config.ts.
//
// `create_extension` is HOST-OWNED: it ships the scaffolded file map to
// `ezcorp/drafts.create` and the host materializes the directory +
// files itself (full fs, no sandbox gate). The subprocess does NO
// filesystem ops on the create path — that's what makes the flow
// deterministic and immune to the grant-dir bootstrap deadlock. The
// remaining per-draft fs (read_draft / write_draft_file) still goes
// through `@ezcorp/sdk/runtime`'s host-mediated helpers (the
// sandbox-preload poisons direct `node:fs` access in subprocesses).

import {
  createToolDispatcher,
  fsExists,
  fsRead,
  fsWrite,
  getChannel,
  toolError,
  toolResult,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";
import { scaffoldExtension, type ExtType } from "@ezcorp/sdk";
import { isAbsolute, join, normalize } from "node:path";

// Allowed file paths inside a draft dir. Mirrors the scaffolder's known
// keys plus the `.gitignore` dotfile. Anything else → reject (path-
// traversal defense + manifest stays in lockstep with what the install
// endpoint expects to find).
const ALLOWED_DRAFT_FILES: ReadonlySet<string> = new Set([
  "ezcorp.config.ts",
  "index.ts",
  "index.test.ts",
  "README.md",
  "package.json",
  "tsconfig.json",
  ".gitignore",
]);

/**
 * Strict id-shape gate. We still validate here (defense in depth)
 * even though `ezcorp/drafts.resolveDir` would reject too — bails out
 * the round trip on obvious garbage.
 */
function assertValidDraftId(draftId: unknown): asserts draftId is string {
  if (!draftId || typeof draftId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(draftId)) {
    throw new Error(`Invalid draftId: "${String(draftId)}"`);
  }
}

/**
 * Resolve a draftId → on-disk directory via the host. The host gates
 * on row ownership (`userId` match) and existence, so we NEVER compute
 * the path locally from the draftId (which would let any extension
 * subprocess read any user's drafts, given a leaked id).
 */
async function resolveDraftDir(draftId: string): Promise<string> {
  const resp = await getChannel().request<{ draftDir: string }>("ezcorp/drafts", {
    action: "resolveDir",
    draftId,
  });
  if (!resp || typeof resp.draftDir !== "string" || resp.draftDir.length === 0) {
    throw new Error("Host returned no draftDir");
  }
  return resp.draftDir;
}

function safeJoin(rootDir: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new Error("Path must be relative");
  }
  if (!ALLOWED_DRAFT_FILES.has(relPath)) {
    throw new Error(`Path "${relPath}" not in scaffolder file allowlist`);
  }
  if (relPath.split(/[\\/]/).includes("..")) {
    throw new Error("Path must not contain '..' segments");
  }
  const normalized = normalize(relPath);
  if (normalized !== relPath) {
    throw new Error("Path must be already-normalized");
  }
  return join(rootDir, relPath);
}

// ── Tool handlers ────────────────────────────────────────────────

const create_extension: ToolHandler = async (args) => {
  const a = args as { name?: unknown; type?: unknown; description?: unknown };
  if (typeof a.name !== "string") return toolError("`name` must be a string");
  if (typeof a.type !== "string") return toolError("`type` must be a string");
  if (typeof a.description !== "string") return toolError("`description` must be a string");
  if (!["tool", "skill", "agent", "multi"].includes(a.type)) {
    return toolError(`\`type\` must be one of tool|skill|agent|multi (got ${a.type})`);
  }

  // 1) Scaffold pure → produce file map. Do this first so a bad name/
  //    type fails BEFORE we mint a draft row.
  let result;
  try {
    result = scaffoldExtension({
      name: a.name,
      type: a.type as ExtType,
      description: a.description,
    });
  } catch (err) {
    return toolError(`Scaffold failed: ${(err as Error).message}`);
  }

  // 2) ONE host-owned reverse-RPC: the host mints the `ez_drafts` row
  //    AND materializes `result.files` to disk itself (full fs, no
  //    sandbox gate), then stamps the resolved draftDir into the
  //    payload. The subprocess does NO resolveDir / fsMkdir / fsWrite
  //    here — eliminating the grant-dir bootstrap deadlock and making
  //    the outcome identical for every caller/LLM. The host's
  //    drafts-handler enforces the bundled-only allowlist + the
  //    scaffold-file allowlist on the materialized paths.
  let createResp: { draftId: string; openUrl: string };
  try {
    createResp = await getChannel().request<{ draftId: string; openUrl: string }>(
      "ezcorp/drafts",
      {
        action: "create",
        kind: "extension",
        payload: { name: a.name, type: a.type, mode: "author" },
        files: result.files,
      },
    );
  } catch (err) {
    return toolError(`ezcorp/drafts.create failed: ${(err as Error).message}`);
  }

  return toolResult(
    JSON.stringify({
      draftId: createResp.draftId,
      openUrl: createResp.openUrl,
      name: a.name,
      type: a.type,
    }),
  );
};

const validate_extension: ToolHandler = async (args) => {
  const a = args as { draftId?: unknown };
  try {
    assertValidDraftId(a.draftId);
  } catch (err) {
    return toolError((err as Error).message);
  }

  // resolveDir is the ownership gate — failure here means "not yours
  // / not found / expired". We surface it as a toolError with the
  // same opaque message either way.
  let dir: string;
  try {
    dir = await resolveDraftDir(a.draftId as string);
  } catch (err) {
    return toolError(`Draft not accessible: ${(err as Error).message}`);
  }

  if (!(await fsExists(dir))) {
    return toolError(`Draft directory does not exist: ${a.draftId}`);
  }

  const cfgPath = join(dir, "ezcorp.config.ts");
  if (!(await fsExists(cfgPath))) {
    return toolError(`Draft missing ezcorp.config.ts: ${a.draftId}`);
  }

  // Deterministic, machine-checked acceptance via the HOST. The
  // canonical `verifyExtension` (loadManifest → validateManifestV2 →
  // require smokeTest for tool/multi → sandboxed tool round-trip)
  // lives in src/extensions/ and CANNOT be imported from this
  // sandboxed subprocess. Reverse-RPC `ezcorp/drafts.verify` instead
  // of self-judging with a duplicated subset validator — the LLM gets
  // the host's structured VerifyResult as the verdict, not our own
  // opinion. This is the loop fix: the author path is the only path
  // that yields a real PASS artifact.
  let result: { pass?: boolean; steps?: Array<{ name: string; ok: boolean; detail: string }> };
  try {
    result = await getChannel().request<{
      pass: boolean;
      steps: Array<{ name: string; ok: boolean; detail: string }>;
    }>("ezcorp/drafts", { action: "verify", draftId: a.draftId });
  } catch (err) {
    return toolError(`ezcorp/drafts.verify failed: ${(err as Error).message}`);
  }

  // Surface the full VerifyResult so the LLM sees exactly which step
  // failed (and is not tempted to hallucinate a pass). `ok` mirrors
  // `pass` for backward-compat with callers that keyed on `ok`.
  return toolResult(
    JSON.stringify({
      ok: result.pass === true,
      pass: result.pass === true,
      steps: result.steps ?? [],
    }),
  );
};

// (Removed `validateManifestSubset` — the host-side `verifyExtension`
// reverse-RPC is now the single authoritative gate. A duplicated
// subset validator inside the subprocess is exactly the "self-judged
// acceptance" the loop fix removes; keeping it would let a draft pass
// the subset while failing the canonical validator + smoke round-trip.)

const list_drafts: ToolHandler = async () => {
  // The host returns ONLY the calling user's active drafts (no fs
  // glob — that would surface other users' drafts on a shared
  // install). Owner scoping happens on the host via ctx.userId.
  try {
    const resp = await getChannel().request<{
      drafts: Array<{ draftId: string; name?: string; type?: string; createdAt: number }>;
    }>("ezcorp/drafts", { action: "listForUser" });
    return toolResult(JSON.stringify({ drafts: resp.drafts ?? [] }));
  } catch (err) {
    return toolError(`ezcorp/drafts.listForUser failed: ${(err as Error).message}`);
  }
};

const read_draft: ToolHandler = async (args) => {
  const a = args as { draftId?: unknown };
  try {
    assertValidDraftId(a.draftId);
  } catch (err) {
    return toolError((err as Error).message);
  }

  let dir: string;
  try {
    dir = await resolveDraftDir(a.draftId as string);
  } catch (err) {
    return toolError(`Draft not accessible: ${(err as Error).message}`);
  }
  if (!(await fsExists(dir))) return toolError(`Draft directory does not exist: ${a.draftId}`);

  const files: Record<string, string> = {};
  for (const name of ALLOWED_DRAFT_FILES) {
    const p = join(dir, name);
    if (!(await fsExists(p))) continue;
    try {
      const content = await fsRead(p);
      files[name] = typeof content === "string" ? content : new TextDecoder().decode(content);
    } catch {
      // skip unreadable
    }
  }
  return toolResult(JSON.stringify({ draftId: a.draftId, files }));
};

const write_draft_file: ToolHandler = async (args) => {
  const a = args as { draftId?: unknown; path?: unknown; content?: unknown };
  try {
    assertValidDraftId(a.draftId);
  } catch (err) {
    return toolError((err as Error).message);
  }
  if (typeof a.path !== "string") return toolError("`path` must be a string");
  if (typeof a.content !== "string") return toolError("`content` must be a string");

  let dir: string;
  try {
    dir = await resolveDraftDir(a.draftId as string);
  } catch (err) {
    return toolError(`Draft not accessible: ${(err as Error).message}`);
  }
  if (!(await fsExists(dir))) return toolError(`Draft directory does not exist: ${a.draftId}`);

  let target: string;
  try {
    target = safeJoin(dir, a.path);
  } catch (err) {
    return toolError((err as Error).message);
  }

  try {
    await fsWrite(target, a.content);
  } catch (err) {
    return toolError(`Failed to write file: ${(err as Error).message}`);
  }
  return toolResult(JSON.stringify({ ok: true, path: a.path }));
};

const discard_draft: ToolHandler = async (args) => {
  const a = args as { draftId?: unknown };
  try {
    assertValidDraftId(a.draftId);
  } catch (err) {
    return toolError((err as Error).message);
  }

  // Single round-trip: host consumes the row AND removes the dir
  // recursively. Replaces the previous depth-first fsUnlink loop,
  // which left the directory itself behind because `fsUnlink(dir)`
  // returns EISDIR on POSIX (reviewer C2).
  try {
    const resp = await getChannel().request<{ ok: boolean }>("ezcorp/drafts", {
      action: "discard",
      draftId: a.draftId,
    });
    return toolResult(JSON.stringify({ ok: resp.ok === true }));
  } catch (err) {
    return toolError(`ezcorp/drafts.discard failed: ${(err as Error).message}`);
  }
};

const install_draft: ToolHandler = async (args) => {
  const a = args as { draftId?: unknown };
  try {
    assertValidDraftId(a.draftId);
  } catch (err) {
    return toolError((err as Error).message);
  }

  // Single round-trip. The HOST enforces a mandatory user-approval
  // permission gate on this tool call BEFORE this body runs (the
  // sensitive `ezcorp:extension:install` cap — see tool-executor.ts /
  // permission-engine.ts). If the user declined, the call never
  // reaches here (PermissionDeniedError upstream). The host action
  // then runs the same secure pipeline as the web install form and
  // installs the extension ENABLED so it's immediately testable.
  try {
    const resp = await getChannel().request<{
      ok: boolean;
      extensionId?: string;
      name?: string;
      openUrl?: string;
    }>("ezcorp/drafts", {
      action: "install",
      draftId: a.draftId,
    });
    // Pass `openUrl` through verbatim when the host emitted it (it is
    // the host-revalidated `/extensions/<name>` deep-link — D1/D2).
    // The subprocess does NOT synthesize or rewrite it: a relative
    // same-origin path minted host-side is the only shape the card
    // ever renders. Omitted when the host withheld it.
    return toolResult(
      JSON.stringify({
        ok: resp.ok === true,
        extensionId: resp.extensionId ?? "",
        name: resp.name ?? "",
        ...(typeof resp.openUrl === "string" && resp.openUrl.length > 0
          ? { openUrl: resp.openUrl }
          : {}),
      }),
    );
  } catch (err) {
    return toolError(`ezcorp/drafts.install failed: ${(err as Error).message}`);
  }
};

export const tools: Record<string, ToolHandler> = {
  create_extension,
  validate_extension,
  list_drafts,
  read_draft,
  write_draft_file,
  discard_draft,
  install_draft,
};

if (import.meta.main) {
  const ch = getChannel();
  createToolDispatcher(tools);
  ch.start();
}
