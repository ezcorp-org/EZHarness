import type {
	FactoryApiResponse,
	FactoryDefinition,
	FactoryDefinitionListQuery,
	FactoryDraftDetails,
	FactoryDraftSummary,
	FactoryVersionDetails,
	FactoryVersionSummary,
	FactoryServiceCredentialResource,
	FactoryServiceScope,
} from "@ezcorp/factory-sdk/types";
import { validateFactoryApiResponse } from "@ezcorp/factory-sdk/validation";

type Fetch = typeof globalThis.fetch;
type ResponseKind = FactoryApiResponse["kind"];
type ResponseOf<K extends ResponseKind> = Extract<FactoryApiResponse, { kind: K }>;

export class FactoryApiClientError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly currentRevision?: number,
	) {
		super(message);
		this.name = "FactoryApiClientError";
	}
}

export interface FactoryApiClientOptions {
	readonly fetch?: Fetch;
	readonly idempotencyKey?: (operation: string) => string;
}

function encoded(value: string): string {
	return encodeURIComponent(value);
}

function queryString(values: Readonly<Record<string, string | number | boolean | undefined>>): string {
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) query.set(key, String(value));
	}
	const result = query.toString();
	return result.length === 0 ? "" : "?" + result;
}

function defaultIdempotencyKey(operation: string): string {
	return "factory-console:" + operation + ":" + crypto.randomUUID();
}

async function decodeResponse(response: Response): Promise<FactoryApiResponse> {
	let value: unknown;
	try {
		value = await response.json();
	} catch {
		throw new FactoryApiClientError(response.status, "factory_invalid_response", "The factory service returned invalid JSON.");
	}
	const validation = validateFactoryApiResponse(value);
	if (!validation.ok) {
		throw new FactoryApiClientError(response.status, "factory_invalid_response", validation.issues[0]?.message ?? "The factory service returned an invalid response.");
	}
	const result = value as FactoryApiResponse;
	if (result.kind === "error") {
		throw new FactoryApiClientError(response.status, result.error.code, result.error.message, result.error.currentRevision);
	}
	if (!response.ok) {
		throw new FactoryApiClientError(response.status, "factory_http_error", "The factory request failed.");
	}
	return result;
}

function expectKind<K extends ResponseKind>(response: FactoryApiResponse, kind: K): ResponseOf<K> {
	if (response.kind !== kind) {
		throw new FactoryApiClientError(502, "factory_response_kind", "The factory service returned " + response.kind + " instead of " + kind + ".");
	}
	return response as ResponseOf<K>;
}

export class FactoryApiClient {
	private readonly fetcher: Fetch;
	private readonly makeIdempotencyKey: (operation: string) => string;

	constructor(options: FactoryApiClientOptions = {}) {
		this.fetcher = options.fetch ?? globalThis.fetch;
		this.makeIdempotencyKey = options.idempotencyKey ?? defaultIdempotencyKey;
	}

	private definitions(projectId: string): string {
		return "/api/factories/projects/" + encoded(projectId) + "/definitions";
	}

	private definition(projectId: string, factoryId: string): string {
		return this.definitions(projectId) + "/" + encoded(factoryId);
	}

	private async read(path: string, init?: RequestInit): Promise<FactoryApiResponse> {
		return decodeResponse(await this.fetcher(path, init));
	}

	private mutationInit(operation: string, expectedRevision: number, body?: unknown, method = "POST"): RequestInit {
		return {
			method,
			headers: {
				"If-Match": String(expectedRevision),
				"Idempotency-Key": this.makeIdempotencyKey(operation),
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		};
	}

	async listDrafts(projectId: string, query: FactoryDefinitionListQuery = {}): Promise<readonly FactoryDraftSummary[]> {
		const path = this.definitions(projectId) + queryString({
			limit: query.limit,
			cursor: query.cursor,
			search: query.search,
			archived: query.archived,
			availability: query.availability,
		});
		return expectKind(await this.read(path), "draft.page").page.items;
	}

	async getDraft(projectId: string, factoryId: string): Promise<FactoryDraftDetails> {
		return expectKind(await this.read(this.definition(projectId, factoryId)), "draft.details").resource;
	}

	async createDraft(projectId: string, source: FactoryDefinition): Promise<FactoryDraftSummary> {
		const operation = "create:" + source.id;
		const response = await this.read(this.definitions(projectId), this.mutationInit(operation, 0, { source }));
		return expectKind(response, "draft.summary").resource;
	}

	async importDraft(projectId: string, format: "json" | "yaml", source: string): Promise<FactoryDraftSummary> {
		const response = await this.read(this.definitions(projectId) + "/import", this.mutationInit("import", 0, { format, source }));
		return expectKind(response, "draft.summary").resource;
	}

	async saveDraft(projectId: string, factoryId: string, revision: number, source: FactoryDefinition): Promise<FactoryDraftSummary> {
		const response = await this.read(this.definition(projectId, factoryId), this.mutationInit("save:" + factoryId, revision, { source }, "PUT"));
		return expectKind(response, "draft.summary").resource;
	}

	async archiveDraft(projectId: string, factoryId: string, revision: number): Promise<FactoryDraftSummary> {
		const response = await this.read(this.definition(projectId, factoryId), this.mutationInit("archive:" + factoryId, revision, undefined, "DELETE"));
		return expectKind(response, "draft.summary").resource;
	}

	async exportDraft(projectId: string, factoryId: string, format: "json" | "yaml"): Promise<{ readonly format: "json" | "yaml"; readonly source: string }> {
		const response = expectKind(await this.read(this.definition(projectId, factoryId) + "/export" + queryString({ format })), "draft.export");
		return { format: response.format, source: response.source };
	}

	async validateDraft(projectId: string, factoryId: string, source: FactoryDefinition): Promise<Extract<FactoryApiResponse, { kind: "draft.validation" }>> {
		return expectKind(await this.read(this.definition(projectId, factoryId) + "/validate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ source }),
		}), "draft.validation");
	}

	async listVersions(projectId: string, factoryId: string): Promise<readonly FactoryVersionSummary[]> {
		return expectKind(await this.read(this.definition(projectId, factoryId) + "/versions"), "version.page").page.items;
	}

	async getVersion(projectId: string, factoryId: string, version: string): Promise<FactoryVersionDetails> {
		return expectKind(await this.read(this.definition(projectId, factoryId) + "/versions/" + encoded(version)), "version.details").resource;
	}

	async publishVersion(projectId: string, factoryId: string, revision: number, version: string): Promise<FactoryVersionSummary> {
		const response = await this.read(
			this.definition(projectId, factoryId) + "/versions",
			this.mutationInit("publish:" + factoryId + ":" + version, revision, { version }),
		);
		return expectKind(response, "version.summary").resource;
	}

	async issueServiceCredential(projectId: string, serviceAccountId: string, scopes: readonly FactoryServiceScope[], expiresAtMs: number): Promise<{ readonly resource: FactoryServiceCredentialResource; readonly token: string }> {
		const path = "/api/factories/projects/" + encoded(projectId) + "/service-accounts/" + encoded(serviceAccountId) + "/credentials";
		const response = expectKind(await this.read(path, this.mutationInit("issue-credential:" + serviceAccountId, 0, { scopes, expiresAtMs })), "service-credential.issued");
		return { resource: response.resource, token: response.token };
	}

	async revokeServiceCredential(projectId: string, serviceAccountId: string, credentialId: string, revision: number): Promise<FactoryServiceCredentialResource> {
		const path = "/api/factories/projects/" + encoded(projectId) + "/service-accounts/" + encoded(serviceAccountId) + "/credentials/" + encoded(credentialId);
		return expectKind(await this.read(path, this.mutationInit("revoke-credential:" + credentialId, revision, undefined, "DELETE")), "service-credential.resource").resource;
	}
}

export type FactoryAuthoringApi = Pick<FactoryApiClient,
	"listDrafts" | "getDraft" | "createDraft" | "importDraft" | "saveDraft" | "archiveDraft" |
	"exportDraft" | "validateDraft" | "listVersions" | "getVersion" | "publishVersion"
>;

export function blankFactory(factoryId: string): FactoryDefinition {
	return {
		schemaVersion: "factory.v1",
		id: factoryId,
		version: "0.1.0",
		interpreterCompatibility: "factory-kernel.v1",
		inputPorts: {},
		outputPorts: {},
		graph: { nodes: [], outputs: {} },
		acceptance: { id: factoryId + ".contract", version: "0.1.0", claims: [] },
		packages: [],
		factories: [],
		capabilities: [],
		effects: ["none"],
		bounds: { maxExpandedNodes: 10_000, maxScopeDepth: 16 },
		presentation: { title: factoryId },
	};
}
