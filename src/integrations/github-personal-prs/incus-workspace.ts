import { createHash, randomUUID } from "node:crypto";
import { validateWorkspacePath } from "@ezcorp/extension-contract";
import type { ProjectCommandRunner } from "../../extensions/project-open-pr";
import { selectProjectSourceFiles } from "../../extensions/project-source-files";
import { withIncusWorkspaceImportAuthority } from "../../infrastructure/incus-workspace-import-authority";
import { IncusWorkspaceCaller } from "../../infrastructure/incus-workspace-caller";
import { createSandboxProjectCommandRunner, sandboxProjectCommand } from "../../runtime/workspaces/project-command-runner";
import type { ProviderSandboxWorkspaceCaller, WorkspaceGuestAction } from "../../runtime/workspaces/provider-backend";
import type { SandboxWorkspaceTarget } from "../../runtime/workspaces/target";
import { WorkspaceTransferError } from "./provider-transfer";
import { SNAPSHOT_LIMITS, validateSnapshot, type SnapshotFileInput, type ValidatedSnapshot } from "./snapshot";

const CHUNK_BYTES = 64 * 1024;
const GIT_PREFIX = ["env", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null", "git",
  "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper="];
const GIT_INIT = [...GIT_PREFIX, "init", "--initial-branch=ezharness-workspace", "--template=", "--", "."];
const EMPTY_SHA = createHash("sha256").update("").digest("hex");
// Paths remain data arguments. Every directory descent rejects symlinks,
// including a directory replaced between mkdir and open.
const CREATE_DIRECTORIES = `import os,sys
root=os.open('.',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 for path in sys.argv[1:]:
  fd=os.dup(root)
  try:
   for name in path.split('/'):
    if name in ('','.','..') or '/' in name or '\\\\' in name: raise ValueError('Unsafe directory')
    try: os.mkdir(name,0o755,dir_fd=fd)
    except FileExistsError: pass
    child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
    os.close(fd)
    fd=child
  finally: os.close(fd)
finally: os.close(root)
`;

type RecordValue = Record<string, unknown>;
type CommandFactory = (target: SandboxWorkspaceTarget, principal: { userId: string }) => ProjectCommandRunner;

function failed(code: WorkspaceTransferError["code"], message: string): never {
  throw new WorkspaceTransferError(code, message);
}

function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) failed("tampered_snapshot", "Invalid Incus transfer response");
  return value as RecordValue;
}

function pathPolicy(path: string): void {
  validateWorkspacePath(path);
  if (path.split("/").some(part => part.startsWith(".ezh-"))) failed("unsupported_workspace", "Repository path is reserved by the Incus helper");
  if (Buffer.byteLength(path) > 240) failed("unsupported_workspace", "Repository path exceeds the Incus transfer limit");
  // Directory entries follow the same source path policy as snapshot files.
  validateSnapshot([{ path, mode: "100644", data: "", sha256: EMPTY_SHA }]);
}

function snapshotInput(snapshot: ValidatedSnapshot): SnapshotFileInput[] {
  return snapshot.files.map(file => ({ path: file.path, mode: file.mode,
    data: Buffer.from(file.bytes).toString("base64"), sha256: file.sha256 }));
}

function prepareImportSnapshot(snapshot: ValidatedSnapshot): ValidatedSnapshot {
  const captured = validateSnapshot(snapshotInput(snapshot));
  if (captured.digest !== snapshot.digest || captured.totalBytes !== snapshot.totalBytes) {
    failed("tampered_snapshot", "Repository snapshot changed before import");
  }
  for (const file of captured.files) {
    pathPolicy(file.path);
    if (file.bytes.length > CHUNK_BYTES) failed("unsupported_workspace", "Repository file exceeds the 64 KiB Incus import limit");
  }
  return captured;
}

/** Whole-snapshot preflight before project/guest creation as well as import effects. */
export function assertIncusImportSnapshot(snapshot: ValidatedSnapshot): void {
  prepareImportSnapshot(snapshot);
}

/** The injectable seam is the existing scoped caller/guest command boundary.
 * Production wrappers below always use the real host-authorized caller. */
export function createIncusSnapshotTransfer(
  caller: ProviderSandboxWorkspaceCaller,
  commandFactory: CommandFactory = createSandboxProjectCommandRunner,
) {
  function context(target: SandboxWorkspaceTarget, userId: string) {
    if (!userId || target.binding.providerId !== "incus" || !target.backend) {
      failed("unsupported_workspace", "The private Incus workspace is unavailable");
    }
    const binding = Object.freeze({ ...target.binding });
    const captured: SandboxWorkspaceTarget = { ...target, binding };
    const operation = randomUUID();
    let sequence = 0;
    const call = async (action: WorkspaceGuestAction, payload: RecordValue): Promise<RecordValue> => {
      const reply = record(await caller.call({ binding, principal: { userId }, action, payload,
        toolCallId: `github-source-${operation}:${++sequence}` }));
      if (reply.ok !== true) failed("provider_failed", "Incus workspace transfer did not complete");
      return reply;
    };
    return { call, command: commandFactory(captured, { userId }) };
  }

  async function readFile(call: ReturnType<typeof context>["call"], file: RecordValue): Promise<SnapshotFileInput> {
    const path = String(file.path);
    pathPolicy(path);
    if (file.kind !== "file" || typeof file.revision !== "string" || !Number.isSafeInteger(file.sizeBytes)
      || Number(file.sizeBytes) < 0 || Number(file.sizeBytes) > SNAPSHOT_LIMITS.fileBytes || typeof file.executable !== "boolean") {
      failed("unsupported_workspace", "Incus source has an unsupported file");
    }
    const size = Number(file.sizeBytes);
    const chunks: Buffer[] = [];
    let offset = 0;
    do {
      const expectedBytes = Math.min(CHUNK_BYTES, size - offset);
      const length = Math.max(1, expectedBytes);
      const reply = await call("file.readRange", { path, revision: file.revision, offsetBytes: offset, lengthBytes: length });
      const bytes = Buffer.from(String(reply.dataBase64), "base64");
      if (reply.path !== path || reply.revision !== file.revision || reply.offsetBytes !== offset
        || typeof reply.dataBase64 !== "string" || bytes.toString("base64") !== reply.dataBase64
        || reply.byteLength !== bytes.length || bytes.length !== expectedBytes
        || reply.eof !== (offset + bytes.length === size)) {
        failed("tampered_snapshot", "Incus source changed during capture");
      }
      chunks.push(bytes);
      offset += bytes.length;
    } while (offset < size);
    const after = record((await call("file.stat", { path })).file);
    if (after.path !== path || after.kind !== "file" || after.revision !== file.revision
      || after.sizeBytes !== size || after.executable !== file.executable) {
      failed("tampered_snapshot", "Incus source changed during capture");
    }
    const bytes = Buffer.concat(chunks);
    return { path, mode: file.executable ? "100755" : "100644", data: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  function sourceRunner(command: ProjectCommandRunner): ProjectCommandRunner {
    return (argv, cwd) => command([...GIT_PREFIX, ...argv.slice(1)], cwd);
  }

  async function exportSnapshot(target: SandboxWorkspaceTarget, userId: string): Promise<ValidatedSnapshot> {
    const { call, command } = context(target, userId);
    const run = sourceRunner(command);
    const paths = await selectProjectSourceFiles(run, ".");
    if (paths.length > SNAPSHOT_LIMITS.files) failed("unsupported_workspace", "Incus source exceeds the file limit");
    paths.forEach(pathPolicy);
    const files: SnapshotFileInput[] = [];
    let totalBytes = 0;
    for (const path of paths) {
      const file = record((await call("file.stat", { path })).file);
      if (file.path !== path || !Number.isSafeInteger(file.sizeBytes) || Number(file.sizeBytes) < 0
        || totalBytes + Number(file.sizeBytes) > SNAPSHOT_LIMITS.totalBytes) {
        failed("unsupported_workspace", "Incus source exceeds the snapshot limit");
      }
      totalBytes += Number(file.sizeBytes);
      files.push(await readFile(call, file));
    }
    const after = await selectProjectSourceFiles(run, ".");
    if (JSON.stringify(after) !== JSON.stringify(paths)) failed("tampered_snapshot", "Incus source selection changed during capture");
    return validateSnapshot(files);
  }

  async function importSnapshot(target: SandboxWorkspaceTarget, userId: string, snapshot: ValidatedSnapshot, operationId?: string): Promise<void> {
    // Validate and copy the entire snapshot before even creating directories.
    const captured = prepareImportSnapshot(snapshot);
    const parents = [...new Set(captured.files.map(file => file.path.split("/").slice(0, -1).join("/")).filter(Boolean))].sort();
    const directoryCommands: string[][] = [];
    for (let offset = 0; offset < parents.length; offset += 32) {
      directoryCommands.push(["python3", "-c", CREATE_DIRECTORIES, ...parents.slice(offset, offset + 32)]);
    }
    const indexCommands: string[][] = [];
    for (let offset = 0; offset < captured.files.length; offset += 32) {
      indexCommands.push([...GIT_PREFIX, "--literal-pathspecs", "add", "--force", "--", ...captured.files.slice(offset, offset + 32).map(file => file.path)]);
    }
    const permittedCommands = [...directoryCommands, GIT_INIT, ...indexCommands,
      ...[["ls-files", "-z"], ["ls-files", "--others", "--exclude-standard", "-z"], ["ls-files", "--deleted", "-z"]]
        .map(argv => [...GIT_PREFIX, ...argv])].map(argv => JSON.stringify(["/bin/sh", "-c", sandboxProjectCommand(argv)]));
    const fileMap = new Map(captured.files.map(file => [file.path, file]));
    const processes = new Set<string>();
    const permits = (action: WorkspaceGuestAction, payload: Readonly<RecordValue>): boolean => {
      if (action === "process.start") {
        return payload.cwd === "." && JSON.stringify(payload.env) === "[]" && permittedCommands.includes(JSON.stringify(payload.argv));
      }
      if (action.startsWith("process.")) return processes.has(JSON.stringify([payload.processId, payload.bootId]));
      if (action === "file.list") return payload.path === ".";
      const file = fileMap.get(String(payload.path));
      if (!file) return false;
      if (action === "file.writeAtomic") return payload.expectedRevision === null && payload.byteLength === file.bytes.length
        && payload.dataBase64 === Buffer.from(file.bytes).toString("base64") && payload.executable === (file.mode === "100755");
      return action === "file.stat" || action === "file.readRange";
    };
    const observed = (action: WorkspaceGuestAction, _payload: Readonly<RecordValue>, result: unknown): void => {
      if (action === "process.start") {
        const reply = record(result);
        if (reply.ok === true && typeof reply.processId === "string" && typeof reply.bootId === "string") {
          processes.add(JSON.stringify([reply.processId, reply.bootId]));
        }
      }
    };
    const work = async (): Promise<void> => {
    const { call, command } = context(target, userId);
    const root = await call("file.list", { path: ".", limit: 1 });
    if (!Array.isArray(root.entries) || root.entries.length !== 0 || root.nextCursor) {
      failed("unsupported_workspace", "Private Incus workspace is not empty");
    }
    for (const argv of directoryCommands) {
      const result = await command(argv, ".");
      if (result.exitCode !== 0) failed("provider_failed", "Private Incus directories could not be created safely");
    }
    for (const file of captured.files) {
      const reply = await call("file.writeAtomic", { path: file.path, expectedRevision: null,
        dataBase64: Buffer.from(file.bytes).toString("base64"), byteLength: file.bytes.length, executable: file.mode === "100755" });
      const observed = record((await call("file.stat", { path: file.path })).file);
      if (reply.path !== file.path || reply.sizeBytes !== file.bytes.length || reply.revision !== observed.revision) {
        failed("tampered_snapshot", "Imported Incus file metadata changed");
      }
      const capturedFile = await readFile(call, observed);
      if (capturedFile.path !== file.path || capturedFile.mode !== file.mode || capturedFile.data !== Buffer.from(file.bytes).toString("base64")) {
        failed("tampered_snapshot", "Imported Incus file bytes changed");
      }
    }
    for (const argv of [GIT_INIT, ...indexCommands]) {
      if ((await command(argv, ".")).exitCode !== 0) failed("provider_failed", "Private Incus source index could not be initialized");
    }
    const verified = await exportSnapshot(target, userId);
    if (verified.digest !== captured.digest) failed("tampered_snapshot", "Imported Incus source selection changed");
    };
    if (operationId) {
      return withIncusWorkspaceImportAuthority({ ownerId: userId, projectId: target.binding.projectId, operationId }, permits, work, observed);
    }
    return work();
  }

  return { importSnapshot, exportSnapshot };
}

export function importIncusSnapshot(target: SandboxWorkspaceTarget, userId: string, snapshot: ValidatedSnapshot, operationId: string): Promise<void> {
  return createIncusSnapshotTransfer(new IncusWorkspaceCaller()).importSnapshot(target, userId, snapshot, operationId);
}

export function exportIncusSnapshot(target: SandboxWorkspaceTarget, userId: string): Promise<ValidatedSnapshot> {
  return createIncusSnapshotTransfer(new IncusWorkspaceCaller()).exportSnapshot(target, userId);
}
