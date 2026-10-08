/**
 * TEST-ONLY deterministic state seeding. Gated by `isTestSurfaceEnabled()`
 * (404 otherwise) and `chat`-scoped auth — called by the external harness to
 * stand up a known project + conversation (owned by the caller) before a
 * spec, and optionally relax rate limits for high-volume runs.
 *
 * POST { projectName?, title?, provider?, model?, history?, historyFixture?, rateLimitPerMin?, seedAgentConfig?, githubSourceToken? }
 * githubSourceToken additionally requires an administrator with extensions scope;
 * it provisions only the fixed public source-import repository fixture.
 *   → { projectId, conversationId, history?, historyFixture?, rateLimitPerMin?, agentExtensions? }
 */
import { mkdtemp } from "node:fs/promises";
import { createProjectCommandRunner } from "$server/extensions/project-open-pr";
import { getDb } from "$server/db/connection";
import { extensions, providerConnections } from "$server/db/schema";
import { sql } from "drizzle-orm";
import { setSecret } from "$server/extensions/secrets-store";
import crypto from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { isTestSurfaceEnabled } from "$lib/server/test-surface";
import { createProject } from "$server/db/queries/projects";
import { createConversation, createMessage } from "$server/db/queries/conversations";
import { upsertSetting } from "$server/db/queries/settings";
import { seedBlankToolHistory } from "$lib/server/test-chat-history";
import { seedAgentExtensions } from "$lib/server/test-agent-config";
import { SandboxAdmissionStore } from "$server/sandboxes/admission";
import { IncusFeatureService } from "$server/infrastructure/incus-feature-service";
import type { ActiveExtensionRelease } from "$server/extensions/release-process";
import { incusManifest, INCUS_PRESETS } from "../../../../../../extensions/incus-sandbox/manifest";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { digest } from "../../../../../../scripts/incus/model";
import type { RequestHandler } from "./$types";

// Categories matched by hooks.server.ts RATE_LIMITED_ROUTES, overridable via
// the `limits:rateLimit` settings row (60s-cached there).
const RATE_LIMIT_CATEGORIES = [
  "login", "conversationCreate", "chat", "agentRun", "agentGenerate", "workflowRun",
] as const;

interface SeedHistory {
  turns: number;
  charsPerTurn: number;
}

function parseHistory(raw: unknown): SeedHistory | null | Response {
  if (raw === undefined) return null;
  if (typeof raw !== "object" || raw === null) return errorJson(400, "`history` must be an object");
  const { turns, charsPerTurn } = raw as Record<string, unknown>;
	if (typeof turns !== "number" || !Number.isInteger(turns) || turns < 1 || turns > 80) {
    return errorJson(400, "`history.turns` must be an integer in [1,80]");
  }
	if (typeof charsPerTurn !== "number" || !Number.isInteger(charsPerTurn) || charsPerTurn < 32 || charsPerTurn > 8_000) {
    return errorJson(400, "`history.charsPerTurn` must be an integer in [32,8000]");
  }
  return { turns, charsPerTurn };
}

function parseModelPin(provider: unknown, model: unknown): { provider: string; model: string } | undefined | Response {
  if (provider === undefined && model === undefined) return undefined;
  if (typeof provider !== "string" || !provider || typeof model !== "string" || !model) return errorJson(400, "`provider` and `model` must be non-empty strings supplied together");
  return { provider, model };
}

function sourceCredentialFailure(token: unknown, role: string, locals: App.Locals): Response | null {
  if (token === undefined) return null;
  if (role !== "admin") return errorJson(403, "Administrator required for source credentials");
  const denied = requireScope(locals, "extensions");
  if (denied) return denied;
  if (typeof token !== "string" || token.length < 1 || token.length > 4096) return errorJson(400, "Invalid source credential");
  return null;
}

async function initializeSourceFixtureGit(path: string): Promise<void> {
  // Reuse the host runner: Git hooks export repository-selecting GIT_* vars.
  const run = createProjectCommandRunner();
  for (const argv of [["git", "init", "--quiet"], ["git", "remote", "add", "origin", "https://github.com/ezcorp-org/EZHarness"]]) {
    if ((await run(argv, path)).exitCode !== 0) throw new Error("Cannot initialize source fixture Git origin");
  }
}

async function seedProjectPath(sourceToken: unknown): Promise<string> {
  return typeof sourceToken === "string" ? mkdtemp(join(tmpdir(), "ezcorp-harness-"))
    : join(tmpdir(), `ezcorp-harness-${crypto.randomUUID()}`);
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!isTestSurfaceEnabled()) return errorJson(404, "Not found");
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  // Body is optional; a missing/invalid body just means "use defaults", so
  // swallow parse errors rather than 400.
  const body = (await request.json().catch(() => ({}))) as {
    projectName?: unknown;
    title?: unknown;
    provider?: unknown;
    model?: unknown;
    history?: unknown;
    historyFixture?: unknown;
    rateLimitPerMin?: unknown;
    seedAgentConfig?: unknown;
    incusProject?: unknown;
    githubSourceToken?: unknown;
  };

  const projectName = typeof body.projectName === "string" && body.projectName.length > 0
    ? body.projectName
    : `harness-${crypto.randomUUID().slice(0, 8)}`;
  const title = typeof body.title === "string" && body.title.length > 0 ? body.title : "harness";
  const modelPin = parseModelPin(body.provider, body.model);
  if (modelPin instanceof Response) return modelPin;
  if (body.historyFixture !== undefined && body.historyFixture !== "blank-tool-turns") {
    return errorJson(400, "Unknown history fixture");
  }
  if (body.historyFixture !== undefined && body.history !== undefined) {
    return errorJson(400, "Choose history or historyFixture, not both");
  }
  const history = parseHistory(body.history);
  if (history instanceof Response) return history;

  const credentialFailure = sourceCredentialFailure(body.githubSourceToken, user.role, locals);
  if (credentialFailure) return credentialFailure;

  // The real service publishes the generated ID, owner, quota, and binding.
  // Only provider observations are fixtures; no remote effects are dispatched.
  if (body.incusProject === true) {
    const installationId = "11111111-1111-4111-8111-111111111111";
    const releaseId = "22222222-2222-4222-8222-222222222222";
    const connectionId = "33333333-3333-4333-8333-333333333333";
		const connectionConfiguration = { kind: "incus", profile: "ezharness",
			helperVersion: "0.1.6", guestUser: "sandbox" } as const;
		// This test route persists the same harmless provider identity that the
		// production binding lookup reads. No live endpoint or credential is used.
		await getDb().execute(sql`INSERT INTO extension_release_installations (id, owner_id, scope, payload)
			VALUES (${installationId}, ${user.id}, 'global', '{}') ON CONFLICT DO NOTHING`);
		await getDb().insert(providerConnections).values({ id: connectionId, revision: 1,
			providerInstallationId: installationId, providerReleaseId: releaseId,
			endpoint: "https://incus.invalid:8443/", project: "e2e-only",
			configuration: connectionConfiguration, serverCertificatePem: "e2e-only",
			clientCertificatePem: "e2e-only", privateKeyCiphertext: "e2e-only" }).onConflictDoNothing();
    const preset = INCUS_PRESETS.find(item => item.profile === "persistent-web-compose.v1")!;
    const presetDigest = await sandboxPresetDigest(preset);
    const effectiveSettingsDigest = digest({ presetDigest, connectionRevision: 1 });
    const admission = new SandboxAdmissionStore(getDb());
    await admission.configureHostCapacity({ providerInstallationId: installationId, connectionId,
      allocatable: { memoryBytes: preset.limits.memoryBytes, cpuMillicores: preset.limits.cpuMillis,
        diskBytes: preset.limits.diskBytes, pids: preset.limits.pids, executionSlots: 1 },
      safetyMargin: { memoryBytes: 0, cpuMillicores: 0, diskBytes: 0, pids: 0, executionSlots: 0 } });
    const service = new IncusFeatureService({ admission,
      activeRelease: async () => ({ installation: { id: installationId, activeReleaseId: releaseId, generation: 3 },
        release: { id: releaseId, releaseDigest: "e2e-incus-release", manifest: incusManifest } }) as ActiveExtensionRelease,
      connectionRevision: async () => 1,
      resolveConnection: async () => ({ id: connectionId, revision: 1, providerInstallationId: installationId,
        providerReleaseId: releaseId, endpoint: "https://incus.invalid:8443/", serverCertificatePem: "e2e-server",
		project: "ezharness", configuration: connectionConfiguration,
        clientCertificatePem: "e2e-client", privateKeyPem: "e2e-private", revokedAt: null }),
      loadQualification: async () => ({ producer: "live-provider", connectionId, providerId: "incus", presetId: preset.id,
        profile: preset.profile, releaseDigest: "e2e-incus-release", presetDigest, effectiveSettingsDigest,
        backendVersion: "6.0.6", verifiedAt: "2026-10-03T12:00:00Z", validUntil: "2030-01-01T00:00:00Z", cases: [] }),
      assertReady: async () => {},
      assertCurrentScope: async () => {},
    });
    const prepared = await service.prepareProject({ ownerUserId: user.id, name: projectName, installationId,
      connectionId, presetId: preset.id, idempotencyKey: crypto.randomUUID() });
    return json(prepared, { status: 201 });
  }

  const project = await createProject({
    name: projectName,
    path: await seedProjectPath(body.githubSourceToken),
  }, user.id);
  if (typeof body.githubSourceToken === "string") {
    // Fixed public fixture repository only. The normal source broker still
    // checks this owned project's exact origin and current credential per fetch.
    await initializeSourceFixtureGit(project.path);
    await getDb().insert(extensions).values({ name: "github-projects", version: "1.0.0", source: "local", enabled: false,
      creatorUserId: user.id, manifest: { schemaVersion: 2, name: "github-projects", version: "1.0.0", description: "Inactive test credential namespace", author: { name: "E2E" }, tools: [], permissions: {} },
      grantedPermissions: { grantedAt: {} } }).onConflictDoNothing();
    await setSecret("github-projects", project.id, "apiToken", body.githubSourceToken, { actorUserId: user.id });
  }
  const conversation = await createConversation(project.id, {
    title,
    userId: user.id,
    ...modelPin,
  });
  let seededHistory: { firstContent: string; lastContent: string; count: number } | undefined;
  if (history) {
    const historyId = crypto.randomUUID();
    let parentMessageId: string | undefined;
    let firstContent = "";
    let lastContent = "";
    for (let index = 0; index < history.turns; index++) {
      const unit = `history-token-${index} `;
      const content = `E2E_HISTORY_${historyId}_${index}: ${unit.repeat(Math.ceil(history.charsPerTurn / unit.length)).slice(0, history.charsPerTurn)}`;
      const message = await createMessage(conversation.id, {
        role: index % 2 === 0 ? "user" : "assistant",
        content,
        parentMessageId,
      });
      parentMessageId = message.id;
      if (index === 0) firstContent = content;
      lastContent = content;
    }
    seededHistory = { firstContent, lastContent, count: history.turns };
  }
  const historyFixture = body.historyFixture === "blank-tool-turns"
    ? await seedBlankToolHistory(conversation.id, user.id)
    : undefined;
  const agentExtensions = body.seedAgentConfig === true
    ? await seedAgentExtensions(user.id)
    : undefined;

  let rateLimitPerMin: number | undefined;
  if (typeof body.rateLimitPerMin === "number" && Number.isFinite(body.rateLimitPerMin) && body.rateLimitPerMin > 0) {
    rateLimitPerMin = Math.floor(body.rateLimitPerMin);
    const overrides: Record<string, number> = {};
    for (const c of RATE_LIMIT_CATEGORIES) overrides[c] = rateLimitPerMin;
    await upsertSetting("limits:rateLimit", overrides);
  }

  return json(
    {
      projectId: project.id,
      conversationId: conversation.id,
      ...(historyFixture ? { historyFixture } : {}),
      ...(seededHistory ? { history: seededHistory } : {}),
      ...(rateLimitPerMin ? { rateLimitPerMin } : {}),
      ...(agentExtensions ? { agentExtensions } : {}),
    },
    { status: 201 },
  );
};
