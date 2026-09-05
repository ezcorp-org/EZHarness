import type { WorkspaceFile, WorkspaceFiles } from "@ezcorp/extension-contract/types";
import { assertJson, ContractError, isForbiddenJsonKey } from "./json";
export type { WorkspaceFile, WorkspaceFiles, EncodedWorkspaceFile } from "@ezcorp/extension-contract/types";
const encoder = new TextEncoder();

export function isWorkspaceTextPath(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?|json|ya?ml|toml)$/i.test(path);
}

export function validateWorkspacePath(path: string): void {
  if (!path || path.length > 240 || path.startsWith("/") || path.includes("\\") || path.includes(":") || Array.from(path).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new ContractError("INVALID_PATH", "Expected a bounded relative file path");
  if (path.split("/").some(part => !part || part === "." || part === ".." || isForbiddenJsonKey(part) || part === "node_modules" || part === ".git")) throw new ContractError("INVALID_PATH", "Unsafe file path");
}

export function validateWorkspaceFiles(value: unknown): WorkspaceFiles {
  return validateFileMap(value, 2000, 20, 128);
}

export function validateArtifactFiles(value: unknown): WorkspaceFiles {
  return validateFileMap(value, 2006, 160, 192);
}

export function workspaceFileBytes(value: WorkspaceFile): Uint8Array {
  if (typeof value === "string") return encoder.encode(value);
  workspaceFileByteLength(value);
  return Uint8Array.from(atob(value.data), character => character.charCodeAt(0));
}

export function workspaceFileByteLength(value: unknown): number {
  if (typeof value === "string") return encoder.encode(value).byteLength;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContractError("INVALID_FILES", "Expected text or an encoded file");
  const file = value as Record<string, unknown>;
  if (Object.keys(file).length !== 3 || !Object.hasOwn(file, "encoding") || !Object.hasOwn(file, "data") || !Object.hasOwn(file, "executable") || file.encoding !== "base64" || typeof file.data !== "string" || typeof file.executable !== "boolean") throw new ContractError("INVALID_FILES", "Invalid encoded file fields");
  if (file.data.length > 224 * 1024 * 1024) throw new ContractError("DATA_LIMIT", "Encoded file exceeds size limit");
  if (file.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw new ContractError("INVALID_FILES", "Expected canonical base64");
  const tail = file.data.slice(-4);
  if (tail && btoa(atob(tail)) !== tail) throw new ContractError("INVALID_FILES", "Non-canonical base64 padding");
  return file.data.length / 4 * 3 - (file.data.endsWith("==") ? 2 : file.data.endsWith("=") ? 1 : 0);
}

export function encodeWorkspaceFile(bytes: Uint8Array, executable = false): WorkspaceFile {
  if (!executable && !bytes.includes(0)) {
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch {}
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return { encoding: "base64", data: btoa(binary), executable };
}

export function workspaceText(value: WorkspaceFile | undefined, path: string): string {
  if (typeof value !== "string") throw new ContractError("INVALID_FILES", "Control and source files must be text", path);
  return value;
}

function validateFileMap(value: unknown, maxFiles: number, maxMiB: number, maxSerializedMiB: number): WorkspaceFiles {
  assertJson(value, maxSerializedMiB * 1024 * 1024);
  if (!value || Array.isArray(value) || typeof value !== "object") throw new ContractError("INVALID_FILES", "Expected file map");
  const entries = Object.entries(value);
  if (entries.length > maxFiles) throw new ContractError("DATA_LIMIT", `File map exceeds ${maxFiles} files`);
  let totalBytes = 0;
  for (const [path, content] of entries) {
    validateWorkspacePath(path);
    totalBytes += workspaceFileByteLength(content);
    if (isWorkspaceTextPath(path)) workspaceText(content as WorkspaceFile, path);
    if (totalBytes > maxMiB * 1024 * 1024) throw new ContractError("DATA_LIMIT", `File map exceeds ${maxMiB} MiB`, path);
    const parts = path.split("/");
    for (let count = 1; count < parts.length; count++) if (Object.hasOwn(value, parts.slice(0, count).join("/"))) throw new ContractError("INVALID_PATH", "File conflicts with directory", path);
  }
  return value as WorkspaceFiles;
}
