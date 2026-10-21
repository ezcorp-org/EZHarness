import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { digestBytes } from "../../extensions/v4/digest";
import { referenceCodeFilesDigest, type ReferenceCodeFile } from "./snapshot";

/**
 * The writable disposable copy the protected checks run in.
 *
 * C10 is specific about this: validation runs on a disposable copy whose input tree digest is
 * verified, while the canonical candidate and its protected assets stay read-only. So the copy is
 * written, then read back and re-digested before a single command runs — a check that ran against
 * bytes other than the accepted candidate's would produce evidence for a tree nobody approved.
 *
 * Protected assets are chmod'ed read-only inside the copy and re-digested after every command. That
 * turns "the protected test file was not tampered with" from a promise into a measurement: a test
 * script that rewrites its own assertions is caught by the second digest, not by trust.
 */

export type ReferenceCodeWorkspaceErrorCode =
  | "reference_code_workspace_digest_mismatch"
  | "reference_code_workspace_path_escape"
  | "reference_code_workspace_protected_modified";

export class ReferenceCodeWorkspaceError extends Error {
  constructor(readonly code: ReferenceCodeWorkspaceErrorCode, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ReferenceCodeWorkspaceError";
  }
}

export interface ReferenceCodeCommandResult {
  readonly command: readonly string[];
  readonly exitCode: number;
  /** Combined stdout and stderr, truncated. Evidence, not a transcript. */
  readonly output: string;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface ReferenceCodeCommandRunner {
  run(command: readonly string[], options: { readonly cwd: string; readonly timeoutMs: number }): Promise<ReferenceCodeCommandResult>;
}

export const REFERENCE_CODE_OUTPUT_LIMIT = 64 * 1024;

/**
 * Ends a check command's whole process group. A group that already ended is not an error: the
 * budget can run out after the last process exited but before the runner observed `close`.
 */
export function killReferenceCodeProcessGroup(leader: number): void {
  try { process.kill(-leader, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

/**
 * Runs one check command and records what it did.
 *
 * The exit code is captured from the process itself rather than from a pipeline, because a piped
 * command reports the exit status of the last stage: `bun run typecheck | tail` exits zero for a
 * compiler that found errors, which would turn a failing typecheck into a passing claim.
 */
export class ReferenceCodeProcessRunner implements ReferenceCodeCommandRunner {
  constructor(private readonly environment: Readonly<Record<string, string>> = {}) {}

  run(command: readonly string[], options: { cwd: string; timeoutMs: number }): Promise<ReferenceCodeCommandResult> {
    const [executable, ...args] = command;
    if (!executable) throw new TypeError("a check command needs an executable");
    const startedAt = Date.now();
    return new Promise(resolvePromise => {
      // The command leads its own process group, so the budget ends every process it started. A
      // descendant left alive holds the output pipe, and `close` would wait for it.
      const child = spawn(executable, args, {
        cwd: options.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...this.environment },
      });
      const chunks: string[] = [];
      let length = 0;
      let truncated = false;
      let timedOut = false;
      const collect = (chunk: Buffer): void => {
        if (length >= REFERENCE_CODE_OUTPUT_LIMIT) { truncated = true; return; }
        const text = chunk.toString("utf8");
        chunks.push(text.slice(0, REFERENCE_CODE_OUTPUT_LIMIT - length));
        length += text.length;
        if (length > REFERENCE_CODE_OUTPUT_LIMIT) truncated = true;
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const timer = setTimeout(() => { timedOut = true; killReferenceCodeProcessGroup(child.pid!); }, options.timeoutMs);
      const settle = (exitCode: number): void => {
        clearTimeout(timer);
        resolvePromise({ command: [...command], exitCode, output: chunks.join(""), truncated, durationMs: Date.now() - startedAt, timedOut });
      };
      child.on("error", error => { chunks.push(String((error as Error).message)); settle(-1); });
      child.on("close", code => { settle(code ?? -1); });
    });
  }
}

export interface ReferenceCodeWorkspace {
  readonly root: string;
  /** The digest measured by reading the copy back, not the one the caller declared. */
  readonly verifiedDigest: string;
  /** Re-reads the protected assets and refuses if any byte moved. */
  assertProtectedUnchanged(): Promise<void>;
  dispose(): Promise<void>;
}

function insideRoot(root: string, path: string): string {
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new ReferenceCodeWorkspaceError("reference_code_workspace_path_escape", path);
  }
  return absolute;
}

/** The package directories under one `node_modules`, scoped ones as `@scope/name`. */
async function toolchainPackages(modules: string): Promise<string[]> {
  const packages: string[] = [];
  for (const entry of (await readdir(modules, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (!entry.name.startsWith("@")) { packages.push(entry.name); continue; }
    for (const scoped of (await readdir(join(modules, entry.name), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (scoped.isDirectory()) packages.push(`${entry.name}/${scoped.name}`);
    }
  }
  return packages;
}

/**
 * Links a pinned, read-only toolchain into a disposable copy (W4H-28, the toolchain claims lane).
 *
 * A sandboxed validator has no network and a `noexec` `/tmp`. Its toolchain is the validator
 * package's own locked dependency set, which the guest runtime stages read-only and executable at
 * the package root. The copy gets a `node_modules` of links to it, and a `.bin` of links to each
 * package's declared binaries: a link in `/tmp` to an executable on another mount runs, so the
 * candidate's own scripts (`tsc --noEmit`) resolve exactly as a frozen install would lay them out.
 * The candidate's lockfile is then checked against this set offline by `bun install --frozen-lockfile`.
 */
export async function linkReferenceCodeToolchain(root: string, toolchain: string): Promise<void> {
  const modules = join(toolchain, "node_modules");
  const target = join(root, "node_modules");
  await mkdir(join(target, ".bin"), { recursive: true });
  for (const name of await toolchainPackages(modules)) {
    if (name.includes("/")) await mkdir(join(target, dirname(name)), { recursive: true });
    await symlink(join(modules, name), join(target, name));
    const manifest = JSON.parse(await readFile(join(modules, name, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
    const bins = typeof manifest.bin === "string" ? { [name.split("/").at(-1)!]: manifest.bin } : manifest.bin ?? {};
    for (const [bin, path] of Object.entries(bins)) await symlink(join(modules, name, path), join(target, ".bin", bin));
  }
}

/**
 * Materializes a complete tree into a fresh disposable directory.
 *
 * The digest is verified by reading every file back off the filesystem. Comparing the bytes that
 * were written would only prove this function can remember its own argument.
 */
export async function materializeReferenceCodeWorkspace(input: {
  readonly files: readonly ReferenceCodeFile[];
  readonly expectedDigest: string;
  readonly protectedPaths: readonly string[];
  readonly prefix?: string;
  /** A read-only directory holding the pinned toolchain's `node_modules` (W4H-28); linked, never copied. */
  readonly toolchain?: string;
}): Promise<ReferenceCodeWorkspace> {
  const root = await mkdtemp(join(tmpdir(), input.prefix ?? "ezcorp-reference-code-"));
  try {
    for (const file of input.files) {
      const absolute = insideRoot(root, file.path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, file.content);
      await chmod(absolute, file.mode === "100755" ? 0o755 : 0o644);
    }
    const readBack: ReferenceCodeFile[] = [];
    for (const file of input.files) {
      readBack.push({ path: file.path, mode: file.mode, content: new Uint8Array(await readFile(insideRoot(root, file.path))) });
    }
    const verifiedDigest = referenceCodeFilesDigest(readBack);
    if (verifiedDigest !== input.expectedDigest) {
      throw new ReferenceCodeWorkspaceError("reference_code_workspace_digest_mismatch", `${verifiedDigest} is not ${input.expectedDigest}`);
    }
    if (input.toolchain !== undefined) await linkReferenceCodeToolchain(root, input.toolchain);
    const sealed = new Map<string, string>();
    for (const path of input.protectedPaths) {
      const file = readBack.find(entry => entry.path === path);
      if (!file) continue;
      sealed.set(path, digestBytes(file.content));
      await chmod(insideRoot(root, path), 0o444);
    }
    return {
      root,
      verifiedDigest,
      async assertProtectedUnchanged(): Promise<void> {
        for (const [path, digest] of sealed) {
          const current = digestBytes(new Uint8Array(await readFile(insideRoot(root, path))));
          if (current !== digest) throw new ReferenceCodeWorkspaceError("reference_code_workspace_protected_modified", path);
        }
      },
      async dispose(): Promise<void> { await rm(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
