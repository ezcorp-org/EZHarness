import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { posix } from "node:path";

import { getToolOutputLimit, truncateText } from "../tools/output-limits";
import { toolError } from "../tools/types";
import type { SandboxWorkspaceBackend, SandboxWorkspaceBinding } from "./target";

/** The host owns the release, connection, deadline, and mutation identity.
 * This interface only carries declared guest actions and the pinned binding. */
export type WorkspaceGuestAction =
  | "file.stat" | "file.list" | "file.readRange" | "file.writeAtomic"
  | "process.start" | "process.inspect" | "process.readOutput" | "process.cancel";

export interface ProviderSandboxWorkspaceCaller {
  call(input: {
    binding: Readonly<SandboxWorkspaceBinding>;
    toolCallId: string;
    action: WorkspaceGuestAction;
    payload: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

type Reply = Record<string, unknown>;
const FILE_CHUNK_BYTES = 64 * 1024;
const MAX_LIST_PAGES = 100;
const MAX_PROCESS_POLLS = 7_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function object(value: unknown): Reply {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid sandbox provider reply");
  const reply = value as Reply;
  if (reply.ok === false) {
    const error = reply.error as Reply | undefined;
    const failure = new Error(typeof error?.message === "string" ? error.message : "Sandbox provider action failed");
    failure.name = typeof error?.code === "string" ? error.code
      : typeof error?.kind === "string" ? error.kind : "sandbox_provider_error";
    throw failure;
  }
  if (reply.ok !== true) throw new Error("Invalid sandbox provider reply");
  return reply;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid sandbox ${label}`);
  return value;
}

function paramsObject(value: unknown): Reply {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid tool parameters");
  return value as Reply;
}

function guestPath(value: unknown, defaultPath?: string): string {
  const input = value === undefined ? defaultPath : value;
  if (typeof input !== "string" || input.includes("\0") || input.includes("\\") || input.startsWith("/")) {
    throw new Error("Path must be relative to the sandbox workspace");
  }
  const parts = input.split("/");
  if (parts.some(part => part === "..")) throw new Error("Path escapes the sandbox workspace");
  const normalized = posix.normalize(input || ".");
  if (normalized === ".." || normalized.startsWith("../")) throw new Error("Path escapes the sandbox workspace");
  return normalized;
}

function result(text: string, details: Record<string, unknown> = {}): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function boundedNumber(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, max) : fallback;
}

function base64Bytes(value: unknown): Uint8Array {
  return Uint8Array.from(Buffer.from(string(value, "base64 data"), "base64"));
}

function relativeName(parent: string, child: string): string {
  if (parent !== "." && !child.startsWith(`${parent}/`)) throw new Error("Sandbox list escaped its directory");
  const name = parent === "." ? child : child.slice(parent.length + 1);
  if (!name || name.includes("/")) throw new Error("Invalid sandbox directory entry");
  return name;
}

/** Adapts native EZHarness tools to the reviewed guest file/process protocol.
 * The caller must route only to the pinned provider connection. */
export function createProviderSandboxWorkspaceBackend(caller: ProviderSandboxWorkspaceCaller): SandboxWorkspaceBackend {
  return {
    async execute(request) {
      const { binding, toolCallId, signal, onUpdate } = request;
      let actionSequence = 0;
      const call = async (action: WorkspaceGuestAction, payload: Record<string, unknown>): Promise<Reply> => {
        if (signal?.aborted) throw new Error("Sandbox operation aborted");
        return object(await caller.call({
          binding, toolCallId: `${toolCallId}:${++actionSequence}`, action, payload, signal,
        }));
      };
      const stat = async (path: string): Promise<Reply> => {
        const reply = await call("file.stat", { path });
        return objectFile(reply.file);
      };
      const read = async (path: string): Promise<{ text: string; revision: string }> => {
        const file = await stat(path);
        if (file.kind !== "file") throw new Error("Expected a regular file");
        const revision = string(file.revision, "file revision");
        const size = Number(file.sizeBytes);
        if (!Number.isSafeInteger(size) || size < 0 || size > getToolOutputLimit("readFile")) {
          throw new Error("Sandbox file exceeds the read limit");
        }
        const chunks: Uint8Array[] = [];
        for (let offset = 0; offset < Math.max(size, 1); offset += FILE_CHUNK_BYTES) {
          const reply = await call("file.readRange", {
            path, revision, offsetBytes: offset, lengthBytes: FILE_CHUNK_BYTES,
          });
          if (reply.revision !== revision || reply.offsetBytes !== offset) throw new Error("Sandbox file changed during read");
          chunks.push(base64Bytes(reply.dataBase64));
          if (reply.eof === true) break;
          if (chunks.at(-1)?.length === 0) throw new Error("Sandbox file read made no progress");
        }
        return { text: decoder.decode(Buffer.concat(chunks)), revision };
      };
      const list = async (path: string): Promise<Reply[]> => {
        const entries: Reply[] = [];
        let cursor: unknown;
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
          const reply = await call("file.list", { path, limit: 100, ...(cursor ? { cursor } : {}) });
          if (!Array.isArray(reply.entries)) throw new Error("Invalid sandbox file list");
          entries.push(...reply.entries.map(objectFile));
          if (!reply.nextCursor) return entries;
          cursor = reply.nextCursor;
        }
        throw new Error("Sandbox directory exceeds the list limit");
      };
      const run = async (argv: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }> => {
        const deadline = Date.now() + timeoutMs;
        const started = await call("process.start", {
          argv, cwd: ".", user: "workspace", env: [], processDeadlineMs: deadline,
        });
        const processId = string(started.processId, "process ID");
        const bootId = string(started.bootId, "boot ID");
        let cursor: Reply = { sandboxId: binding.workspaceId, processId, bootId, offsetBytes: 0 };
        let stdout = "";
        let stderr = "";
        let truncated = false;
        let terminal: Reply | null = null;
        try {
          for (let poll = 0; poll < MAX_PROCESS_POLLS; poll++) {
            if (signal?.aborted || Date.now() >= deadline) throw new Error(signal?.aborted ? "Command aborted" : "Command timed out");
            const output = await call("process.readOutput", { processId, bootId, cursor, maxBytes: FILE_CHUNK_BYTES });
            if (output.gap) throw new Error("Sandbox process output has a gap");
            if (!Array.isArray(output.chunks)) throw new Error("Invalid sandbox process output");
            for (const chunk of output.chunks) {
              const entry = objectFile(chunk);
              const text = decoder.decode(base64Bytes(entry.dataBase64));
              if (entry.stream === "stdout") stdout += text;
              else if (entry.stream === "stderr") stderr += text;
              else throw new Error("Invalid sandbox process stream");
            }
            if (output.nextCursor || output.cursor) cursor = objectFile(output.nextCursor ?? output.cursor);
            const limit = getToolOutputLimit(request.toolName);
            if (encoder.encode(stdout + stderr).byteLength > limit) {
              stdout = truncateText(stdout + stderr, limit, request.toolName).text;
              stderr = "";
              truncated = true;
              return { stdout, stderr, exitCode: -1, truncated };
            }
            if (onUpdate && stdout) onUpdate(result(stdout, { streaming: true }));
            const inspected = await call("process.inspect", { processId, bootId });
            terminal = objectFile(inspected.process);
            if (["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(String(terminal.state)) && output.eof === true) {
              return { stdout, stderr, exitCode: typeof terminal.exitCode === "number" ? terminal.exitCode : -1, truncated };
            }
            await new Promise<void>(resolve => setTimeout(resolve, 100));
          }
          throw new Error("Sandbox process polling limit reached");
        } finally {
          if (!terminal || !["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(String(terminal.state))) {
            try { await call("process.cancel", { processId, bootId }); } catch { /* Retain the first failure. */ }
          }
        }
      };

      try {
        const params = paramsObject(request.params);
        switch (request.toolName) {
          case "readFile": {
            const path = guestPath(params.path);
            const content = await read(path);
            return result(truncateText(content.text, getToolOutputLimit("readFile"), "readFile").text);
          }
          case "editFile": {
            const path = guestPath(params.path);
            const replacement = string(params.new_string, "replacement text");
            let old: { text: string; revision: string } | null = null;
            try { old = await read(path); } catch (error) {
              if (params.old_string !== undefined || params.lineRange !== undefined
                || !(error instanceof Error && /^(not_found|NOT_FOUND)$/.test(error.name))) throw error;
            }
            let next = replacement;
            if (params.lineRange !== undefined) {
              const range = objectFile(params.lineRange);
              const start = Number(range.startLine);
              const end = Number(range.endLine);
              const lines = old!.text.split("\n");
              if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || start > lines.length) throw new Error("Invalid line range");
              next = [...lines.slice(0, start - 1), ...(replacement ? replacement.split("\n") : []), ...lines.slice(end)].join("\n");
            } else if (params.old_string !== undefined) {
              const before = string(params.old_string, "old text");
              if (!before) throw new Error("old_string is empty");
              const count = old!.text.split(before).length - 1;
              if (!count) throw new Error("old_string not found in file");
              if (count > 1 && params.replace_all !== true) throw new Error(`old_string found ${count} times; set replace_all`);
              next = params.replace_all === true ? old!.text.replaceAll(before, replacement) : old!.text.replace(before, replacement);
            }
            const bytes = encoder.encode(next);
            if (bytes.length > FILE_CHUNK_BYTES) throw new Error("Sandbox atomic edit exceeds 64 KB");
            if (!old && posix.dirname(path) !== ".") {
              const directory = await run(["mkdir", "-p", posix.dirname(path)], 10_000);
              if (directory.exitCode !== 0) throw new Error(directory.stderr || "Could not create sandbox directory");
            }
            await call("file.writeAtomic", {
              path, expectedRevision: old?.revision ?? null,
              dataBase64: Buffer.from(bytes).toString("base64"), byteLength: bytes.length,
              executable: false,
            });
            return result(`Updated ${path}`, { oldContent: old?.text ?? null, newContent: next });
          }
          case "listFiles": {
            const path = guestPath(params.path, ".");
            let entries = await list(path);
            if (typeof params.pattern === "string") {
              const glob = new Bun.Glob(params.pattern);
              entries = entries.filter(entry => glob.match(relativeName(path, string(entry.path, "entry path"))));
            }
            return result(entries.map(entry => `${relativeName(path, string(entry.path, "entry path"))}${entry.kind === "directory" ? "/" : ""}`).join("\n") || "(empty directory)");
          }
          case "readDirectory": {
            const path = guestPath(params.path, ".");
            const maxDepth = boundedNumber(params.depth, 2, 3);
            const lines: string[] = [];
            const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
              const entries = (await list(directory))
                .filter(entry => !relativeName(directory, string(entry.path, "entry path")).startsWith("."))
                .sort((a, b) => (a.kind === b.kind ? String(a.path).localeCompare(String(b.path)) : a.kind === "directory" ? -1 : 1));
              for (const [index, entry] of entries.entries()) {
                const name = relativeName(directory, string(entry.path, "entry path"));
                if (name === "node_modules") continue;
                const last = index === entries.length - 1;
                lines.push(`${prefix}${last ? "└── " : "├── "}${name}${entry.kind === "directory" ? "/" : ""}`);
                if (entry.kind === "directory" && depth < maxDepth) await walk(string(entry.path, "entry path"), prefix + (last ? "    " : "│   "), depth + 1);
              }
            };
            await walk(path, "", 1);
            return result(lines.join("\n") || "(empty directory)");
          }
          case "shell": {
            const command = string(params.command, "command");
            const outcome = await run(["/bin/sh", "-c", command], boundedNumber(params.timeout, 30_000, 600_000));
            const output = outcome.stderr ? `${outcome.stdout}\n${outcome.stderr}` : outcome.stdout;
            return result(output || "(no output)", { ...outcome, streaming: false });
          }
          case "grep": {
            const pattern = string(params.pattern, "search pattern");
            const path = guestPath(params.path, ".");
            const argv = ["rg", "-n", "--color=never"];
            if (params.caseSensitive === false) argv.push("-i");
            if (typeof params.include === "string") argv.push("-g", params.include);
            if (params.noIgnore === true) argv.push("--no-ignore");
            argv.push("--", pattern, path);
            let backend = "rg";
            let output = await run(argv, 30_000);
            if (output.exitCode === 127 || (output.exitCode === -1 && !output.stderr)) {
              backend = "grep";
              const fallback = ["grep", "-RnI", "--color=never"];
              if (params.caseSensitive === false) fallback.push("-i");
              if (typeof params.include === "string") fallback.push(`--include=${params.include}`);
              if (params.noIgnore !== true) {
                for (const name of [".git", "node_modules", "dist", "build", "coverage"]) fallback.push(`--exclude-dir=${name}`);
              }
              fallback.push("-e", pattern, path);
              output = await run(fallback, 30_000);
            }
            if (output.exitCode === 1) return result("No matches found.", { matchCount: 0, pattern });
            if (output.exitCode !== 0) throw new Error(output.stderr || "Sandbox search failed");
            const text = output.stdout.trim();
            return result(text, { matchCount: text ? text.split("\n").length : 0, pattern, backend, truncated: output.truncated });
          }
          case "glob": {
            const pattern = string(params.pattern, "glob pattern");
            const path = guestPath(params.path, ".");
            let output = await run(["rg", "--files", "-g", pattern, "--", path], 30_000);
            if (output.exitCode === 127 || (output.exitCode === -1 && !output.stderr)) {
              output = await run(["find", path, "-type", "f"], 30_000);
              if (output.exitCode === 0) {
                const glob = new Bun.Glob(pattern);
                output.stdout = output.stdout.split("\n").filter(file => glob.match(posix.relative(path, file))).join("\n");
              }
            }
            if (output.exitCode === 1) return result("No files found matching pattern.", { fileCount: 0, truncated: false });
            if (output.exitCode !== 0) throw new Error(output.stderr || "Sandbox glob failed");
            const files = output.stdout.trim().split("\n").filter(Boolean).sort();
            if (!files.length) return result("No files found matching pattern.", { fileCount: 0, truncated: false });
            const maxResults = boundedNumber(params.maxResults, 200, 10_000);
            const truncated = output.truncated || files.length > maxResults;
            const selected = files.slice(0, maxResults);
            return result(selected.join("\n") + (truncated ? `\n[truncated at ${maxResults} results]` : ""), { fileCount: selected.length, truncated });
          }
        }
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function objectFile(value: unknown): Reply {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid sandbox provider data");
  return value as Reply;
}
