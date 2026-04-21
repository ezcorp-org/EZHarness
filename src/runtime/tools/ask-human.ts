/**
 * Ask-Human tool — pauses agent execution to surface a question to the user,
 * then waits for their typed response before continuing.
 *
 * Uses a promise-gate pattern (similar to permissions.ts) but resolves with
 * the user's response string rather than void.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import type { EventBus } from "../events";
import type { AgentEvents } from "../../types";

// ── Pending Gate ────────────────────────────────────────────────────

interface PendingHumanInput {
  resolve: (response: string) => void;
  reject: (err: Error) => void;
}

const pendingRequests = new Map<string, PendingHumanInput>();

const HUMAN_INPUT_TIMEOUT_MS = 5 * 60_000; // 5 minutes

// ── Tool Factory ────────────────────────────────────────────────────

export interface AskHumanOpts {
  bus: EventBus<AgentEvents>;
  runId: string;
  conversationId: string;
}

export function createAskHumanTool(opts: AskHumanOpts): AgentTool {
  const { bus, runId, conversationId } = opts;

  return {
    name: "ask_human",
    label: "Ask Human",
    description:
      "Pause execution and ask the user a question. The agent will wait for the user's " +
      "response before continuing. Use this when you need clarification, a decision, or " +
      "information that only the user can provide.",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to present to the user.",
        },
      },
      required: ["question"],
    }),

    async execute(_toolCallId: string, params: any, signal?: AbortSignal) {
      const { question } = params as { question: string };
      const requestId = crypto.randomUUID();

      // Notify the frontend that human input is needed
      bus.emit("orchestrator:human_input", {
        runId,
        conversationId,
        question,
        requestId,
      });

      // Set up abort handling before creating the gate
      const onAbort = () => {
        const pending = pendingRequests.get(requestId);
        if (pending) {
          pendingRequests.delete(requestId);
          pending.reject(new Error("Aborted while waiting for human input"));
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      // Set up timeout
      const timeout = setTimeout(() => {
        const pending = pendingRequests.get(requestId);
        if (pending) {
          pendingRequests.delete(requestId);
          pending.reject(new Error("Timed out waiting for human input"));
        }
      }, HUMAN_INPUT_TIMEOUT_MS);

      try {
        const response = await new Promise<string>((resolve, reject) => {
          pendingRequests.set(requestId, { resolve, reject });
        });

        return {
          content: [{ type: "text" as const, text: response }],
          details: {},
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: { isError: true },
        };
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

// ── Gate Resolution ─────────────────────────────────────────────────

/** Resolve a pending human-input gate with the user's response text. */
export function resolveHumanInput(requestId: string, response: string): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  pending.resolve(response);
}

/** Reject a pending human-input gate (user dismissed without responding). */
export function rejectHumanInput(requestId: string): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  pending.reject(new Error("Human input request was dismissed"));
}

/** Check whether a request is still pending. */
export function hasPendingHumanInput(requestId: string): boolean {
  return pendingRequests.has(requestId);
}
