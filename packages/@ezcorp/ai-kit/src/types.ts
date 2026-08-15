import { z } from "zod";

// ──────────────────────────────────────────────────────────────────────────────
// Request schemas (mirror web/src/routes/api/**/schema.ts — test/shape.test.ts
// asserts parity)
// ──────────────────────────────────────────────────────────────────────────────

export const createConversationInput = z.object({
  projectId: z.union([z.literal("global"), z.string().uuid()]),
  title: z.string().max(500).optional(),
  model: z.string().max(100).optional(),
  provider: z.string().max(100).optional(),
  agentConfigId: z.string().uuid().optional(),
  test: z.boolean().optional(),
  parentConversationId: z.string().uuid().optional(),
  parentMessageId: z.string().uuid().optional(),
});

export const sendMessageInput = z.object({
  content: z.string().min(1).max(100_000),
  provider: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  parentMessageId: z.string().uuid().optional(),
  editOf: z.string().uuid().optional(),
  permissionMode: z.enum(["ask", "auto-edit", "yolo"]).optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
});

export const generateAgentInput = z.object({
  messages: z
    .array(z.object({ role: z.string().min(1), content: z.string().min(1) }))
    .min(1),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  modeId: z.string().min(1).optional(),
});

export const createAgentInput = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1).max(50_000),
  description: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  category: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  outputFormat: z.enum(["text", "json"]).optional(),
  extensions: z.array(z.string()).optional(),
  references: z
    .object({
      agents: z.array(z.string()).optional(),
      members: z
        .array(
          z.object({
            agentConfigId: z.string(),
            overrides: z.record(z.string(), z.unknown()).optional(),
            subAgents: z.array(z.unknown()).optional(),
          }),
        )
        .optional(),
      autoSpinUp: z.boolean().optional(),
      teamToolScope: z
        .object({
          allowedTools: z.array(z.string()).optional(),
          deniedTools: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
});

export const mentionSearchInput = z.object({
  q: z.string(),
  type: z.enum(["agent", "team", "ext", "path", "cmd"]).optional(),
  projectId: z.union([z.literal("global"), z.string().uuid()]).optional(),
});

export const assignTaskInput = z.object({
  conversationId: z.string().uuid(),
  taskId: z.string(),
  agentConfigId: z.string().uuid(),
  subtaskId: z.string().optional(),
});

export const startAssignmentInput = z.object({
  conversationId: z.string().uuid(),
  taskId: z.string(),
  assignmentId: z.string(),
  model: z.string().optional(),
  provider: z.string().optional(),
});

export const spawnChatsInput = z.object({
  // Hard-capped at 10 per call. Combined with the server-side per-user
  // rate limit on POST /api/conversations (see hooks.server.ts), this
  // keeps an LLM or bundled extension from chaining unbounded fan-out.
  // If a legitimate use case needs more, call spawnChats multiple times
  // — the rate limiter will gate sustained abuse.
  chats: z
    .array(
      z.object({
        projectId: z.union([z.literal("global"), z.string().uuid()]),
        initialMessage: z.string().min(1).max(100_000),
        agentConfigId: z.string().uuid().optional(),
        model: z.string().optional(),
        provider: z.string().optional(),
        title: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(10),
});

// ──────────────────────────────────────────────────────────────────────────────
// Response shapes (interface types; no runtime validation needed on responses)
// ──────────────────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  path: string;
  icon?: string | null;
  variables?: Record<string, string> | null;
}

export interface Conversation {
  id: string;
  projectId: string;
  title?: string | null;
  model?: string | null;
  provider?: string | null;
  agentConfigId?: string | null;
  parentConversationId?: string | null;
  parentMessageId?: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  parentMessageId?: string | null;
  createdAt?: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  description?: string | null;
  prompt: string;
  provider?: string | null;
  model?: string | null;
  category?: string | null;
  references?: unknown;
}

export interface SendMessageResult {
  userMessage: { id: string; role: string; content: string };
  runId: string;
  attachments: unknown[];
}

export interface SpawnChatsResult {
  chats: Array<{ conversationId: string; runId: string }>;
}

export interface MentionHit {
  name: string;
  description?: string;
  kind: "agent" | "extension" | "team" | "file" | "dir" | "command";
  source?: string;
  body?: string;
}

export interface GenerateAgentResult {
  text: string;
  config?: {
    name: string;
    description?: string;
    prompt: string;
    provider?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    category?: string;
  } | null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Runtime events (SSE) — mirrors the canonical list at
// `web/src/lib/runtime-event-names.ts`. The package can't import the app's
// source (it ships standalone), so a parity assertion
// (`test/unit/events.test.ts`, "event-name parity with the app") keeps the
// two in lockstep. Keep them identical.
// ──────────────────────────────────────────────────────────────────────────────

export const RUNTIME_EVENT_NAMES = [
  "run:start", "run:status", "run:log", "run:complete", "run:error", "run:cancel",
  "run:token", "run:usage", "run:turn_saved", "run:turn_text_reset",
  "workflow:start", "workflow:step", "workflow:complete", "workflow:error",
  // A run parked on an `approval` step — drives the pending-decisions tray.
  "workflow:approval_request",
  "tool:start", "tool:complete", "tool:error", "tool:permission_request",
  "agent:spawn", "agent:status", "agent:complete",
  "task:snapshot", "task:assignment_update",
  "ask-user:answer",
  // Ez concierge client-side tool delivery (fill_form / navigate_to).
  "ez:client-tool",
  // Caller-executed tool delivery: the LLM called a `_caller__*` tool the
  // connected client device declared, and the run is parked behind a
  // permission gate until that device POSTs the result back.
  "caller:tool-call",
  "ext:state",
  // Extension Pages Hub: content-free page invalidation signal.
  "ext:page-state",
  // User-scoped live Library refresh (install).
  "extensions:installed",
  // /goal autopilot indicator (conversation-scoped).
  "goal:update",
  // Daily Briefing: server-initiated conversation delivery (user-scoped).
  "conversation:created",
  // Sessions P4 rewind/checkpoint: the conversation's message tree / durable
  // leaf pointer changed (conversation-scoped).
  "conversation:tree-changed",
  // github-projects integration: a proposal was created/decided/finished.
  "github-projects:proposal-update",
  // Loops EZ Mode Phase 2: a loop run parked awaiting approval / was resolved.
  "loops:approval_pending",
  "loops:approval_resolved",
  // Loop auto-disabled after N consecutive errors.
  "loops:auto_disabled",
] as const;

export type RuntimeEventName = (typeof RUNTIME_EVENT_NAMES)[number];

export interface RuntimeEvent {
  /** A future event the app adds before this package's next release is still
   *  assignable — the escape hatch keeps a stale copy from hard-erroring for
   *  consumers; the parity test is what actually keeps the two in sync. */
  type: RuntimeEventName | (string & {});
  data: Record<string, unknown>;
}

export type CreateConversationInput = z.infer<typeof createConversationInput>;
export type SendMessageInput = z.infer<typeof sendMessageInput>;
export type GenerateAgentInput = z.infer<typeof generateAgentInput>;
export type CreateAgentInput = z.infer<typeof createAgentInput>;
export type MentionSearchInput = z.infer<typeof mentionSearchInput>;
export type AssignTaskInput = z.infer<typeof assignTaskInput>;
export type StartAssignmentInput = z.infer<typeof startAssignmentInput>;
export type SpawnChatsInput = z.infer<typeof spawnChatsInput>;
