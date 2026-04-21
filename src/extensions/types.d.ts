export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    cardType?: string;
}
export interface SkillDefinition {
    name: string;
    description: string;
    prompt?: string;
    files?: string[];
}
export type McpTransport = "stdio" | "http" | "sse";
export interface McpServerStdio {
    transport: "stdio";
    name: string;
    description?: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
}
export interface McpServerHttp {
    transport: "http";
    name: string;
    description?: string;
    url: string;
    headers?: Record<string, string>;
}
export interface McpServerSse {
    transport: "sse";
    name: string;
    description?: string;
    url: string;
    headers?: Record<string, string>;
}
export type McpServerDefinition = McpServerStdio | McpServerHttp | McpServerSse;
export interface AgentComponentDefinition {
    prompt: string;
    category?: string;
    capabilities?: string[];
    modelRequirements?: {
        tier: "fast" | "balanced" | "powerful" | "reasoning";
        contextWindow?: number;
    };
    temperature?: number;
    maxTokens?: number;
    outputFormat?: "text" | "json";
    inputSchema?: Record<string, unknown>;
    exampleConversations?: Array<{
        title: string;
        messages: Array<{
            role: "user" | "assistant";
            content: string;
        }>;
    }>;
}
export interface ScriptDefinition {
    postinstall?: string;
    preuninstall?: string;
    commands?: Record<string, {
        entrypoint: string;
        description?: string;
    }>;
}
export interface DependencySpec {
    source: string;
    version: string;
}
export interface ExtensionManifestV2 {
    schemaVersion: 2;
    name: string;
    version: string;
    description: string;
    author: {
        name: string;
        id?: string;
    };
    kind?: "local" | "mcp";
    entrypoint?: string;
    persistent?: boolean;
    tools?: ToolDefinition[];
    skills?: SkillDefinition[];
    mcpServers?: McpServerDefinition[];
    agent?: AgentComponentDefinition;
    scripts?: ScriptDefinition;
    panel?: {
        position: "bottom";
        stateSchema?: Record<string, unknown>;
        defaultCollapsed?: boolean;
    };
    lifecycleHooks?: string[];
    dependencies?: Record<string, DependencySpec>;
    permissions: {
        network?: string[];
        filesystem?: string[];
        shell?: boolean;
        env?: string[];
        lifecycleHooks?: boolean;
        storage?: boolean;
    };
    resources?: {
        memory?: string;
        storage?: string;
    };
    tags?: string[];
    changelog?: string;
    category?: string;
    checksum?: string;
    packageChecksums?: Record<string, string>;
}
export type ExtensionManifest = ExtensionManifestV2;
export type ExtensionPackageType = "agent" | "extension";
export declare function inferPackageType(manifest: ExtensionManifestV2): ExtensionPackageType;
export declare const MARKETPLACE_CATEGORIES: readonly ["Productivity", "Development", "Writing", "Research", "Education", "Creative", "Data & Analysis", "Communication", "Other"];
export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number];
export type ListingStatus = "active" | "flagged" | "removed";
export type FlagStatus = "pending" | "dismissed" | "removed";
export type MarketplaceSortOption = "rating" | "popular" | "newest";
export type PanelComponentType = "header" | "text" | "badge" | "progress" | "status" | "list" | "kv" | "counter" | "divider";
export interface PanelHeader {
    type: "header";
    title: string;
    subtitle?: string;
}
export interface PanelText {
    type: "text";
    content: string;
    variant?: "muted" | "default" | "emphasis";
}
export interface PanelBadge {
    type: "badge";
    label: string;
    color?: "blue" | "green" | "red" | "yellow" | "purple" | "gray";
}
export interface PanelProgress {
    type: "progress";
    value: number;
    label?: string;
}
export interface PanelStatus {
    type: "status";
    label: string;
    state: "idle" | "running" | "success" | "error" | "warning";
}
export interface PanelListItem {
    label: string;
    status?: "pending" | "active" | "completed" | "failed";
    detail?: string;
    badge?: string;
    badgeColor?: PanelBadge["color"];
}
export interface PanelList {
    type: "list";
    items: PanelListItem[];
}
export interface PanelKV {
    type: "kv";
    pairs: {
        key: string;
        value: string;
    }[];
}
export interface PanelCounter {
    type: "counter";
    label: string;
    value: number;
    total?: number;
}
export interface PanelDivider {
    type: "divider";
}
export type PanelComponent = PanelHeader | PanelText | PanelBadge | PanelProgress | PanelStatus | PanelList | PanelKV | PanelCounter | PanelDivider;
export interface ExtensionPanelState {
    title: string;
    collapsed?: boolean;
    components: PanelComponent[];
}
export interface JsonRpcNotification {
    jsonrpc: "2.0";
    method: string;
    params?: Record<string, unknown>;
}
export interface ExtensionPermissions {
    network?: string[];
    filesystem?: string[];
    shell?: boolean;
    env?: string[];
    storage?: boolean;
    grantedAt: Record<string, number>;
}
export interface InstalledExtension {
    id: string;
    name: string;
    version: string;
    description: string;
    manifest: ExtensionManifestV2;
    source: string;
    installPath: string;
    enabled: boolean;
    grantedPermissions: ExtensionPermissions;
    checksumVerified: boolean;
    consecutiveFailures: number;
    createdAt: Date;
    updatedAt: Date;
}
export interface JsonRpcRequest {
    jsonrpc: "2.0";
    id: number | string;
    method: string;
    params?: Record<string, unknown>;
}
export interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: number | string | null;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}
export interface ToolCallResult {
    content: Array<{
        type: "text";
        text: string;
    }>;
    isError: boolean;
}
//# sourceMappingURL=types.d.ts.map