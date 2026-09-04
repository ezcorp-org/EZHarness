import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Diagnostic, ResourceLimits, WorkspaceFiles } from "@ezcorp/extension-contract";
import { canonicalJson } from "@ezcorp/extension-contract";

export class RunnerError extends Error {
  constructor(public readonly code: string, message: string, public readonly stage = "runner", public readonly retryable = false) {
    super(message);
    this.name = "RunnerError";
  }
  diagnostic(): Diagnostic {
    return { code: this.code, stage: this.stage, message: this.message, retryable: this.retryable };
  }
}

export const executionLimits: ResourceLimits = Object.freeze({ memoryBytes: 512 * 1024 ** 2, cpuMillis: 1000, pids: 64, tmpBytes: 64 * 1024 ** 2, outputBytes: 1024 ** 2, timeoutMs: 60_000 });
export const buildLimits: ResourceLimits = Object.freeze({ memoryBytes: 2 * 1024 ** 3, cpuMillis: 2000, pids: 128, tmpBytes: 1024 ** 3, outputBytes: 1024 ** 2, timeoutMs: 300_000 });

export function limitsWithin(value: ResourceLimits, ceiling: ResourceLimits): ResourceLimits {
  for (const key of Object.keys(ceiling) as (keyof ResourceLimits)[]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > ceiling[key]) throw new RunnerError("resource_limit_denied", `Invalid ${key} limit`);
  }
  return { ...value };
}

export function relativePath(value: string): string {
  if (!value || value.length > 1024 || value.startsWith("/") || value.includes("\\") || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === ":") || value.split("/").some(part => part === "" || part === "." || part === "..")) throw new RunnerError("invalid_path", "File paths must be bounded relative paths");
  return value;
}

export function validateFiles(files: WorkspaceFiles, maximumBytes = 20 * 1024 ** 2, maximumCount = 2000): void {
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new RunnerError("invalid_files", "Expected file map");
  const entries = Object.entries(files);
  if (entries.length > maximumCount) throw new RunnerError("source_limit", "Too many files");
  let bytes = 0;
  for (const [path, content] of entries) {
    relativePath(path);
    if (typeof content !== "string") throw new RunnerError("invalid_files", "File content must be text");
    bytes += Buffer.byteLength(content);
    if (bytes > maximumBytes) throw new RunnerError("source_limit", "Source bytes exceed policy");
  }
}

export function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function filesDigest(files: WorkspaceFiles): string { return sha256(canonicalJson(files)); }
export function identifier(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new RunnerError("invalid_id", "Invalid runner identifier");
  return value;
}
export function digest(value: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new RunnerError("invalid_digest", "Expected SHA-256 digest");
  return value;
}

export function processSpawn(executable: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, LANG: "C.UTF-8" } });
}

export async function command(executable: string, args: string[], timeoutMs = 30_000, maximumBytes = 1024 ** 2): Promise<string> {
  const child = processSpawn(executable, args);
  return capture(child, timeoutMs, maximumBytes);
}

export async function capture(child: ChildProcessWithoutNullStreams, timeoutMs: number, maximumBytes: number): Promise<string> {
  child.stdin.end();
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    let bytes = 0;
    const stop = (error: Error) => { child.kill("SIGKILL"); reject(error); };
    const timer = setTimeout(() => stop(new RunnerError("command_timeout", "Runner control command timed out")), timeoutMs);
    const collect = (chunk: Buffer, stderr: boolean) => {
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) return stop(new RunnerError("output_limit", "Runner control output exceeded limit"));
      if (stderr) errors += chunk.toString(); else output += chunk.toString();
    };
    child.stdout.on("data", chunk => collect(chunk, false));
    child.stderr.on("data", chunk => collect(chunk, true));
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new RunnerError("command_failed", (errors.trim() || output.trim()).slice(0, 8192) || `Runner control exited ${code}`)); });
  });
}
