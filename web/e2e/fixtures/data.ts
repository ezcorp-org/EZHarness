import type { Agent, Run, Project, Conversation, Message, Pipeline, AgentConfig, ProviderStatus } from "../../src/lib/api.js";

let idCounter = 0;
const nextId = () => `test-${++idCounter}`;

export function makeProject(overrides: Partial<Project> = {}): Project {
	const id = overrides.id ?? nextId();
	return {
		id,
		name: "Test Project",
		path: "/tmp/test-project",
		icon: null,
		variables: {},
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
	return {
		name: overrides.name ?? "test-agent",
		description: "A test agent for e2e tests",
		capabilities: ["test"],
		source: "file",
		id: null,
		prompt: null,
		category: null,
		...overrides,
	};
}

export function makeRun(overrides: Partial<Run> = {}): Run {
	return {
		id: overrides.id ?? nextId(),
		agentName: "test-agent",
		status: "success",
		startedAt: "2026-01-01T00:00:00.000Z",
		logs: [],
		...overrides,
	};
}

export function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
	return {
		id: overrides.id ?? nextId(),
		projectId: overrides.projectId ?? "proj-1",
		title: "Test Conversation",
		model: null,
		provider: null,
		systemPrompt: null,
		agentConfigId: null,
		modeId: null,
		test: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

export interface ModeData {
	id: string;
	name: string;
	slug: string;
	icon: string | null;
	description: string;
	systemPromptInstruction: string;
	instructionPosition: "prepend" | "append" | "replace";
	preferredModel: string | null;
	preferredProvider: string | null;
	preferredThinkingLevel: string | null;
	temperature: number | null;
	toolRestriction: "all" | "read-only" | "none";
	builtin: boolean;
}

export function makeMode(overrides: Partial<ModeData> = {}): ModeData {
	return {
		id: overrides.id ?? nextId(),
		name: "Test Mode",
		slug: "test-mode",
		icon: null,
		description: "A test mode",
		systemPromptInstruction: "You are in test mode.",
		instructionPosition: "prepend",
		preferredModel: null,
		preferredProvider: null,
		preferredThinkingLevel: null,
		temperature: null,
		toolRestriction: "all",
		builtin: false,
		...overrides,
	};
}

export function makeMessage(overrides: Partial<Message> = {}): Message {
	return {
		id: overrides.id ?? nextId(),
		conversationId: overrides.conversationId ?? "conv-1",
		role: "user",
		content: "Hello, world!",
		thinkingContent: null,
		model: null,
		provider: null,
		usage: null,
		runId: null,
		parentMessageId: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

export function makePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
	return {
		name: overrides.name ?? "test-pipeline",
		description: "A test pipeline",
		steps: [{ name: "step-1", agent: "test-agent" }],
		...overrides,
	};
}

export function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		id: overrides.id ?? nextId(),
		name: "Test Config",
		description: "A test agent config",
		capabilities: ["test"],
		prompt: "You are a test agent.",
		extensions: null,
		references: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

export interface MemoryData {
	id: string;
	content: string;
	category: string;
	confidence: string;
	status: string;
	projectId: string | null;
	conversationId: string | null;
	messageIds: string[] | null;
	provenance: {
		sourceConversationId?: string;
		sourceMessageIds?: string[];
		extractedAt?: string;
		confidence?: string;
		history?: Array<{
			action: string;
			timestamp: string;
			reason: string;
			previousContent?: string;
		}>;
	} | null;
	lastAccessedAt: string;
	createdAt: string;
	updatedAt: string;
}

export interface KBFileData {
	id: string;
	projectId: string;
	orgScoped: boolean;
	filename: string;
	mimeType: string;
	fileSize: number;
	chunkCount: number;
	status: "processing" | "ready" | "error";
	createdAt: string;
}

export function makeMemory(overrides: Partial<MemoryData> = {}): MemoryData {
	return {
		id: overrides.id ?? nextId(),
		content: "User prefers dark mode",
		category: "preferences",
		confidence: "high",
		status: "active",
		projectId: "proj-1",
		conversationId: "conv-1",
		messageIds: ["msg-1"],
		provenance: {
			sourceConversationId: "conv-1",
			sourceMessageIds: ["msg-1"],
			extractedAt: "2026-01-01T00:00:00.000Z",
			confidence: "high",
			history: [{ action: "created", timestamp: "2026-01-01T00:00:00.000Z", reason: "Extracted" }],
		},
		lastAccessedAt: "2026-01-01T00:00:00.000Z",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

export function makeKBFile(overrides: Partial<KBFileData> = {}): KBFileData {
	return {
		id: overrides.id ?? nextId(),
		projectId: "proj-1",
		orgScoped: false,
		filename: "readme.md",
		mimeType: "text/markdown",
		fileSize: 2048,
		chunkCount: 3,
		status: "ready",
		createdAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

export function makeProviderStatus(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
	return {
		provider: "anthropic",
		hasKey: false,
		source: "none",
		oauthConnected: false,
		oauthExpired: false,
		oauthSupported: false,
		expiresAt: null,
		...overrides,
	};
}

export interface LocalModelCheckResultData {
	reachable: boolean;
	modelAvailable: boolean | null;
	inferenceOk: boolean | null;
	endpointType: "openai-compatible" | "ollama" | null;
	error?: string;
	latencyMs?: number;
}

export function makeLocalModelCheckResult(overrides: Partial<LocalModelCheckResultData> = {}): LocalModelCheckResultData {
	return {
		reachable: true,
		modelAvailable: true,
		inferenceOk: true,
		endpointType: "openai-compatible",
		latencyMs: 150,
		...overrides,
	};
}

export function resetIdCounter() {
	idCounter = 0;
}
