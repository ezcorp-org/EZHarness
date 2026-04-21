// ── Re-exported pi-ai types ──────────────────────────────────────────
// Downstream code imports from here for convenience

export type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ImageContent,
  ToolCall,
  Context,
  Tool,
  Usage,
  AssistantMessageEvent,
  Model,
} from "@mariozechner/pi-ai";

export type { KnownProvider } from "@mariozechner/pi-ai";

// ── Provider Name ────────────────────────────────────────────────────
// Open-ended string to support all 20+ pi-ai providers

export type ProviderName = string;

// ── Capability & Status ──────────────────────────────────────────────

export type AgentCapability = "llm" | "shell" | "file" | "http" | "agent" | "custom";

export type AgentStatus = "idle" | "running" | "success" | "error" | "cancelled";

// ── Logging ──────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AgentLog {
  timestamp: number;
  level: LogLevel;
  message: string;
}

// ── Provider Interfaces ──────────────────────────────────────────────

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ShellOptions {
  cwd?: string;
  quiet?: boolean;
  timeout?: number;
}

export interface ShellProvider {
  run(command: string, options?: ShellOptions): Promise<ShellResult>;
}

export interface FileProvider {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

// ── Agent Context & Result ───────────────────────────────────────────

export interface AgentContext {
  input: Record<string, unknown>;
  llm: any; // Code-based agents receive an LLM wrapper; typed as any for flexibility
  shell: ShellProvider;
  file: FileProvider;
  log(message: string, level?: LogLevel): void;
  signal: AbortSignal;
  run(agentName: string, input: Record<string, unknown>): Promise<AgentResult>;
  tools?: {
    invoke(toolName: string, input: Record<string, unknown>): Promise<unknown>;
  };
}

export interface AgentResult {
  success: boolean;
  output: unknown;
  error?: string;
}

// ── Input Schema ────────────────────────────────────────────────────

export type InputFieldType = "string" | "text" | "number" | "boolean" | "select" | "file-path" | "custom";

export interface InputField {
  type: InputFieldType;
  label: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  options?: string[];       // for "select" type
  component?: string;       // for "custom" type: filename in web/src/lib/custom/
}

export type InputSchema = Record<string, InputField>;

// ── Agent Definition ─────────────────────────────────────────────────

export interface AgentDefinition {
  name: string;
  description: string;
  capabilities: AgentCapability[];
  inputSchema?: InputSchema;
  execute(ctx: AgentContext): Promise<AgentResult>;
}

// ── Agent Run ────────────────────────────────────────────────────────

export interface AgentRun {
  id: string;
  agentName: string;
  projectId?: string;
  provider?: string;
  status: AgentStatus;
  startedAt: number;
  finishedAt?: number;
  logs: AgentLog[];
  result?: AgentResult;
  memoriesUsed?: { id: string; content: string; category: string }[];
}

// ── Agent Config (declarative) ──────────────────────────────────────

export interface AgentConfig {
  name: string;
  description: string;
  capabilities: AgentCapability[];
  inputSchema?: InputSchema;
  prompt: string;
  outputFormat?: "text" | "json";
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

// ── Pipeline ────────────────────────────────────────────────────────

export interface PipelineStep {
  name: string;
  agent: string;
  input?: Record<string, string>;
  dependsOn?: string[];
}

export interface PipelineDefinition {
  name: string;
  description: string;
  inputSchema?: InputSchema;
  steps: PipelineStep[];
}

export interface PipelineRun {
  id: string;
  pipelineName: string;
  projectId?: string;
  status: AgentStatus;
  startedAt: number;
  finishedAt?: number;
  steps: PipelineStepRun[];
  result?: AgentResult;
}

export interface PipelineStepRun {
  stepName: string;
  runId: string;
  status: AgentStatus;
}

// ── Team Member Types ────────────────────────────────────────────────

/** Sentinel value meaning "use the parent conversation's current model/provider." */
export const CURRENT_MODEL_SENTINEL = "__current__";

export interface TeamMemberOverrides {
  permissionMode?: "ask" | "auto-edit" | "yolo";
  toolRestriction?: "all" | "read-only" | "none";
  modeId?: string;
  allowedTools?: string[];
  deniedTools?: string[];
  provider?: string;
  model?: string;
  systemPromptAppend?: string;
}

export interface TeamMember {
  agentConfigId: string;
  overrides?: TeamMemberOverrides;
  subAgents?: TeamMember[];
}

/**
 * Team-level tool scoping applied to every invoked member of the team.
 * When set (either list non-empty), overrides each member's individual
 * `toolRestriction` / `allowedTools` / `deniedTools`. Orchestration tools
 * (invoke_agent, task tracking, ask_human, scratchpad) are always preserved.
 */
export interface TeamToolScope {
  /** If set & non-empty, only these tool names are available to members. */
  allowedTools?: string[];
  /** Tool names always filtered out (applied after allow list). */
  deniedTools?: string[];
}

// ── Events ───────────────────────────────────────────────────────────

export interface AgentEvents {
  [key: string]: unknown;
  "run:start": { run: AgentRun };
  "run:log": { runId: string; log: AgentLog };
  "run:complete": { run: AgentRun; conversationId?: string };
  "run:error": { run: AgentRun; error: string; conversationId?: string };
  "run:cancel": { run: AgentRun; conversationId?: string };
  "run:status": { runId: string; status: string };
  "run:token": { runId: string; token: string; kind?: "thinking" | "text" };
  "run:usage": {
    runId: string;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
    };
  };
  "pipeline:start": { pipelineRun: PipelineRun };
  "pipeline:step": { pipelineRun: PipelineRun; step: PipelineStepRun };
  "pipeline:complete": { pipelineRun: PipelineRun };
  "pipeline:error": { pipelineRun: PipelineRun; error: string };
  "tool:start": { conversationId: string; extensionId: string; toolName: string; input: unknown; timestamp: number; source?: 'inline' | 'agent-run'; invocationId?: string; cardType?: string; category?: string };
  "tool:complete": { conversationId: string; extensionId: string; toolName: string; output: unknown; duration: number; success: boolean; source?: 'inline' | 'agent-run'; invocationId?: string; cardType?: string };
  "tool:error": { conversationId: string; extensionId: string; toolName: string; error: string; duration: number; source?: 'inline' | 'agent-run'; invocationId?: string; cardType?: string };
  "tool:permission_request": { conversationId: string; toolCallId: string; toolName: string; input: unknown; cardType?: string; category?: string };
  "tool:kill": { toolCallId: string };
  "tool:permission_mode_change": { conversationId: string; mode: string };
  "obs:turn": { conversationId: string; messageId?: string; llmDurationMs: number; toolDurationMs: number; totalDurationMs: number; tokenUsage: { input: number; output: number } };
  "run:turn_saved": { runId: string; conversationId: string; messageId: string; parentMessageId: string | null; content: string };
  "run:turn_text_reset": { runId: string };
  // ── Multi-Agent Orchestration ──
  "agent:spawn": {
    runId: string;
    agentRunId: string;
    subConversationId: string;
    agentName: string;
    agentConfigId: string;
    task: string;
    parentConversationId: string;
  };
  "agent:status": {
    runId: string;
    subConversationId: string;
    agentName: string;
    status: string;
  };
  "agent:complete": {
    runId: string;
    agentRunId: string;
    subConversationId: string;
    agentName: string;
    agentConfigId: string;
    success: boolean;
    resultPreview: string;
    parentConversationId: string;
  };
  // ── Orchestration: Human-in-the-Loop ──
  "orchestrator:human_input": {
    runId: string;
    conversationId: string;
    question: string;
    requestId: string;
  };
  "orchestrator:human_response": {
    requestId: string;
    response: string;
  };
  // ── Task Tracking Panel ──
  "task:snapshot": {
    conversationId: string;
    tasks: Array<{
      id: string;
      title: string;
      description: string;
      status: "pending" | "active" | "completed" | "failed";
      agentId?: string;
      agentName?: string;
      assignments: Array<{
        id: string;
        agentConfigId: string;
        agentName: string;
        isTeam: boolean;
        status: "assigned" | "running" | "completed" | "failed";
        assignedAt: string;
        startedAt?: string;
        completedAt?: string;
        failedAt?: string;
        subConversationId?: string;
        agentRunId?: string;
        resultPreview?: string;
      }>;
      subtasks: Array<{ id: string; title: string; completed: boolean; position: number }>;
      createdAt: string;
      startedAt?: string;
      completedAt?: string;
      failedAt?: string;
      failureReason?: string;
      completionSummary?: string;
      priority: number;
    }>;
    activeTaskId?: string;
  };
  "task:assignment_update": {
    conversationId: string;
    taskId: string;
    assignment: {
      id: string;
      agentConfigId: string;
      agentName: string;
      isTeam: boolean;
      status: "assigned" | "running" | "completed" | "failed";
      assignedAt: string;
      startedAt?: string;
      completedAt?: string;
      failedAt?: string;
      subConversationId?: string;
      agentRunId?: string;
      resultPreview?: string;
    };
  };
  // ── Extension Panel State ──
  "ext:state": {
    extensionId: string;
    extensionName: string;
    state: Record<string, unknown>;
    timestamp: number;
  };
}
