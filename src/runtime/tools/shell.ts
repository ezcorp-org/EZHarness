import { Type } from "@mariozechner/pi-ai";
import { validateTimeout } from "./validate";
import type { BuiltinToolDef } from "./types";
import type { AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { buildStreamTruncationMarker, getToolOutputLimit } from "./output-limits";
import { logger } from "../../logger";
import { detectDevServerCommand } from "../preview/dev-command-detection";

const log = logger.child("shell-tool");

/**
 * Optional preview-launch wiring (Secure User-Site Preview, Phase 3b — the
 * shell-tool spawn trigger). When the conversation owner runs a long-running
 * dev-server command AND the host supports uid-mode previews, the shell tool
 * launches it under the conversation's PREVIEW UID (fs-isolated from
 * .ezcorp/data, uid-attributed for port detection) instead of the normal
 * Bun.spawn path. Threaded from `setup-tools.ts` where conversationId +
 * userId are in scope.
 *
 * Fail-safe: when `launch` returns `{ok:false}` (static mode, pool exhausted,
 * missing helper) the shell tool falls back to the normal execution path, so
 * a host that can't run uid previews behaves exactly as before. Injected as
 * one object so tests can drive both the detector outcome (via the command
 * string) and the launch result deterministically.
 */
export interface ShellPreviewWiring {
  conversationId: string;
  userId: string;
  /** The orchestration entry point (defaults wired in setup-tools). Returns
   *  a process handle on success; the shell tool supervises it like a
   *  background process. */
  launch: (input: {
    conversationId: string;
    userId: string;
    workDir: string;
    command: string;
    args?: readonly string[];
  }) =>
    | { ok: true; uid: number; process: { pid: number; exited: Promise<number>; kill(signal?: number): void } }
    | { ok: false; reason: string };
}

// Shell's cap lives in TOOL_OUTPUT_LIMITS (output-limits.ts) — keep this a
// reference, not a hardcoded value, so the description and runtime agree.
const MAX_OUTPUT_BYTES = getToolOutputLimit("shell");

const SENSITIVE_ENV_PATTERNS = /SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY/i;

function sanitizeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!SENSITIVE_ENV_PATTERNS.test(key)) {
      env[key] = value;
    }
  }
  return env;
}

const DANGEROUS_COMMAND_PATTERNS = [
  /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/($|\s)/,        // rm -rf / or rm /
  /mkfs\./,                                             // format filesystem
  /dd\s+.*of=\/dev\//,                                  // write to device
  /chmod\s+.*\/etc|\/usr|\/bin|\/sbin/,                 // chmod system dirs
  />\s*\/etc\//,                                         // overwrite /etc files
  /curl.*\|\s*(ba)?sh/,                                  // curl pipe to shell
  /wget.*\|\s*(ba)?sh/,                                  // wget pipe to shell
];

export function createShellTool(projectPath: string, preview?: ShellPreviewWiring): BuiltinToolDef {
  return {
    name: "shell",
    label: "shell",
    description: "Execute a shell command in the project directory. Streams stdout/stderr in real-time. Supports timeout and abort.",
    category: "execute",
    cardType: "terminal",
    // Match the tool's own per-command `timeout` arg cap (600_000ms,
    // enforced by validateTimeout). Bun test/build, package install, and
    // codegen routinely run 2–5+ minutes; the default 90s watchdog
    // deferral would kill them long before the command itself decides to
    // give up. See `.planning/watchdog-builtins-hotfix.md`.
    callTimeoutMs: 600_000,
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: "Timeout in ms (default: 120000, max: 600000)", default: 120000 },
        background: { type: "boolean", description: "Run in background (basic support)", default: false },
      },
      required: ["command"],
    }),
    execute: async (_toolCallId, params: any, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback) => {
      log.debug("shell-audit", { command: params.command, cwd: projectPath, timestamp: new Date().toISOString() });

      const blocked = DANGEROUS_COMMAND_PATTERNS.find((p) => p.test(params.command));
      if (blocked) {
        return {
          content: [{ type: "text" as const, text: `Error: command blocked by security policy` }],
          details: { exitCode: -1, stdout: "", stderr: "Command matches dangerous pattern blocklist", streaming: false, isError: true },
        };
      }

      const timeout = validateTimeout(params.timeout);

      // ── Secure-preview spawn trigger (Phase 3b) ─────────────────────────
      // When this command is a recognized long-running dev server AND the
      // host can run uid-mode previews, launch it under the conversation's
      // preview uid (fs-isolated + uid-attributed) via the orchestration. A
      // refusal (static mode / pool exhausted / missing helper) falls back to
      // the normal Bun.spawn path below — fail-safe, never a hard failure.
      if (preview) {
        const detected = detectDevServerCommand(params.command);
        if (detected) {
          const launched = preview.launch({
            conversationId: preview.conversationId,
            userId: preview.userId,
            workDir: projectPath,
            command: detected.command,
            args: detected.args,
          });
          if (launched.ok) {
            log.info("shell: dev server launched under preview uid", {
              conversationId: preview.conversationId,
              uid: launched.uid,
              pid: launched.process.pid,
              command: detected.command,
            });
            // The dev server is a long-lived supervised process owned by the
            // preview uid; we do NOT block the tool call on its exit (it runs
            // until reaped). Report the launch so the LLM/UI knows it's live.
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Dev server started under secure preview (pid ${launched.process.pid}). ` +
                    `A preview link will appear once it starts listening.`,
                },
              ],
              details: {
                exitCode: 0,
                stdout: "",
                stderr: "",
                streaming: false,
                preview: { launched: true, uid: launched.uid, pid: launched.process.pid },
              },
            };
          }
          // Refused — log + fall through to the normal execution path.
          log.info("shell: preview launch refused, running command normally", {
            conversationId: preview.conversationId,
            reason: launched.reason,
          });
        }
      }

      try {
        const proc = Bun.spawn(["/bin/sh", "-c", params.command], {
          cwd: projectPath,
          stdout: "pipe",
          stderr: "pipe",
          env: sanitizeEnv(),
        });

        let output = "";
        let stderr = "";
        let truncated = false;

        // Race: process completion vs timeout vs external abort
        const result = await Promise.race([
          // Main path: read streams and wait for exit
          (async () => {
            // Read stdout + stderr concurrently. Both streams are bounded by
            // MAX_OUTPUT_BYTES so an unbounded stderr producer can't OOM us.
            // stderr is silent — no streaming callback, so the UI updates
            // remain stdout-only.
            const [stdoutText, stderrText] = await Promise.all([
              readStream(proc.stdout, MAX_OUTPUT_BYTES, onUpdate),
              readStream(proc.stderr, MAX_OUTPUT_BYTES),
            ]);
            output = stdoutText.text;
            truncated = stdoutText.truncated || stderrText.truncated;
            stderr = stderrText.text;
            const exitCode = await proc.exited;
            return { type: "done" as const, exitCode };
          })(),
          // Timeout
          new Promise<{ type: "timeout" }>((resolve) =>
            setTimeout(() => resolve({ type: "timeout" }), timeout)
          ),
          // External abort
          ...(signal ? [new Promise<{ type: "aborted" }>((resolve) =>
            signal.addEventListener("abort", () => resolve({ type: "aborted" }), { once: true })
          )] : []),
        ]);

        if (result.type === "timeout") {
          proc.kill();
          return {
            content: [{ type: "text" as const, text: `Command timed out after ${timeout}ms\n${output}` }],
            details: { exitCode: -1, stdout: output, stderr, streaming: false, timeout: true },
          };
        }

        if (result.type === "aborted") {
          proc.kill();
          return {
            content: [{ type: "text" as const, text: `Command aborted\n${output}` }],
            details: { exitCode: -1, stdout: output, stderr, streaming: false, aborted: true },
          };
        }

        const fullOutput = stderr ? `${output}\n${stderr}` : output;
        return {
          content: [{ type: "text" as const, text: fullOutput || "(no output)" }],
          details: { exitCode: result.exitCode, stdout: output, stderr, streaming: false, truncated },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e.message}` }],
          details: { exitCode: -1, stdout: "", stderr: e.message, streaming: false, isError: true },
        };
      }
    },
  };
}

async function readStream(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onUpdate?: AgentToolUpdateCallback,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: "", truncated: false };

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      if (output.length + chunk.length > maxBytes) {
        output += chunk.slice(0, maxBytes - output.length);
        truncated = true;
        // Stop draining the stream; closing the reader will SIGPIPE the
        // child process on its next write, terminating unbounded producers.
        break;
      }
      output += chunk;

      if (onUpdate) {
        onUpdate({
          content: [{ type: "text", text: output }],
          details: { streaming: true },
        });
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (truncated) {
    output += buildStreamTruncationMarker("shell", maxBytes);
  }

  return { text: output, truncated };
}
