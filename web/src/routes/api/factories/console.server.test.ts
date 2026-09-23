import { beforeEach, describe, expect, test, vi } from "vitest";
import { FACTORY_EVENT_SCHEMA_VERSION, type FactoryApiResponse, type FactoryRunEvent } from "@ezcorp/factory-sdk";
import type { FactoryApplication } from "$server/factory/application";
import { FactoryConsoleError } from "$server/factory/console-tokens";
import { FactoryGrantError } from "$server/factory/grants";
import { FactoryMutationError } from "$server/factory/mutations";
import { FactoryPackagePreparationError } from "$server/factory/package-preparation";
import { FactoryRunLifecycleError } from "$server/factory/run-lifecycle";
import { FactoryArtifactError } from "$server/factory/artifacts";
import { FactoryArtifactAccessError } from "$server/factory/artifact-access";
import type { FactoryRunEventBatch } from "$server/factory/run-events";
import { FACTORY_STREAM_EVENT_NAMES } from "$lib/runtime-event-names";

const state = vi.hoisted(() => ({ enabled: true, application: null as unknown }));
vi.mock("$server/factory/boot", async importOriginal => ({ ...(await importOriginal<typeof import("$server/factory/boot")>()), factoryBootConfig: { get enabled() { return state.enabled; }, installationId: "test-installation" } }));
vi.mock("$server/factory/application", async importOriginal => ({ ...(await importOriginal<typeof import("$server/factory/application")>()), getFactoryApplication: () => state.application }));

const services = {
  tenantId: "tenant-1",
  inspections: { inspect: vi.fn(), material: vi.fn() },
  events: { read: vi.fn() },
  packages: { list: vi.fn(), install: vi.fn(), transition: vi.fn(), impact: vi.fn() },
  purge: { preview: vi.fn(), request: vi.fn() },
  tickets: { issue: vi.fn(), download: vi.fn(), share: vi.fn(), unshare: vi.fn(), readShared: vi.fn() },
};

const kit = await import("./_console");
const { registerFactoryConsole } = await import("$lib/server/factory/console-dispatch");
// The server hooks register the console once per process; so does this suite, twice to prove it is idempotent.
registerFactoryConsole();
registerFactoryConsole();
const inspection = await import("./projects/[projectId]/runs/[runId]/inspection/+server");
const events = await import("./projects/[projectId]/runs/[runId]/events/+server");
const ticket = await import("./projects/[projectId]/runs/[runId]/artifacts/[artifactId]/ticket/+server");
const download = await import("./projects/[projectId]/runs/[runId]/artifacts/[artifactId]/download/+server");
const shares = await import("./projects/[projectId]/runs/[runId]/artifacts/[artifactId]/shares/+server");
const share = await import("./projects/[projectId]/runs/[runId]/artifacts/[artifactId]/shares/[targetProjectId]/+server");
const sharedRead = await import("./projects/[projectId]/shared-artifacts/[artifactId]/+server");
const packages = await import("./projects/[projectId]/packages/+server");
const trust = await import("./projects/[projectId]/packages/[referenceId]/trust/+server");
const impact = await import("./projects/[projectId]/packages/[referenceId]/impact/+server");
const purgePreview = await import("./tenants/[tenantId]/purge-preview/+server");
const purgeRequests = await import("./tenants/[tenantId]/purge-requests/+server");
const materials = await import("./projects/[projectId]/validator-materials/+server");

const digest = `sha256:${"a".repeat(64)}`;
const referenceId = "b".repeat(64);
const reference = { package: "@ezcorp/runner", manifestName: "runner", version: "1.0.0", digest, export: "run" };
const run = { runId: "run-1", factoryId: "factory-1", factoryVersion: "1.0.0", definitionDigest: digest, grantRevision: 1, revision: 1, status: "running", createdAtMs: 1, updatedAtMs: 1, parameters: {} };
const cursor = { token: "token-1", sequence: 1, expiresAtMs: 5 };
const inspectionResource = {
  run, cursor, projectionLag: 0, children: { items: [] }, attempts: { items: [] }, artifacts: { items: [] }, blockers: [], acceptance: [], releases: [],
  costs: { limitMicros: "0", allocatedMicros: "0", spentMicros: "0", knownCostMicros: "0", unknownCostMicros: "0", admissionBlocked: false, uncertain: false },
};
const packageResource = { referenceId, reference, revision: 1, state: "active", installationId: "installation-1", releaseId: "release-1", boundAtMs: 1 };
const preview = { tenantId: "tenant-1", ready: false, preconditions: [{ id: "live-runs", satisfied: false, count: 1, detail: "Runs" }], auditRowsLost: 3 };
const shareResource = { sourceProjectId: "project-1", sourceRunId: "run-1", artifactId: "artifact-1", targetProjectId: "project-2", digest, encodedBytes: 4, mediaType: "text/plain", revoked: false };
const runEvent = (sequence: number): FactoryRunEvent => ({ schemaVersion: FACTORY_EVENT_SCHEMA_VERSION, runId: "run-1", sequence, eventId: "c".repeat(64), payloadBytes: 2, payload: {} });
const batch = (sequence: number, overrides: Partial<FactoryRunEventBatch> = {}): FactoryRunEventBatch => ({ events: [runEvent(sequence)], cursor: { token: `token-${sequence}`, sequence, expiresAtMs: 9 }, status: "running", drained: false, ...overrides });

type Options = { body?: unknown; revision?: number; key?: string; auth?: "session" | "api-key" | "internal"; anonymous?: boolean; scopes?: string[]; role?: "admin" | "member"; params?: Record<string, string>; headers?: Record<string, string>; signal?: AbortSignal };
function event(method: string, pathname: string, options: Options = {}) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.revision !== undefined) headers["If-Match"] = String(options.revision);
  if (options.key !== undefined) headers["Idempotency-Key"] = options.key;
  const request = new Request(`http://localhost${pathname}`, { method, headers, signal: options.signal, body: options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body) });
  const authMethod = options.auth ?? "session";
  return {
    request, url: new URL(request.url), params: options.params ?? {},
    locals: options.anonymous ? {} : { user: { id: "member-1", email: "m@example.test", name: "Member", role: options.role ?? "member", status: "active" }, authMethod, ...(authMethod === "api-key" ? { apiKeyScopes: options.scopes ?? ["read", "write"] } : {}), ...(authMethod === "internal" ? { apiKeyId: "internal-1" } : {}) },
  } as never;
}
const json = async (response: Response) => await response.json() as FactoryApiResponse & { error?: { code: string } };
const runParams = { projectId: "project-1", runId: "run-1" };
const artifactParams = { ...runParams, artifactId: "artifact-1" };
const base = "/api/factories/projects/project-1";
const session = { id: "member-1", authentication: "session", kind: "user" };

beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = true;
  state.application = { tenantId: "tenant-1", console: async () => services } as unknown as FactoryApplication;
  services.inspections.inspect.mockResolvedValue(inspectionResource);
  services.events.read.mockResolvedValue(batch(2, { drained: true, status: "succeeded" }));
  services.packages.list.mockResolvedValue({ items: [packageResource] });
  services.packages.install.mockResolvedValue({ referenceId, reference, revision: 0, installationId: "installation-1", releaseId: "release-1", boundAtMs: 1 });
  services.packages.transition.mockResolvedValue({ ...packageResource, revision: 2, state: "quarantined" });
  services.packages.impact.mockResolvedValue({ transition: "quarantine", currentRevision: 1, allowed: true, runs: [], truncated: false });
  services.purge.preview.mockResolvedValue(preview);
  services.purge.request.mockResolvedValue({ ...preview, requestId: "purge-1", state: "refused", requestedBy: "member-1", requestedAtMs: 1 });
  services.tickets.issue.mockResolvedValue({ url: `${base}/runs/run-1/artifacts/artifact-1/download?ticket=t`, expiresAtMs: 2, mediaType: "application/octet-stream", encodedBytes: 4 });
  services.tickets.download.mockResolvedValue({ bytes: new TextEncoder().encode("<b>"), artifactId: "artifact/1", digest, kind: "candidate_output" });
  services.tickets.share.mockResolvedValue(shareResource);
  services.tickets.unshare.mockResolvedValue({ ...shareResource, revoked: true });
  services.tickets.readShared.mockResolvedValue({ bytes: new TextEncoder().encode("abcd"), artifactId: "artifact-1", digest, kind: "shared" });
});

describe("console routes", () => {
  test("inspection returns the snapshot, or one section page, for a read principal", async () => {
    const whole = await inspection.GET(event("GET", `${base}/runs/run-1/inspection?search=node&limit=5`, { params: runParams }));
    expect(whole.status).toBe(200);
    expect(await json(whole)).toMatchObject({ kind: "run.inspection", resource: { cursor } });
    expect(services.inspections.inspect).toHaveBeenLastCalledWith(session, runParams, { search: "node", limit: 5 });
    services.inspections.inspect.mockResolvedValue({ section: "attempts", page: { items: [] } });
    const section = await inspection.GET(event("GET", `${base}/runs/run-1/inspection?section=attempts&cursor=abc`, { params: runParams }));
    expect(await json(section)).toMatchObject({ kind: "run.inspection.page", resource: { section: "attempts" } });
    expect(services.inspections.inspect).toHaveBeenLastCalledWith(session, runParams, { section: "attempts", cursor: "abc" });
    expect((await inspection.GET(event("GET", `${base}/runs/run-1/inspection?section=bogus`, { params: runParams }))).status).toBe(400);
  });

  test("the validator material read names a version or a lock, and maps a bad query and an absent material", async () => {
    const material = { factoryId: "factory-1", factoryVersion: "1.0.0", definitionDigest: digest, contractId: "contract", contractVersion: "1", contractDigest: digest, validatorLockDigest: digest, mandatoryClaims: [], claimGroups: [] };
    services.inspections.material.mockResolvedValue(material);
    const read = (search: string) => materials.GET(event("GET", `${base}/validator-materials${search}`, { params: { projectId: "project-1" }, auth: "api-key", scopes: ["read"] }));
    expect(await json(await read("?factoryId=factory-1&factoryVersion=1.0.0&ignored=x"))).toMatchObject({ kind: "validator.material", resource: material });
    expect(services.inspections.material).toHaveBeenLastCalledWith({ kind: "user", id: "member-1", authentication: "api-key" }, "project-1", { factoryId: "factory-1", factoryVersion: "1.0.0" });
    await read(`?validatorLockDigest=${encodeURIComponent(digest)}`);
    expect(services.inspections.material).toHaveBeenLastCalledWith(expect.anything(), "project-1", { validatorLockDigest: digest });
    services.inspections.material.mockRejectedValueOnce(new FactoryConsoleError("factory_material_query_invalid"));
    expect((await read("")).status).toBe(400);
    services.inspections.material.mockRejectedValueOnce(new FactoryConsoleError("factory_material_not_found"));
    expect((await json(await read("?factoryId=f&factoryVersion=9"))).error?.code).toBe("factory_material_not_found");
  });

  test("the event stream reads its first batch before streaming, so refusals are statuses", async () => {
    services.events.read.mockRejectedValueOnce(new FactoryConsoleError("factory_cursor_expired"));
    const expired = await events.GET(event("GET", `${base}/runs/run-1/events?cursor=old`, { params: runParams }));
    expect(expired.status).toBe(410);
    expect((await json(expired)).error?.code).toBe("factory_cursor_expired");
    const timeout = vi.fn();
    const live = event("GET", `${base}/runs/run-1/events`, { params: runParams, headers: { "Last-Event-ID": "token-9" } }) as { platform?: unknown };
    live.platform = { server: { timeout }, request: new Request("http://localhost/") };
    const response = await events.GET(live as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(timeout).toHaveBeenCalledWith(expect.any(Request), 0);
    expect(services.events.read).toHaveBeenLastCalledWith(session, runParams, "token-9");
    const text = await response.text();
    expect(text).toContain(`event: ${FACTORY_STREAM_EVENT_NAMES[0]}`);
    expect(text).toContain(`event: ${FACTORY_STREAM_EVENT_NAMES[2]}\ndata: {"reason":"drained"}`);
    expect((await events.GET(event("GET", `${base}/runs/run-1/events`, { params: runParams }))).status).toBe(400);
  });

  test("artifact tickets and downloads keep bytes out of the page and name the attachment safely", async () => {
    const minted = await ticket.POST(event("POST", `${base}/runs/run-1/artifacts/artifact-1/ticket`, { params: artifactParams }));
    expect(await json(minted)).toMatchObject({ kind: "artifact.ticket", ticket: { mediaType: "application/octet-stream" } });
    expect(services.tickets.issue).toHaveBeenLastCalledWith(session, runParams, "artifact-1", `${base}/runs/run-1/artifacts/artifact-1/download`);
    const missing = await download.GET(event("GET", `${base}/runs/run-1/artifacts/artifact-1/download`, { params: artifactParams }));
    expect(missing.status).toBe(403);
    const bytes = await download.GET(event("GET", `${base}/runs/run-1/artifacts/artifact-1/download?ticket=t`, { params: artifactParams }));
    expect(bytes.status).toBe(200);
    expect(Object.fromEntries(bytes.headers)).toMatchObject({
      "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="artifact_1.bin"', "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox", "cache-control": "no-store", "cross-origin-resource-policy": "same-origin", "content-length": "3",
    });
    expect(await bytes.text()).toBe("<b>");
    services.tickets.download.mockResolvedValueOnce({ bytes: new Uint8Array([1]), artifactId: "***", digest, kind: "material" });
    expect((await download.GET(event("GET", `${base}/runs/run-1/artifacts/artifact-1/download?ticket=t`, { params: artifactParams }))).headers.get("content-disposition")).toBe('attachment; filename="___.bin"');
  });

  test("sharing needs a human session and the target reads only the named bytes", async () => {
    const shareEvent = (auth: Options["auth"]) => event("POST", `${base}/runs/run-1/artifacts/artifact-1/shares`, { params: artifactParams, body: { targetProjectId: "project-2", mediaType: "text/plain" }, revision: 0, key: "share-1", auth });
    expect((await shares.POST(shareEvent("api-key"))).status).toBe(403);
    const granted = await shares.POST(shareEvent("session"));
    expect(await json(granted)).toMatchObject({ kind: "artifact.share.resource", resource: shareResource });
    expect(services.tickets.share).toHaveBeenLastCalledWith(session, runParams, "artifact-1", { targetProjectId: "project-2", mediaType: "text/plain" }, "share-1");
    const revoked = await share.DELETE(event("DELETE", `${base}/runs/run-1/artifacts/artifact-1/shares/project-2`, { params: { ...artifactParams, targetProjectId: "project-2" }, revision: 0, key: "unshare-1" }));
    expect(await json(revoked)).toMatchObject({ resource: { revoked: true } });
    const read = await sharedRead.GET(event("GET", `/api/factories/projects/project-2/shared-artifacts/artifact-1?digest=${digest}&encodedBytes=4&mediaType=text%2Fplain`, { params: { projectId: "project-2", artifactId: "artifact-1" } }));
    expect(read.headers.get("content-disposition")).toContain("attachment");
    expect(services.tickets.readShared).toHaveBeenLastCalledWith(session, "project-2", "artifact-1", { digest, encodedBytes: 4, mediaType: "text/plain" });
    expect((await sharedRead.GET(event("GET", "/api/factories/projects/project-2/shared-artifacts/artifact-1", { params: { projectId: "project-2", artifactId: "artifact-1" } }))).status).toBe(400);
    // Found on the real stack: a share with other bytes is "unavailable" in the service, and a plain 404 here.
    services.tickets.readShared.mockRejectedValueOnce(new FactoryArtifactAccessError("factory_artifact_unavailable"));
    expect((await sharedRead.GET(event("GET", `/api/factories/projects/project-2/shared-artifacts/artifact-1?digest=${digest}&encodedBytes=4&mediaType=text%2Fplain`, { params: { projectId: "project-2", artifactId: "artifact-1" } }))).status).toBe(404);
  });

  test("package administration: read to list and preview, a human tenant administrator to change", async () => {
    const listed = await packages.GET(event("GET", `${base}/packages?limit=10`, { params: { projectId: "project-1" }, auth: "api-key", scopes: ["read"] }));
    expect(await json(listed)).toMatchObject({ kind: "package.page", page: { items: [packageResource] } });
    const installEvent = (auth: Options["auth"]) => event("POST", `${base}/packages`, { params: { projectId: "project-1" }, body: { reference, installationId: "installation-1", releaseId: "release-1" }, revision: 0, key: "install-1", role: "admin", auth, scopes: ["read", "write", "admin"] });
    // No API key of any scope reaches a change; the service refuses anyone but a tenant administrator.
    expect((await packages.POST(installEvent("api-key"))).status).toBe(403);
    services.packages.install.mockRejectedValueOnce(new FactoryConsoleError("factory_package_admin_required"));
    expect((await json(await packages.POST(installEvent("session")))).error?.code).toBe("factory_package_admin_required");
    const installed = await packages.POST(installEvent("session"));
    expect(await json(installed)).toMatchObject({ kind: "package.resource", resource: { revision: 0 } });
    const change = await trust.POST(event("POST", `${base}/packages/${referenceId}/trust`, { params: { projectId: "project-1", referenceId }, body: { transition: "quarantine" }, revision: 1, key: "trust-1", role: "admin" }));
    expect(await json(change)).toMatchObject({ resource: { state: "quarantined" } });
    expect(services.packages.transition).toHaveBeenLastCalledWith(session, "project-1", referenceId, "quarantine", 1, "trust-1");
    const noRevision = await trust.POST(event("POST", `${base}/packages/${referenceId}/trust`, { params: { projectId: "project-1", referenceId }, body: { transition: "quarantine" }, key: "trust-2", role: "admin" }));
    expect(noRevision.status).toBe(412);
    const previewed = await impact.GET(event("GET", `${base}/packages/${referenceId}/impact?transition=quarantine`, { params: { projectId: "project-1", referenceId } }));
    expect(await json(previewed)).toMatchObject({ kind: "package.impact", resource: { allowed: true } });
    expect((await impact.GET(event("GET", `${base}/packages/${referenceId}/impact`, { params: { projectId: "project-1", referenceId } }))).status).toBe(400);
  });

  test("the purge request is administrator-session only and records rather than deletes", async () => {
    const params = { tenantId: "tenant-1" };
    expect((await purgePreview.GET(event("GET", "/api/factories/tenants/tenant-1/purge-preview", { params, auth: "api-key", scopes: ["admin"] }))).status).toBe(403);
    services.purge.preview.mockRejectedValueOnce(new FactoryGrantError("factory_forbidden"));
    expect((await purgePreview.GET(event("GET", "/api/factories/tenants/tenant-1/purge-preview", { params, role: "member" }))).status).toBe(403);
    const previewed = await purgePreview.GET(event("GET", "/api/factories/tenants/tenant-1/purge-preview", { params, role: "admin" }));
    expect(await json(previewed)).toMatchObject({ kind: "purge.preview", resource: preview });
    const requested = await purgeRequests.POST(event("POST", "/api/factories/tenants/tenant-1/purge-requests", { params, role: "admin", body: { reason: "closing", confirmTenantId: "tenant-1" }, revision: 0, key: "purge-1" }));
    expect(await json(requested)).toMatchObject({ kind: "purge.request.resource", resource: { state: "refused" } });
    expect(services.purge.request).toHaveBeenLastCalledWith(session, "tenant-1", { reason: "closing", confirmTenantId: "tenant-1" }, "purge-1");
    const stray = await purgeRequests.POST(event("POST", "/api/factories/tenants/tenant-1/purge-requests", { params, role: "admin", body: { reason: "closing", confirmTenantId: "tenant-1", projectId: "p" }, revision: 0, key: "purge-2" }));
    expect(stray.status).toBe(400);
    const broken = await purgeRequests.POST(event("POST", "/api/factories/tenants/tenant-1/purge-requests", { params, role: "admin", body: "{", revision: 0, key: "purge-3" }));
    expect(broken.status).toBe(400);
    expect((await json(broken)).error?.code).toBe("invalid_json");
  });
});

describe("console route kit", () => {
  const readInspection = (options: Options = {}) => inspection.GET(event("GET", `${base}/runs/run-1/inspection`, { params: runParams, ...options }));

  test("the flag, the application, and the principal each refuse before any service runs", async () => {
    state.enabled = false;
    expect((await json(await readInspection())).error?.code).toBe("factory-disabled");
    state.enabled = true;
    state.application = null;
    expect((await readInspection()).status).toBe(503);
    state.application = { console: async () => services } as unknown as FactoryApplication;
    expect((await readInspection({ anonymous: true })).status).toBe(401);
    expect((await readInspection({ auth: "api-key", scopes: ["write"] })).status).toBe(403);
    expect((await json(await readInspection({ auth: "internal" }))).error?.code).toBe("factory_principal_unsupported");
    expect(services.inspections.inspect).not.toHaveBeenCalled();
    expect((await readInspection({ auth: "api-key", scopes: ["read"] })).status).toBe(200);
    expect(services.inspections.inspect).toHaveBeenLastCalledWith({ kind: "user", id: "member-1", authentication: "api-key" }, runParams, {});
  });

  test("a service credential gets only its delegated scope, only its project, and never a session row", async () => {
    const service = { tokenUse: "factory-service" as const, serviceAccountId: "service-1", projectId: "project-1", credentialId: "c-1", revision: 1, scopes: ["read"] as const, issuedAtMs: 1, expiresAtMs: 2 };
    const withService = (pathname: string, params: Record<string, string>, extra: Options = {}) => {
      const value = event("GET", pathname, { params, anonymous: true, ...extra }) as { locals: App.Locals };
      value.locals.factoryServicePrincipal = service;
      return value as never;
    };
    expect((await inspection.GET(withService(`${base}/runs/run-1/inspection`, runParams))).status).toBe(200);
    expect(services.inspections.inspect).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "service", id: "service-1", credential: service }), runParams, {});
    expect((await json(await inspection.GET(withService("/api/factories/projects/project-2/runs/run-1/inspection", { projectId: "project-2", runId: "run-1" })))).error?.code).toBe("factory_service_project_mismatch");
    const writeOnly = { ...service, scopes: ["write"] as const };
    const narrow = event("GET", `${base}/runs/run-1/inspection`, { params: runParams, anonymous: true }) as { locals: App.Locals };
    narrow.locals.factoryServicePrincipal = writeOnly as never;
    expect((await json(await inspection.GET(narrow as never))).error?.code).toBe("factory_service_scope_required");
    expect((await purgePreview.GET(withService("/api/factories/tenants/tenant-1/purge-preview", { tenantId: "tenant-1" }))).status).toBe(401);
  });

  test("every service failure maps to exactly one status", async () => {
    const cases: Array<[unknown, number, string]> = [
      [new FactoryConsoleError("factory_cursor_invalid"), 400, "factory_cursor_invalid"],
      [new FactoryConsoleError("factory_page_invalid"), 400, "factory_page_invalid"],
      [new FactoryConsoleError("factory_package_not_found"), 404, "factory_package_not_found"],
      [new FactoryConsoleError("factory_package_admin_required"), 403, "factory_package_admin_required"],
      [new FactoryConsoleError("factory_purge_confirmation"), 400, "factory_purge_confirmation"],
      [new FactoryConsoleError("factory_artifact_not_found"), 404, "factory_artifact_not_found"],
      [new FactoryConsoleError("factory_ticket_invalid"), 403, "factory_ticket_invalid"],
      [new FactoryConsoleError("factory_ticket_expired"), 410, "factory_ticket_expired"],
      [new FactoryGrantError("factory_forbidden"), 403, "factory_forbidden"],
      [new FactoryGrantError("factory_human_required"), 403, "factory_human_required"],
      [new FactoryGrantError("factory_grant_storage"), 500, "factory_grant_storage"],
      [new FactoryMutationError("idempotency_conflict"), 409, "idempotency_conflict"],
      [new FactoryMutationError("invalid_idempotency_key"), 400, "invalid_idempotency_key"],
      [new FactoryMutationError("factory_receipt_incomplete"), 500, "factory_receipt_incomplete"],
      [new FactoryRunLifecycleError("factory_run_not_found"), 404, "factory_run_not_found"],
      [new FactoryRunLifecycleError("factory_run_corrupt"), 500, "factory_run_corrupt"],
      [new FactoryPackagePreparationError("factory_package_trust_conflict"), 412, "factory_package_trust_conflict"],
      [new FactoryPackagePreparationError("factory_package_human_required"), 403, "factory_package_human_required"],
      [new FactoryPackagePreparationError("factory_package_trust_invalid"), 400, "factory_package_trust_invalid"],
      [new FactoryPackagePreparationError("factory_package_reference_invalid"), 400, "factory_package_reference_invalid"],
      [new FactoryPackagePreparationError("factory_package_manifest_name_invalid"), 400, "factory_package_manifest_name_invalid"],
      [new FactoryPackagePreparationError("factory_package_release_unavailable"), 404, "factory_package_release_unavailable"],
      [new FactoryPackagePreparationError("factory_package_binding_missing"), 404, "factory_package_binding_missing"],
      [new FactoryPackagePreparationError("factory_package_binding_conflict"), 409, "factory_package_binding_conflict"],
      [new FactoryPackagePreparationError("factory_package_trust_corrupt"), 500, "factory_package_trust_corrupt"],
      [new FactoryArtifactError("factory_artifact_not_found"), 404, "factory_artifact_not_found"],
      [new FactoryArtifactAccessError("factory_artifact_grant_not_found"), 404, "factory_artifact_grant_not_found"],
      [new FactoryArtifactAccessError("factory_artifact_unavailable"), 404, "factory_artifact_unavailable"],
      [new FactoryArtifactError("factory_artifact_digest_invalid"), 400, "factory_artifact_digest_invalid"],
      [new FactoryArtifactAccessError("factory_human_required"), 403, "factory_human_required"],
      [new FactoryArtifactAccessError("factory_artifact_grant_conflict"), 409, "factory_artifact_grant_conflict"],
      [new FactoryArtifactAccessError("factory_artifact_grant_invalid"), 400, "factory_artifact_grant_invalid"],
      [new FactoryArtifactError("factory_artifact_corrupt"), 500, "factory_artifact_corrupt"],
    ];
    for (const [error, status, code] of cases) {
      services.inspections.inspect.mockRejectedValueOnce(error);
      const response = await readInspection();
      expect([code, response.status]).toEqual([code, status]);
      expect((await json(response)).error?.code).toBe(code);
    }
    services.inspections.inspect.mockRejectedValueOnce(new FactoryConsoleError("factory_unlisted" as never));
    await expect(readInspection()).rejects.toThrow("factory_unlisted");
  });

  test("a mutation needs a valid If-Match and an Idempotency-Key", async () => {
    const install = (revision: string | undefined) => packages.POST(event("POST", `${base}/packages`, { params: { projectId: "project-1" }, body: { reference, installationId: "i", releaseId: "r" }, key: "k", role: "admin", headers: revision === undefined ? {} : { "If-Match": revision } }));
    for (const revision of [undefined, "-1", "01", "x", "99999999999999999"]) expect((await install(revision)).status).toBe(412);
    const noKey = await packages.POST(event("POST", `${base}/packages`, { params: { projectId: "project-1" }, body: { reference, installationId: "i", releaseId: "r" }, revision: 0, role: "admin" }));
    expect(noKey.status).toBe(400);
  });

  test("the raw console routes refuse like every factory route, before any service runs", async () => {
    const stream = (options: Options = {}) => events.GET(event("GET", `${base}/runs/run-1/events?cursor=c`, { params: runParams, ...options }));
    state.enabled = false;
    expect((await json(await stream())).error?.code).toBe("factory-disabled");
    state.enabled = true;
    const application = state.application;
    state.application = null;
    expect((await stream()).status).toBe(503);
    state.application = application;
    expect((await stream({ anonymous: true })).status).toBe(401);
    const foreign = event("GET", "/api/factories/projects/project-2/runs/run-1/events?cursor=c", { params: { projectId: "project-2", runId: "run-1" }, anonymous: true }) as { locals: App.Locals };
    foreign.locals.factoryServicePrincipal = { tokenUse: "factory-service", serviceAccountId: "service-1", projectId: "project-1", credentialId: "c-1", revision: 1, scopes: ["read"], issuedAtMs: 1, expiresAtMs: 2 };
    expect((await json(await events.GET(foreign as never))).error?.code).toBe("factory_service_project_mismatch");
    expect(services.events.read).not.toHaveBeenCalled();
    services.events.read.mockRejectedValueOnce(new Error("unmapped"));
    await expect(stream()).rejects.toThrow("unmapped");
  });
});

describe("the run event stream body", () => {
  const read = (text: ReadableStream<Uint8Array>) => new Response(text).text();
  const clock = () => { let now = 0; return { now: () => now, advance: (ms: number) => { now += ms; } }; };

  test("streams batches in order with the cursor as the id, heartbeats when idle, and closes at its deadline", async () => {
    const time = clock();
    const next = vi.fn(async (token: string) => token === "token-1" ? batch(2) : batch(3, { events: [] }));
    const body = kit.factoryRunEventStream(batch(1), { read: next, signal: new AbortController().signal, pollMs: 10, heartbeatMs: 15, maxMs: 45, now: time.now, sleep: async ms => { time.advance(ms); } });
    const text = await read(body);
    // t=10 and t=20 carry news; t=30 is idle and silent; t=40 is idle past the heartbeat; t=50 is past the deadline.
    expect(next.mock.calls.map(call => call[0])).toEqual(["token-1", "token-2", "token-3", "token-3"]);
    expect(text.match(/event: factory:run-status/g)).toHaveLength(3);
    expect(text.match(/: keep-alive/g)).toHaveLength(1);
    expect(text.match(/event: factory:run-event/g)).toHaveLength(2);
    expect(text).toContain("id: token-1\nevent: factory:run-event");
    expect(text).toContain('event: factory:run-status\ndata: {"status":"running","sequence":3,"drained":false}');
    expect(text).toContain(": keep-alive");
    expect(text.trimEnd().endsWith('event: factory:stream-closed\ndata: {"reason":"deadline"}')).toBe(true);
  });

  test("a mid-stream refusal names why, and a disconnect ends silently", async () => {
    for (const [error, reason] of [
      [new FactoryGrantError("factory_forbidden"), "revoked"], [new FactoryConsoleError("factory_cursor_expired"), "expired"],
      [new FactoryRunLifecycleError("factory_run_not_found"), "not-found"], [new FactoryRunLifecycleError("factory_run_corrupt"), "unavailable"],
    ] as const) {
      const body = kit.factoryRunEventStream(batch(1), { read: async () => { throw error; }, signal: new AbortController().signal, pollMs: 1, sleep: async () => undefined });
      expect(await read(body)).toContain(`data: {"reason":"${reason}"}`);
    }
    const controller = new AbortController();
    const body = kit.factoryRunEventStream(batch(1), { read: vi.fn(), signal: controller.signal, pollMs: 1, sleep: async () => { controller.abort(); } });
    const text = await read(body);
    expect(text).toContain("factory:run-status");
    expect(text).not.toContain("stream-closed");
    const aborted = new AbortController();
    aborted.abort();
    expect(await read(kit.factoryRunEventStream(batch(1), { read: vi.fn(), signal: aborted.signal }))).toBe("");
  });

  test("the default sleep resolves on its timer and on abort", async () => {
    const controller = new AbortController();
    const time = clock();
    let reads = 0;
    const body = kit.factoryRunEventStream(batch(1), { read: async () => { reads++; controller.abort(); return batch(2); }, signal: controller.signal, pollMs: 1, now: time.now });
    await read(body);
    expect(reads).toBe(1);
    const late = new AbortController();
    const waiting = kit.factoryRunEventStream(batch(1), { read: vi.fn(), signal: late.signal, pollMs: 60_000 });
    const pending = read(waiting);
    late.abort();
    expect(await pending).toContain("factory:run-status");
  });
});
