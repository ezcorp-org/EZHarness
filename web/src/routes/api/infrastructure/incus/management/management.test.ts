import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { ContractError } from "@ezcorp/extension-contract";
import type { LiveSandboxPresetQualification } from "@ezcorp/extension-contract";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { createServer } from "node:net";
import { get as httpGet } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serverModule } from "../../../../../../../src/__tests__/helpers/mock-cleanup";
import { IncusAdmissionReadinessError } from "../../../../../../../src/infrastructure/incus-admission-contract";
import { IncusAdmissionReadinessService as ActualReadinessService } from "../../../../../../../src/infrastructure/incus-admission-readiness";
import { admissionPin, admissionObservation, admissionSelection } from "../../../../../../../src/infrastructure/__tests__/incus-admission-observation";
import { up as addAdmission } from "../../../../../../../src/db/migrations/add-incus-admission-readiness";
import { up as addController } from "../../../../../../../src/db/migrations/add-sandbox-controller";
import * as schema from "../../../../../../../src/db/schema";

const ReadinessService = ActualReadinessService;
let rows: unknown[][];
let queries = 0;
let fail = false;
let admissionFailure: "qualification_expired" | "readiness_unavailable" | "capacity_full" | null = null;
let admissionError: unknown = null;
let actualReadiness: ActualReadinessService | null = null;
const warnings: Array<{ message: string; fields: unknown }> = [];
let qualification: { validUntil: string } | null;
let active: Record<string, unknown>;
const connection = { installationId: "installation", releaseId: "release", connectionId: "connection", connectionRevision: 1, label: "Development", setupId: null };
const preset = { id: "compose", profile: "persistent-web-compose.v1", limits: { memoryBytes: 4294967296, cpuMillis: 2000, diskBytes: 21474836480, pids: 1024 } };
const run = { runId: "run", state: "AWAITING_RESTART", deadlineAt: "2999-01-01T00:00:00Z" };

const realAuthMiddleware = serverModule("auth/middleware", {});
const realLifecycleService = serverModule("extensions/extension-lifecycle-service", {});

mock.module("$server/logger", () => ({ logger: { child: () => ({ warn: (message: string, fields: unknown) => warnings.push({ message, fields }) }) } }));
mock.module("$server/db/connection", () => ({ getDb: () => ({ execute: async () => { queries++; if (fail) throw new Error("SECRET"); return rows.shift() ?? []; } }) }));

mock.module("$server/extensions/release-process", () => ({ getReleaseRuntime: () => ({}), resolveActiveRelease: async (id: string) => {
  if (id === "inactive") throw new ContractError("RELEASE_NOT_ACTIVE", "SECRET");
  if (id === "broken") throw new Error("SECRET-integrity-failure");
  return active;
} }));
mock.module("$server/infrastructure/incus-qualification", () => ({ IncusQualificationStore: class { async load() { return qualification; } } }));
mock.module("$server/infrastructure/incus-admission-readiness", () => ({ IncusAdmissionReadinessService: class {
  async check(scope: typeof admissionPin.scope) {
    if (actualReadiness) return actualReadiness.check(scope);
    if (admissionError !== null) throw admissionError;
    if (admissionFailure) throw new IncusAdmissionReadinessError(admissionFailure);
    if (!qualification) throw new IncusAdmissionReadinessError("qualification_expired");
    return { qualification, validUntil: Date.parse(qualification.validUntil), baselineRunId: "baseline-run" };
  }
} }));
const { GET } = await import("./+server");
const admin = { user: { role: "admin" }, authMethod: "session" };
const request = (locals: unknown = admin) => GET({ locals } as Parameters<typeof GET>[0]);

beforeAll(() => {
  mock.module("$server/auth/middleware", () => ({ ...realAuthMiddleware, requireAdminSession: (locals: { user?: { role: string }; authMethod?: string }) =>
  locals.user?.role === "admin" && locals.authMethod === "session" ? locals.user : Response.json({}, { status: locals.user ? 403 : 401 }) }));
  mock.module("$server/extensions/extension-lifecycle-service", () => ({ ...realLifecycleService, getExtensionLifecycle: async () => undefined }));
});
afterAll(() => {
  mock.module("$server/auth/middleware", () => realAuthMiddleware);
  mock.module("$server/extensions/extension-lifecycle-service", () => realLifecycleService);
});

beforeEach(() => {
  rows = [[connection], [{ id: "project", name: "Project" }], [], []]; queries = 0; fail = false;
  qualification = null; admissionFailure = null; admissionError = null; actualReadiness = null; warnings.length = 0;
  active = { installation: { generation: 3 }, release: { id: "release", manifest: { sandboxProviders: [{ id: "incus", kind: "sandbox", protocolMajor: 1, presets: [preset] }] } } };
});

test("only an admin human session can list infrastructure", async () => {
  expect((await request({})).status).toBe(401);
  expect((await request({ ...admin, authMethod: "api-key" })).status).toBe(403);
  expect((await request({ user: { role: "member" }, authMethod: "session" })).status).toBe(403);
  expect(queries).toBe(0);
});

test("lists current environments with explicit missing qualification and no cache", async () => {
  const response = await request();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ environments: [{ ...connection, label: "Development · compose", releaseGeneration: 3,
    presetId: "compose", profile: preset.profile, limits: preset.limits, qualified: false, qualificationValidUntil: null, fullQualificationValidUntil: null, admissionReason: "qualification_expired",
    qualificationState: "not_qualified", qualificationRunId: null, lastQualificationRunId: null, baselineRunId: null, blockedReason: "Run qualification before creating a sandbox." }],
    projects: [{ id: "project", name: "Project" }], features: [], truncated: false });
  expect(warnings).toEqual([]);
});

test("shows saved running, expired, failed, and qualified outcomes", async () => {
  for (const [saved, expected] of [[run, "running"], [{ ...run, state: "FAILED" }, "failed"],
    [{ ...run, deadlineAt: "2000-01-01T00:00:00Z" }, "failed"], [{ ...run, state: "COMPLETED" }, "not_qualified"]] as const) {
    rows = [[connection], [], [], [saved]];
    const result = await (await request()).json();
    expect(result.environments[0].qualificationState).toBe(expected);
    expect(result.environments[0].qualificationRunId).toBe("run");
  }
  qualification = { validUntil: "2999-01-01T00:00:00Z" };
  rows = [[connection], [], [], []];
  expect((await (await request()).json()).environments[0]).toMatchObject({ qualified: true,
    qualificationState: "qualified", qualificationValidUntil: new Date(qualification.validUntil).toISOString(), blockedReason: null });
  rows = [[connection], [], [], [{ ...run, state: "FAILED" }]];
  expect((await (await request()).json()).environments[0]).toMatchObject({ qualified: true,
    qualificationRunId: "baseline-run", baselineRunId: "baseline-run", lastQualificationRunId: "run" });
  rows = [[connection], [], [], [run]];
  expect((await (await request()).json()).environments[0]).toMatchObject({ qualified: false, qualificationState: "running" });
});

test("keeps a claimed continuation running after its handoff deadline", async () => {
  rows = [[connection], [], [], [{ ...run, state: "CLAIMED",
    deadlineAt: new Date(Date.now() - 60_000).toISOString(),
    claimedAt: new Date(Date.now() - 120_000).toISOString() }]];
  expect((await (await request()).json()).environments[0]).toMatchObject({
    qualified: false, qualificationState: "running", qualificationRunId: "run",
    blockedReason: "Qualification is running." });
});

test("bounds claimed continuations by their durable claim time", async () => {
  const now = Date.parse("2026-10-23T17:59:00Z");
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    for (const [claimedAt, expected] of [
      [new Date(now - 20 * 60_000 + 1).toISOString(), "running"],
      [new Date(now - 20 * 60_000).toISOString(), "failed"],
      [new Date(now + 1).toISOString(), "failed"],
      [null, "failed"], ["invalid", "failed"], [undefined, "failed"],
    ] as const) {
      rows = [[connection], [], [], [{ ...run, state: "CLAIMED", claimedAt }]];
      expect((await (await request()).json()).environments[0].qualificationState).toBe(expected);
    }
  } finally { clock.mockRestore(); }
});

test("keeps existing features visible when their release is inactive or changed", async () => {
  const feature = { bindingId: "old", observedState: "UNKNOWN", operation: { state: "OUTCOME_UNKNOWN" } };
  rows = [[{ ...connection, installationId: "inactive" }, { ...connection, releaseId: "old" }], [], [feature]];
  expect(await (await request()).json()).toMatchObject({ environments: [], features: [feature] });
  for (const providers of [undefined, [], [{ id: "other", kind: "sandbox" }], [{ id: "incus", kind: "sandbox", protocolMajor: 2 }]]) {
    active = { installation: { generation: 3 }, release: { id: "release", manifest: { sandboxProviders: providers } } };
    rows = [[connection], [], []];
    expect((await (await request()).json()).environments).toEqual([]);
  }
});

test("bounds each result collection and reports truncation", async () => {
  active = { installation: { generation: 3 }, release: { id: "release", manifest: { sandboxProviders: [{ id: "incus", kind: "sandbox", protocolMajor: 1,
    presets: Array.from({ length: 101 }, (_, i) => ({ ...preset, id: `preset-${i}` })) }] } } };
  rows = [[connection], Array(101).fill({ id: "project" }), Array(101).fill({ bindingId: "binding" })];
  const result = await (await request()).json();
  expect(result.environments).toHaveLength(100); expect(result.projects).toHaveLength(100);
  expect(result.features).toHaveLength(100); expect(result.truncated).toBe(true);
  rows = [Array(101).fill({ ...connection, installationId: "inactive" }), [], []];
  expect((await (await request()).json()).truncated).toBe(true);
});

test("sanitizes failures without leaking database diagnostics", async () => {
  fail = true;
  const response = await request();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: "management_unavailable", message: "Sandbox status is unavailable. Try refreshing." });
  fail = false;
  rows = [[{ ...connection, installationId: "broken" }], [], []];
  const broken = await request();
  expect(broken.status).toBe(503);
  expect(await broken.text()).not.toContain("SECRET");
});

test("readonly host failure and capacity exhaustion keep full qualification distinct", async () => {
  qualification = { validUntil: "2999-01-01T00:00:00Z" };
  for (const reason of ["readiness_unavailable", "capacity_full"] as const) {
    admissionFailure = reason; rows = [[connection], [], [], []];
    expect((await (await request()).json()).environments[0]).toMatchObject({ qualified: false,
      admissionReason: reason, qualificationValidUntil: null, fullQualificationValidUntil: qualification.validUntil });
  }
});

test("logs finite readiness failure reasons without changing the management response", async () => {
  qualification = { validUntil: "2999-01-01T00:00:00Z" };
  for (const reason of ["deadline_exceeded", "authority_rejected", "unavailable"] as const) {
    admissionError = Object.assign(new IncusAdmissionReadinessError("readiness_unavailable", reason),
      { message: "SECRET socket path and credential", stack: "SECRET stack" });
    rows = [[connection], [], [], []]; warnings.length = 0;
    const response = await request();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.environments[0]).toMatchObject({ qualified: false, admissionReason: "readiness_unavailable",
      qualificationValidUntil: null, fullQualificationValidUntil: qualification.validUntil });
    expect(body.environments[0]).not.toHaveProperty("readinessReason");
    expect(JSON.stringify(body)).not.toContain("SECRET");
    expect(warnings).toEqual([{ message: "Incus admission readiness failed", fields: {
      causeCode: "readiness_unavailable", readinessReason: reason,
    } }]);
    expect(JSON.stringify(warnings)).not.toContain("SECRET");
  }
});

test("normalizes unknown readiness diagnostics and logs only allowed codes", async () => {
  qualification = { validUntil: "2999-01-01T00:00:00Z" };
  for (const error of [new Error("SECRET unexpected failure"), { code: "capacity_full", reason: "authority_rejected", message: "SECRET forged error" },
    Object.assign(new IncusAdmissionReadinessError("readiness_unavailable"), { reason: "SECRET unknown reason" }),
    Object.assign(new IncusAdmissionReadinessError("readiness_unavailable"), { reason: { secret: "SECRET" } })]) {
    admissionError = error; rows = [[connection], [], [], []]; warnings.length = 0;
    const body = await (await request()).json();
    expect(body.environments[0].admissionReason).toBe("readiness_unavailable");
    expect(warnings).toEqual([{ message: "Incus admission readiness failed", fields: {
      causeCode: "readiness_unavailable", readinessReason: "unavailable",
    } }]);
    expect(JSON.stringify({ body, warnings })).not.toContain("SECRET");
  }
  admissionError = null;
  for (const code of ["qualification_expired", "capacity_full"] as const) {
    admissionFailure = code; rows = [[connection], [], [], []]; warnings.length = 0;
    const body = await (await request()).json();
    expect(body.environments[0].admissionReason).toBe(code);
    expect(warnings).toEqual([]);
  }
  admissionFailure = null; rows = [[connection], [], [], []]; warnings.length = 0;
  expect((await (await request()).json()).environments[0].qualified).toBe(true);
  expect(warnings).toEqual([]);
});

interface ReadinessSocketFixture {
  pin: typeof admissionPin;
  proof: LiveSandboxPresetQualification;
  respond: (value: string | ((selected: typeof admissionPin) => string), delayMs?: number) => void;
  requestCount: () => number;
  readStored: () => Promise<unknown[]>;
}

async function withReadinessSocket(verify: (fixture: ReadinessSocketFixture) => Promise<void>, presetIds = [preset.id]) {
  const root = await mkdtemp(join(tmpdir(), "incus-management-reason-"));
  const socketPath = join(root, "control.sock");
  const originalSocket = process.env.EZCORP_INCUS_SUPERVISOR_SOCKET;
  const pin = { ...admissionPin, scope: { ...admissionPin.scope, presetId: preset.id } };
  const pins = presetIds.map(presetId => ({ ...pin, scope: { ...pin.scope, presetId } }));
  let reply: string | ((selected: typeof admissionPin) => string) = selected => JSON.stringify(admissionObservation(selected, Date.now()));
  let replyDelayMs = 0;
  let requests = 0;
  const listener = createServer(socket => {
    let payload = "";
    socket.on("data", data => {
      payload += data.toString();
      if (!payload.includes("\n")) return;
      const selected = JSON.parse(payload).expectedPin;
      expect(pins).toContainEqual(selected);
      expect(JSON.parse(payload)).toEqual({ version: 2, action: "admissionReadiness", expectedPin: selected });
      requests++;
      setTimeout(() => socket.end(`${typeof reply === "function" ? reply(selected) : reply}\n`), replyDelayMs);
    });
  });
  const client = new PGlite();
  try {
    await new Promise<void>(resolve => listener.listen(socketPath, resolve));
    process.env.EZCORP_INCUS_SUPERVISOR_SOCKET = socketPath;
    await client.waitReady;
    await client.exec("CREATE TABLE projects(id TEXT PRIMARY KEY)");
    const db = drizzle(client, { schema });
    await addController(db); await addAdmission(db);
    const proof = { verifiedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 60_000).toISOString(),
      backendVersion: "6.0.6" } as LiveSandboxPresetQualification;
    actualReadiness = new ReadinessService(db, { authorizeFixture: async scope => admissionSelection(pins.find(selected => selected.scope.presetId === scope.presetId)!),
      loadBaselineProof: async () => proof }, { assertCurrentScope: async () => {} });
    for (const selected of pins) {
      const runId = selected.scope.presetId === pin.scope.presetId ? "baseline-run" : `baseline-run-${selected.scope.presetId}`;
      await actualReadiness.capture(selected.scope, runId);
      await actualReadiness.recordBaseline(await actualReadiness.prepareBaseline(selected.scope, runId, proof));
    }
    qualification = proof;
    await verify({ pin, proof,
      respond: (value, delayMs = 0) => { reply = value; replyDelayMs = delayMs; },
      requestCount: () => requests,
      readStored: async () => (await db.execute(sql`SELECT failure, result FROM incus_admission_readiness`)).rows });
  } finally {
    actualReadiness = null;
    if (originalSocket === undefined) delete process.env.EZCORP_INCUS_SUPERVISOR_SOCKET;
    else process.env.EZCORP_INCUS_SUPERVISOR_SOCKET = originalSocket;
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("real socket and readiness service preserve finite reasons through management GET", async () => {
  await withReadinessSocket(async fixture => {
    for (const reason of ["deadline_exceeded", "authority_rejected", "unavailable", "SECRET raw server detail"] as const) {
      fixture.respond(JSON.stringify({ error: `readiness_unavailable:${reason}` }));
      rows = [[connection], [], [], []]; warnings.length = 0;
      const response = await request();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.environments[0]).toMatchObject({ qualified: false, admissionReason: "readiness_unavailable",
        fullQualificationValidUntil: fixture.proof.validUntil, baselineRunId: null });
      expect(warnings).toEqual([{ message: "Incus admission readiness failed", fields: {
        causeCode: "readiness_unavailable", readinessReason: reason.startsWith("SECRET") ? "unavailable" : reason,
      } }]);
      expect(JSON.stringify({ body, warnings })).not.toContain("SECRET");
      expect(await fixture.readStored()).toEqual([{ failure: "readiness_unavailable", result: null }]);
    }
    expect(fixture.requestCount()).toBe(6);
  });
});

test("real Bun HTTP keeps bounded readiness and deadline refusals observable after authorization", async () => {
  (active.release as { manifest: { sandboxProviders: Array<{ presets: Array<typeof preset> }> } }).manifest.sandboxProviders[0]!.presets.push({ ...preset, id: "second" });
  await withReadinessSocket(async fixture => {
    let locals: unknown = {};
    const timeoutCalls: Array<{ request: Request; seconds: number }> = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 10,
      fetch(raw, live) {
        return GET({ locals, platform: { request: raw, server: {
          timeout(original: Request, seconds: number) {
            timeoutCalls.push({ request: original, seconds });
            live.timeout(original, seconds);
          },
        } } } as Parameters<typeof GET>[0]);
      } });
    const url = new URL("/api/infrastructure/incus/management", server.url);
    // Bun.fetch may transparently retry an empty response. Use the same plain
    // HTTP client boundary as Playwright so an idle-close is an actual error.
    const get = () => new Promise<Response>((resolve, reject) => {
      const outgoing = httpGet(url, { agent: false }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
        incoming.on("error", reject);
        incoming.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode })));
      });
      outgoing.setTimeout(30_000, () => outgoing.destroy(new Error("management HTTP client deadline")));
      outgoing.on("error", reject);
    });
    try {
      for (const denied of [{}, { user: { role: "user" }, authMethod: "session" }, { user: { role: "admin" }, authMethod: "api_key" }]) {
        locals = denied;
        const response = await get();
        expect([401, 403]).toContain(response.status);
        await response.arrayBuffer();
      }
      expect(timeoutCalls).toEqual([]);
      locals = admin;
      // Two sequential presets exceed the adapter's10s idle budget with ample
      // sweep margin. Each10.5s observation is inside unchanged11s/12s bounds.
      for (const outcome of ["qualified", "deadline_exceeded"] as const) {
        fixture.respond(outcome === "qualified"
          ? selected => JSON.stringify(admissionObservation(selected, Date.now()))
          : JSON.stringify({ error: "readiness_unavailable:deadline_exceeded" }), 10_500);
        rows = [[connection], [], [], []]; warnings.length = 0;
        const response = await get();
        expect(response.status).toBe(200);
        const body = await response.json();
        if (outcome === "qualified") {
          expect(body.environments).toHaveLength(2);
          expect(body.environments.map((environment: { baselineRunId: string }) => environment.baselineRunId)).toEqual(["baseline-run", "baseline-run-second"]);
          for (const environment of body.environments) expect(environment).toMatchObject({ qualified: true, admissionReason: null });
        } else {
          expect(body.environments).toHaveLength(2);
          for (const environment of body.environments) expect(environment).toMatchObject({ qualified: false, admissionReason: "readiness_unavailable",
            fullQualificationValidUntil: fixture.proof.validUntil, baselineRunId: null });
          expect(warnings).toHaveLength(2);
          for (const warning of warnings) expect(warning).toEqual({ message: "Incus admission readiness failed", fields: {
            causeCode: "readiness_unavailable", readinessReason: "deadline_exceeded",
          } });
        }
        expect(timeoutCalls.at(-1)?.seconds).toBe(0);
        expect(timeoutCalls.at(-1)?.request.url).toBe(url.href);
      }
      expect(timeoutCalls).toHaveLength(2);
      expect(fixture.requestCount()).toBe(8);
    } finally {
      await server.stop(true);
    }
  }, [preset.id, "second"]);
}, 60_000);
