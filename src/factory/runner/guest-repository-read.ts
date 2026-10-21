import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  FACTORY_GUEST_MATERIAL_LIMITS,
  FACTORY_GUEST_REPOSITORY_READ_RESPONSE_SCHEMA_VERSION,
  FACTORY_REPOSITORY_TREE_SCHEMA_VERSION,
  validateFactoryGuestRepositoryReadRequest,
  type FactoryGuestRepositoryRead,
  type FactoryGuestRepositoryReadRefusal,
  type FactoryGuestRepositoryReadResponse,
} from "@ezcorp/factory-sdk";
import { canonicalizeJson } from "@ezcorp/factory-sdk/canonical";
import type { FactoryAttemptMaterials, FactoryMaterialIdentity } from "../artifact-materials";
import { factoryMaterialDigest } from "../artifact-materials";
import type { FactoryAttemptAuthority } from "../executions";
import { ReferenceCodeGitReader } from "../reference-code/git-reader";
import { ReferenceCodeSnapshotError, referenceCodeFilesToWire } from "../reference-code/snapshot";

/**
 * The repository-read broker operation (W4H-28 P2): a guest names a declared source and one commit;
 * the host plane fetches it with its own credential and seals the complete tree for the guest.
 *
 * C05 keeps every credential on the host: a guest has no network and holds no token, so a live
 * repository can reach it only through this operation. The fetch runs git with no global or system
 * configuration, no terminal prompt, and the source's token, when it has one, as an HTTP header set
 * through git's environment configuration, never in an argument list or a log line. The tree is read
 * with the product's own git reader (`cat-file`, `ls-tree`, `cat-file --batch`; nothing checked out)
 * and sealed as a material of the attempt, under the operation the guest named, in the scope the
 * VERIFIED attempt token proves. The guest reads it back with the material read frame.
 */

const FETCH_TIMEOUT_MS = 120_000;
const CHUNK_BYTES = FACTORY_GUEST_MATERIAL_LIMITS.maxChunkBytes;

/** One repository the installation declares: a handle, a URL, and optionally a token file by reference. */
export interface FactoryRepositorySource {
  readonly name: string;
  /** `https://…` or, for an operator's local repository, `file://…`. */
  readonly url: string;
  readonly tokenPath?: string;
}

export interface FactoryGuestRepositoryReadOptions {
  readonly sources: readonly FactoryRepositorySource[];
  /** A private directory the host keeps one bare clone per source in. */
  readonly cacheRoot: string;
  /** The attempt's own material service, built from its verified authority. */
  readonly materials: (authority: FactoryAttemptAuthority) => FactoryAttemptMaterials;
  /** Reads a token file privately; its bytes never reach a log or a refusal. */
  readonly readToken: (path: string) => Promise<string>;
  readonly git?: string;
  readonly now?: () => number;
}

export interface FactoryGuestRepositoryReadBroker {
  frame(authority: FactoryAttemptAuthority, payload: unknown): Promise<FactoryGuestRepositoryReadResponse>;
}

class FactoryRepositoryReadError extends Error {
  constructor(readonly code: FactoryGuestRepositoryReadRefusal, message: string) {
    super(message);
    this.name = "FactoryRepositoryReadError";
  }
}

/** Runs git with no ambient configuration; extra configuration (a token header) travels in the environment. */
function git(binary: string, cwd: string, args: readonly string[], config: Readonly<Record<string, string>> = {}): Promise<{ status: number; stderr: string }> {
  const entries = Object.entries(config);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd, stdio: ["ignore", "ignore", "pipe"], timeout: FETCH_TIMEOUT_MS,
      env: {
        PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: String(entries.length),
        ...Object.fromEntries(entries.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])),
      },
    });
    const stderr: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => { stderr.push(chunk.toString("utf8")); });
    child.on("error", reject);
    child.on("close", status => { resolve({ status: status ?? -1, stderr: stderr.join("").slice(-2_000) }); });
  });
}

/** Fetches exactly one commit of one source into its private bare clone, and returns the clone's path. */
async function fetchCommit(options: FactoryGuestRepositoryReadOptions, source: FactoryRepositorySource, commitSha: string): Promise<string> {
  const binary = options.git ?? "git";
  const path = join(options.cacheRoot, createHash("sha256").update(source.name).digest("hex").slice(0, 32));
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await git(binary, path, ["init", "--quiet", "--bare"])).status !== 0) throw new FactoryRepositoryReadError("repository_unavailable", `the cache of ${source.name} could not be initialized`);
  if ((await git(binary, path, ["cat-file", "-e", `${commitSha}^{commit}`])).status === 0) return path;
  const header: Record<string, string> = source.tokenPath === undefined ? {} : { "http.extraHeader": `Authorization: Basic ${Buffer.from(`x-access-token:${(await options.readToken(source.tokenPath)).trim()}`).toString("base64")}` };
  // Protocol v2 serves a want for any commit the remote holds; only that commit's history is fetched.
  const fetched = await git(binary, path, ["-c", "protocol.version=2", "fetch", "--quiet", "--no-tags", "--depth=1", source.url, commitSha], header);
  if (fetched.status !== 0) {
    // A remote that answers but does not hold the commit is the commit's fault, not the source's.
    if (/not our ref|couldn't find remote ref|unadvertised object|no such remote ref/i.test(fetched.stderr)) throw new FactoryRepositoryReadError("repository_commit_unknown", `${source.name} holds no commit ${commitSha}`);
    throw new FactoryRepositoryReadError("repository_unavailable", `${source.name} could not be fetched`);
  }
  return path;
}

/** The complete tree at one commit, as the sealed material carries it. */
async function treeBytes(path: string, binary: string, commitSha: string): Promise<Uint8Array> {
  const reader = new ReferenceCodeGitReader({ repositoryPath: path, git: binary });
  try {
    const { treeSha } = await reader.resolveCommit(commitSha);
    const entries = await reader.readTree(commitSha);
    const committedAtSeconds = await reader.committedAtSeconds(commitSha);
    const files = referenceCodeFilesToWire(entries.map(entry => ({ path: entry.path, mode: entry.mode as "100644", content: entry.content })));
    return new TextEncoder().encode(canonicalizeJson({ schemaVersion: FACTORY_REPOSITORY_TREE_SCHEMA_VERSION, commitSha, treeSha, committedAtSeconds, files } as never));
  } catch (error) {
    if (error instanceof ReferenceCodeSnapshotError) {
      throw new FactoryRepositoryReadError(error.code === "reference_code_snapshot_too_large" ? "repository_too_large" : "repository_commit_unknown", error.message.slice(0, 512));
    }
    throw error;
  }
}

/** Seals the tree under the guest's operation, or returns the handle a repeated read already sealed. */
async function seal(materials: FactoryAttemptMaterials, read: FactoryGuestRepositoryRead, bytes: Uint8Array): Promise<{ artifactId: string; digest: string }> {
  const identity: FactoryMaterialIdentity = { ...materials.scope(read.operationId), objectName: `repository/${read.commitSha}.json`, version: 1 };
  const existing = (await materials.list(materials.scope(read.operationId))).find(record => record.objectName === identity.objectName && record.version === 1);
  if (existing?.sealed && existing.artifact) return { artifactId: existing.artifact.artifactId, digest: existing.digest };
  const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
  await materials.begin(identity, "application/json", bytes.byteLength, chunkCount);
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = bytes.subarray(index * CHUNK_BYTES, Math.min((index + 1) * CHUNK_BYTES, bytes.byteLength));
    await materials.writeChunk(identity, { index, digest: factoryMaterialDigest(chunk), encodedBytes: chunk.byteLength }, chunk);
  }
  const digest = factoryMaterialDigest(bytes);
  const artifact = await materials.seal(identity, digest);
  return { artifactId: artifact.artifactId, digest };
}

function refused(operationId: string, code: FactoryGuestRepositoryReadRefusal, message: string): FactoryGuestRepositoryReadResponse {
  return Object.freeze({ schemaVersion: FACTORY_GUEST_REPOSITORY_READ_RESPONSE_SCHEMA_VERSION, status: "refused", operationId, refusal: Object.freeze({ code, message }) });
}

/** The broker: one verified attempt authority and one frame in, a sealed tree's handle or a named refusal out. */
export function createFactoryGuestRepositoryReadBroker(options: FactoryGuestRepositoryReadOptions): FactoryGuestRepositoryReadBroker {
  const sources = new Map(options.sources.map(source => [source.name, source]));
  const now = options.now ?? Date.now;
  return Object.freeze({
    async frame(authority: FactoryAttemptAuthority, payload: unknown): Promise<FactoryGuestRepositoryReadResponse> {
      const operationId = typeof (payload as { operationId?: unknown } | null)?.operationId === "string" ? (payload as { operationId: string }).operationId.slice(0, 1_024) : "unknown";
      const validation = validateFactoryGuestRepositoryReadRequest(payload);
      if (!validation.ok) return refused(operationId || "unknown", "invalid_request", validation.issues[0]?.message ?? "A repository read is invalid.");
      const read = payload as FactoryGuestRepositoryRead;
      if (authority.deadlineAt.getTime() <= now()) return refused(read.operationId, "deadline_expired", "This attempt's deadline has passed; it may read nothing more.");
      const source = sources.get(read.source);
      if (source === undefined) return refused(read.operationId, "repository_source_unknown", `This installation declares no repository source named ${read.source}.`);
      try {
        const bytes = await treeBytes(await fetchCommit(options, source, read.commitSha), options.git ?? "git", read.commitSha);
        if (bytes.byteLength > FACTORY_GUEST_MATERIAL_LIMITS.maxTotalBytes) throw new FactoryRepositoryReadError("repository_too_large", `the tree is ${bytes.byteLength} bytes; a guest may read at most ${FACTORY_GUEST_MATERIAL_LIMITS.maxTotalBytes}`);
        const material = await seal(options.materials(authority), read, bytes);
        return Object.freeze({ schemaVersion: FACTORY_GUEST_REPOSITORY_READ_RESPONSE_SCHEMA_VERSION, status: "read", operationId: read.operationId, material });
      } catch (error) {
        if (error instanceof FactoryRepositoryReadError) return refused(read.operationId, error.code, error.message);
        // A git or store fault, never a decision about this attempt: the guest may retry.
        return refused(read.operationId, "unavailable", error instanceof Error ? error.message.slice(0, 512) : "The repository read failed.");
      }
    },
  });
}

/** The answer when this installation declares no repository sources at all. */
export function factoryGuestRepositoryUnconfigured(payload: unknown): FactoryGuestRepositoryReadResponse {
  const operationId = typeof (payload as { operationId?: unknown } | null)?.operationId === "string" ? (payload as { operationId: string }).operationId.slice(0, 1_024) : "unknown";
  return refused(operationId || "unknown", "repository_source_unknown", "This installation declares no repository sources.");
}
