import { Type } from "@mariozechner/pi-ai";
import { validateTimeout } from "./validate";
import type { BuiltinToolDef } from "./types";
import type { AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { buildStreamTruncationMarker, getToolOutputLimit } from "./output-limits";

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

export function createShellTool(projectPath: string): BuiltinToolDef {
  return {
    name: "shell",
    label: "shell",
    description: "Execute a shell command in the project directory. Streams stdout/stderr in real-time. Supports timeout and abort.",
    category: "execute",
    cardType: "terminal",
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
      console.log("[shell-audit]", { command: params.command, cwd: projectPath, timestamp: new Date().toISOString() });

      const blocked = DANGEROUS_COMMAND_PATTERNS.find((p) => p.test(params.command));
      if (blocked) {
        return {
          content: [{ type: "text" as const, text: `Error: command blocked by security policy` }],
          details: { exitCode: -1, stdout: "", stderr: "Command matches dangerous pattern blocklist", streaming: false, isError: true },
        };
      }

      const timeout = validateTimeout(params.timeout);

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
        let timedOut = false;

        // Race: process completion vs timeout vs external abort
        const result = await Promise.race([
          // Main path: read streams and wait for exit
          (async () => {
            // Read stdout + stderr concurrently
            const [stdoutText, stderrText] = await Promise.all([
              readStream(proc.stdout, MAX_OUTPUT_BYTES, onUpdate),
              new Response(proc.stderr).text(),
            ]);
            output = stdoutText.text;
            truncated = stdoutText.truncated;
            stderr = stderrText;
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
          timedOut = true;
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
