import { createHash } from "node:crypto";

/**
 * Local git object identity, so a publication never has to believe the server.
 *
 * Every SHA GitHub returns for a blob, a tree, or a commit is the hash of an object whose bytes
 * are fully determined by what was sent. Computing those hashes here turns "the API answered 200"
 * into "the API stored exactly the object this operation approved": the adapter compares the
 * returned identity with the one it derived, and refuses on any difference.
 *
 * The formats are git's, unchanged: `<type> <byteLength>\0<body>` hashed with SHA-1. Tree entries
 * sort by name with a trailing `/` on directories, which is the one ordering rule that is easy to
 * get wrong and impossible to detect later.
 */

export type FactoryGitFileMode = "100644" | "100755";
const TREE_MODE = "40000";

export class FactoryGitObjectError extends Error {
  constructor(readonly code: "factory_git_path_invalid" | "factory_git_mode_invalid" | "factory_git_tree_conflict" | "factory_git_identity_invalid") {
    super(code);
    this.name = "FactoryGitObjectError";
  }
}

export interface FactoryGitFile {
  readonly path: string;
  readonly mode: FactoryGitFileMode;
  readonly content: Uint8Array;
}

export interface FactoryGitIdentity {
  readonly name: string;
  readonly email: string;
  /** Seconds since the epoch. Fixed, because a moving timestamp moves the commit SHA. */
  readonly atSeconds: number;
  /** `+0000` style. */
  readonly timezone: string;
}

const SHA1 = /^[0-9a-f]{40}$/;

/** Scanned rather than matched, because a control character in a regular expression is itself a lint error. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
const IDENTITY_FORBIDDEN = /[<>\n\0]/;

/** A git object hash: SHA-1 over `<type> <length>\0<body>`. */
export function factoryGitObjectId(type: "blob" | "tree" | "commit", body: Uint8Array): string {
  const header = Buffer.from(`${type} ${body.byteLength}\0`, "utf8");
  return createHash("sha1").update(header).update(body).digest("hex");
}

export function factoryGitBlobId(content: Uint8Array): string {
  return factoryGitObjectId("blob", content);
}

export function assertFactoryGitSha(value: string): string {
  if (typeof value !== "string" || !SHA1.test(value)) throw new FactoryGitObjectError("factory_git_identity_invalid");
  return value;
}

/**
 * Every rule a path in a published tree must satisfy.
 *
 * Absolute paths, `..`, a `.git` component, a backslash, a control character, and an empty
 * component are all refused. They are the shapes that let a tree escape itself once something
 * checks it out, and none of them has a legitimate use in a candidate tree.
 */
export function assertFactoryGitPath(path: string): string {
  if (typeof path !== "string" || path.length < 1 || path.length > 4096) throw new FactoryGitObjectError("factory_git_path_invalid");
  if (path.startsWith("/") || path.includes("\\") || hasControlCharacter(path)) throw new FactoryGitObjectError("factory_git_path_invalid");
  const parts = path.split("/");
  if (parts.some(part => part.length === 0 || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new FactoryGitObjectError("factory_git_path_invalid");
  return path;
}

interface TreeNode {
  readonly directories: Map<string, TreeNode>;
  readonly blobs: Map<string, { readonly mode: FactoryGitFileMode; readonly id: string }>;
}

function emptyNode(): TreeNode { return { directories: new Map(), blobs: new Map() }; }

/** Byte-wise comparison of git's sort keys, where a directory sorts as if it ended with `/`. */
function compareEntries(left: string, right: string): number {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return Buffer.compare(a, b);
}

function writeTree(node: TreeNode): { readonly id: string; readonly body: Uint8Array } {
  const entries: { readonly key: string; readonly mode: string; readonly name: string; readonly id: string }[] = [];
  for (const [name, blob] of node.blobs) entries.push({ key: name, mode: blob.mode, name, id: blob.id });
  for (const [name, child] of node.directories) entries.push({ key: `${name}/`, mode: TREE_MODE, name, id: writeTree(child).id });
  entries.sort((left, right) => compareEntries(left.key, right.key));
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"), Buffer.from(entry.id, "hex"));
  }
  const body = Buffer.concat(parts);
  return { id: factoryGitObjectId("tree", body), body };
}

/**
 * The root tree SHA a complete file list produces.
 *
 * "Complete" is the point: no `base_tree` is involved, so the resulting tree contains exactly the
 * files listed and nothing inherited. A path that is both a file and a directory prefix of another
 * path is a conflict git cannot represent, and it is refused here rather than resolved.
 */
export function factoryGitTreeId(files: readonly FactoryGitFile[]): string {
  const root = emptyNode();
  const seen = new Set<string>();
  for (const file of files) {
    assertFactoryGitPath(file.path);
    if (file.mode !== "100644" && file.mode !== "100755") throw new FactoryGitObjectError("factory_git_mode_invalid");
    if (seen.has(file.path)) throw new FactoryGitObjectError("factory_git_tree_conflict");
    seen.add(file.path);
    const parts = file.path.split("/");
    const name = parts.pop()!;
    let node = root;
    for (const part of parts) {
      if (node.blobs.has(part)) throw new FactoryGitObjectError("factory_git_tree_conflict");
      let child = node.directories.get(part);
      if (!child) { child = emptyNode(); node.directories.set(part, child); }
      node = child;
    }
    if (node.directories.has(name)) throw new FactoryGitObjectError("factory_git_tree_conflict");
    node.blobs.set(name, { mode: file.mode, id: factoryGitBlobId(file.content) });
  }
  return writeTree(root).id;
}

function identityLine(role: "author" | "committer", identity: FactoryGitIdentity): string {
  if (typeof identity.name !== "string" || typeof identity.email !== "string" || !identity.name || !identity.email) throw new FactoryGitObjectError("factory_git_identity_invalid");
  if (IDENTITY_FORBIDDEN.test(identity.name) || IDENTITY_FORBIDDEN.test(identity.email)) throw new FactoryGitObjectError("factory_git_identity_invalid");
  if (!Number.isSafeInteger(identity.atSeconds) || identity.atSeconds < 0) throw new FactoryGitObjectError("factory_git_identity_invalid");
  if (!/^[+-]\d{4}$/.test(identity.timezone)) throw new FactoryGitObjectError("factory_git_identity_invalid");
  return `${role} ${identity.name} <${identity.email}> ${identity.atSeconds} ${identity.timezone}\n`;
}

export interface FactoryGitCommit {
  readonly treeId: string;
  readonly parents: readonly string[];
  readonly author: FactoryGitIdentity;
  readonly committer: FactoryGitIdentity;
  readonly message: string;
}

/**
 * The commit SHA a fixed tree, parent, identity, and message produce.
 *
 * Every field is supplied rather than defaulted, so the same accepted candidate always yields the
 * same commit id. That is what lets the approved request name the exact SHA the publication must
 * create, and lets a lost response be resolved by reading one ref.
 */
export function factoryGitCommitId(commit: FactoryGitCommit): string {
  assertFactoryGitSha(commit.treeId);
  for (const parent of commit.parents) assertFactoryGitSha(parent);
  if (typeof commit.message !== "string" || commit.message.length < 1 || commit.message.includes("\0")) throw new FactoryGitObjectError("factory_git_identity_invalid");
  const header = `tree ${commit.treeId}\n${commit.parents.map(parent => `parent ${parent}\n`).join("")}${identityLine("author", commit.author)}${identityLine("committer", commit.committer)}\n`;
  return factoryGitObjectId("commit", Buffer.concat([Buffer.from(header, "utf8"), Buffer.from(commit.message, "utf8")]));
}
