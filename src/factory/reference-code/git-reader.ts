import { spawn } from "node:child_process";
import { assertFactoryGitSha } from "../git-objects";
import { ReferenceCodeSnapshotError, type ReferenceCodeRepositoryReader, type ReferenceCodeTreeEntry } from "./snapshot";

/**
 * A {@link ReferenceCodeRepositoryReader} over a real git repository on disk.
 *
 * Only plumbing commands are used, and only read-only ones: `cat-file` to resolve the commit and
 * its tree, `ls-tree` to list it, `cat-file --batch` to fetch the blobs. Nothing checks anything
 * out, so the snapshot cannot be influenced by a dirty working tree, and nothing writes, so the
 * tenant's repository is never modified by a factory run.
 *
 * The commit is addressed by its full object id followed by `^{commit}`, which makes git refuse a
 * branch name, a tag, or a short prefix. A snapshot of "whatever main points at right now" would
 * make every later identity claim meaningless.
 */

const GIT_TIMEOUT_MS = 60_000;
/** Enough for the supported launch repository; a tree beyond this is refused by the snapshot. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface ReferenceCodeGitOptions {
  readonly repositoryPath: string;
  readonly timeoutMs?: number;
  readonly git?: string;
}

interface GitOutput {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/**
 * Runs one git command and collects its bytes.
 *
 * Output is collected as raw buffers because blob contents are not text; decoding here would
 * corrupt any file that is not UTF-8 and silently change its digest.
 */
function runGit(options: ReferenceCodeGitOptions, args: readonly string[], stdin?: string): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.git ?? "git", args, {
      cwd: options.repositoryPath,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
      // A repository must never be able to run its own code during a read.
      env: { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    });
    const stdout: Buffer[] = [];
    const stderr: string[] = [];
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) { child.kill("SIGKILL"); return; }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr.push(chunk.toString("utf8")); });
    child.on("error", error => { reject(new ReferenceCodeSnapshotError("reference_code_repository_unreadable", String((error as Error).message))); });
    child.on("close", status => {
      if (bytes > MAX_OUTPUT_BYTES) {
        reject(new ReferenceCodeSnapshotError("reference_code_snapshot_too_large", `${bytes} bytes of git output`));
        return;
      }
      resolve({ status: status ?? -1, stdout: Buffer.concat(stdout), stderr: stderr.join("") });
    });
    child.stdin.end(stdin ?? "");
  });
}

/** One `ls-tree -r -z` record: `<mode> <type> <sha>\t<path>`. */
function parseEntry(record: string): { mode: string; sha: string; path: string } {
  const tab = record.indexOf("\t");
  if (tab < 0) throw new ReferenceCodeSnapshotError("reference_code_repository_unreadable", "malformed ls-tree record");
  const [mode, , sha] = record.slice(0, tab).split(" ");
  const path = record.slice(tab + 1);
  if (!mode || !sha || !path) throw new ReferenceCodeSnapshotError("reference_code_repository_unreadable", "malformed ls-tree record");
  return { mode, sha, path };
}

/**
 * Reads every listed blob in one `cat-file --batch` conversation.
 *
 * Batch mode is not an optimization here: one process per blob would make the snapshot's cost
 * depend on the repository's file count in a way a tenant controls, and would give each spawn its
 * own chance to fail halfway through a snapshot that must be all-or-nothing.
 */
async function readBlobs(options: ReferenceCodeGitOptions, shas: readonly string[]): Promise<ReadonlyMap<string, Uint8Array>> {
  if (shas.length === 0) return new Map();
  const unique = [...new Set(shas)];
  const batch = await runGit(options, ["cat-file", "--batch"], `${unique.join("\n")}\n`);
  if (batch.status !== 0) throw new ReferenceCodeSnapshotError("reference_code_repository_unreadable", batch.stderr.trim() || "cat-file --batch failed");
  const contents = new Map<string, Uint8Array>();
  let cursor = 0;
  for (let index = 0; index < unique.length; index += 1) {
    const newline = batch.stdout.indexOf(0x0a, cursor);
    if (newline < 0) throw new ReferenceCodeSnapshotError("reference_code_repository_unreadable", "truncated cat-file batch");
    const [sha, type, size] = batch.stdout.subarray(cursor, newline).toString("utf8").split(" ");
    if (!sha || type !== "blob" || !size) throw new ReferenceCodeSnapshotError("reference_code_repository_unreadable", "unexpected cat-file batch header");
    const length = Number(size);
    if (!Number.isSafeInteger(length) || length < 0) throw new ReferenceCodeSnapshotError("reference_code_repository_unreadable", "unexpected cat-file batch size");
    const start = newline + 1;
    if (start + length > batch.stdout.byteLength) throw new ReferenceCodeSnapshotError("reference_code_repository_unreadable", "truncated cat-file batch");
    contents.set(sha, new Uint8Array(batch.stdout.subarray(start, start + length)));
    // git writes one trailing newline after each object body.
    cursor = start + length + 1;
  }
  return contents;
}

export class ReferenceCodeGitReader implements ReferenceCodeRepositoryReader {
  constructor(private readonly options: ReferenceCodeGitOptions) {}

  async resolveCommit(baseSha: string): Promise<{ commitSha: string; treeSha: string }> {
    assertFactoryGitSha(baseSha);
    const output = await runGit(this.options, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], `${baseSha}^{commit}\n`);
    if (output.status !== 0) throw new ReferenceCodeSnapshotError("reference_code_repository_unreadable", output.stderr.trim() || "cat-file failed");
    const [commitSha, type] = output.stdout.toString("utf8").trim().split(" ");
    if (type !== "commit" || !commitSha) throw new ReferenceCodeSnapshotError("reference_code_base_commit_unknown", baseSha);
    const tree = await runGit(this.options, ["rev-parse", `${commitSha}^{tree}`]);
    if (tree.status !== 0) throw new ReferenceCodeSnapshotError("reference_code_repository_unreadable", tree.stderr.trim() || "rev-parse failed");
    const treeSha = tree.stdout.toString("utf8").trim();
    assertFactoryGitSha(treeSha);
    return { commitSha, treeSha };
  }

  async readTree(commitSha: string): Promise<readonly ReferenceCodeTreeEntry[]> {
    assertFactoryGitSha(commitSha);
    const listing = await runGit(this.options, ["ls-tree", "-r", "-z", "--full-tree", commitSha]);
    if (listing.status !== 0) throw new ReferenceCodeSnapshotError("reference_code_repository_unreadable", listing.stderr.trim() || "ls-tree failed");
    const records = listing.stdout.toString("utf8").split("\0").filter(record => record.length > 0);
    const parsed = records.map(parseEntry);
    // A submodule has no blob to read; it is listed so the snapshot can refuse it by name.
    const contents = await readBlobs(this.options, parsed.filter(entry => entry.mode !== "160000").map(entry => entry.sha));
    return parsed.map(entry => ({
      path: entry.path,
      mode: entry.mode,
      content: contents.get(entry.sha) ?? new Uint8Array(),
    }));
  }
}
