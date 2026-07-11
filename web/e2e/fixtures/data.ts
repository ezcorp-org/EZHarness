import type { Agent, Run, Project, Conversation, Message, Pipeline, AgentConfig, ProviderStatus, AttachmentSummary, MessageSearchHit } from "../../src/lib/api.js";

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
		parentConversationId: null,
		parentMessageId: null,
		forkedFromConversationId: null,
		forkedFromMessageId: null,
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
	toolRestriction: "all" | "read-only" | "none" | "allowlist";
	/**
	 * Exact tool names granted when toolRestriction === "allowlist" (the
	 * builtin Ez mode's shape). Null for every other restriction value.
	 */
	allowedTools?: string[] | null;
	/**
	 * Phase modes.extensionIds — when non-null/non-empty, the executor
	 * resolves each id to its tool surface and uses the union as the
	 * mode's allowlist. The settings card surfaces the count as an
	 * "{n} extensions" badge for non-builtin modes.
	 */
	extensionIds: string[] | null;
	/**
	 * Per-extension tool subset (extension id → selected tool names). A key
	 * absent here (or mapped to an empty array) means all of that extension's
	 * tools are granted. Null for modes that grant every attached tool.
	 */
	extensionTools?: Record<string, string[]> | null;
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
		extensionIds: null,
		extensionTools: null,
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
		excluded: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

/**
 * Phase 66 — message-grained search hit fixture, mirroring the Phase 65
 * `MessageSearchHit` contract (`src/lib/api.ts`). `createdAt` is a string
 * (JSON-serialized over the wire). Defaults to a lexical hit with a `<mark>`
 * highlight so sidebar/snippet specs render the highlight path by default;
 * override `matchType`/`snippet` for semantic (plain-text) rows.
 */
export function makeSearchHit(overrides: Partial<MessageSearchHit> = {}): MessageSearchHit {
	return {
		conversationId: overrides.conversationId ?? "conv-1",
		conversationTitle: "Test Conversation",
		messageId: overrides.messageId ?? nextId(),
		role: "user",
		createdAt: "2026-01-01T00:00:00.000Z",
		snippet: "a <mark>match</mark> here",
		matchType: "lexical",
		rankLexical: 1,
		rankSemantic: null,
		score: 0.5,
		...overrides,
	};
}

export function makeAttachment(overrides: Partial<AttachmentSummary> = {}): AttachmentSummary {
	const id = overrides.id ?? nextId();
	return {
		id,
		filename: "file.png",
		mimeType: "image/png",
		sizeBytes: 1024,
		kind: "image",
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
		extensionTools: null,
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

/**
 * v1.3 release-readiness — Playwright fixture mirroring the shape returned
 * by `GET /api/extensions` (drizzle `Extension` row + manifest jsonb).
 *
 * Used by `web/e2e/v1.3-permission-backbone.spec.ts` to seed the install /
 * sweep / re-approve journeys. The shape mirrors `src/db/schema.ts`'s
 * `extensions` table plus the `installedPermissions` column added by HIGH 2.
 *
 * `installedPermissions = null` simulates a legacy row (pre-HIGH-2 install)
 * — reapprove falls back to clamping against the manifest. Set a narrower
 * shape than the manifest to exercise the "user-narrowed grant restored"
 * branch from the security review.
 */
export interface ExtensionData {
	id: string;
	name: string;
	version: string;
	description: string;
	enabled: boolean;
	source: string;
	installPath: string | null;
	checksumVerified: boolean;
	consecutiveFailures: number;
	isBundled: boolean;
	manifest: {
		schemaVersion?: number;
		name?: string;
		version?: string;
		description?: string;
		author?: string | { name: string };
		entrypoint?: string | { command: string[] };
		persistent?: boolean;
		tools?: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
		permissions?: Record<string, unknown>;
		acceptsCallerCaps?: boolean;
	};
	/**
	 * HIGH-2 column: the user's install-time NARROWED choice. `null` means
	 * a legacy row (pre-fix install) — the reapprove path falls back to the
	 * manifest. Non-null overrides the manifest as the clamp ceiling.
	 */
	installedPermissions: Record<string, unknown> | null;
	/**
	 * The CURRENT effective grant. Empty object (= "no grants yet") drives
	 * the in-chat PermissionGate's 4-scope chooser the next time the
	 * extension's tool fires. A populated shape with `grantedAt[<cap>]`
	 * older than 90 days simulates a swept grant.
	 */
	grantedPermissions: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export function makeExtension(overrides: Partial<ExtensionData> = {}): ExtensionData {
	const id = overrides.id ?? nextId();
	return {
		id,
		name: "test-extension",
		version: "1.0.0",
		description: "Test fixture extension for v1.3 permission backbone",
		enabled: true,
		source: "local",
		installPath: "/tmp/test-extension",
		checksumVerified: true,
		consecutiveFailures: 0,
		isBundled: false,
		manifest: {
			schemaVersion: 3,
			name: "test-extension",
			version: "1.0.0",
			description: "Test fixture extension for v1.3 permission backbone",
			author: { name: "tester" },
			entrypoint: "./index.ts",
			persistent: false,
			tools: [{ name: "echo", description: "Returns the input verbatim", inputSchema: { type: "object" } }],
			permissions: { network: ["api.test.example.com"] },
		},
		// null = legacy / "use manifest as ceiling" — narrow to a subset to
		// exercise the HIGH-2 "user-narrowed grant restored" branch.
		installedPermissions: null,
		// Empty effective grant — the next tool call surfaces the 4-scope
		// install-time gate. To simulate a post-sweep "expired" state,
		// override `grantedPermissions` with a `grantedAt[cap]` timestamp
		// older than 90 days.
		grantedPermissions: { grantedAt: {} },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

export interface LessonData {
	id: string;
	slug: string;
	title: string;
	body: string;
	visibility: "user" | "project" | "global";
	ownedByMe: boolean;
	source: "user" | "distiller";
	firedCount: number;
	lastFiredAt: string | null;
	dismissedCount: number;
	createdAt: string;
	updatedAt: string;
	frontmatter: Record<string, unknown> | null;
}

export function makeLesson(overrides: Partial<LessonData> = {}): LessonData {
	const id = overrides.id ?? nextId();
	return {
		id,
		slug: "use-bun-not-node",
		title: "Use Bun, not Node",
		body: "Always invoke `bun <file>` instead of `node <file>`.",
		visibility: "user",
		ownedByMe: true,
		source: "distiller",
		firedCount: 0,
		lastFiredAt: null,
		dismissedCount: 0,
		createdAt: "2026-04-01T00:00:00.000Z",
		updatedAt: "2026-04-01T00:00:00.000Z",
		frontmatter: null,
		...overrides,
	};
}

export function resetIdCounter() {
	idCounter = 0;
}
