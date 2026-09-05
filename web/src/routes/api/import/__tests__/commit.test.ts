// HTTP route tests for POST /api/import/commit.
//
// Staging + scanners + skill synthesis run REAL against a tmp project
// root; the DB / installer / registry boundaries are stubbed so we
// assert the orchestration (DRY createUserCommand, installFromLocal
// wiring, rollback, registry invalidation, staging cleanup).

import {
  test,
  expect,
  describe,
  beforeEach,
  afterAll,
  mock,
} from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceFileBytes, type WorkspaceFiles } from "@ezcorp/extension-contract";
import { restoreModuleMocks } from "../../../../../../src/__tests__/helpers/mock-cleanup";
import {
  mockServerAlias,
  MEMBER_USER,
} from "../../../../../../src/__tests__/helpers/mock-request";

mockServerAlias();

import * as stagingActual from "../../../../../../src/runtime/import/staging";
import * as skillBundleActual from "../../../../../../src/runtime/import/skill-bundle";
import * as discoveryActual from "../../../../../../src/runtime/commands/discovery";
import * as httpErrorsActual from "../../../../lib/server/http-errors";
mock.module("$server/runtime/import/staging", () => stagingActual);
mock.module("$server/runtime/import/skill-bundle", () => skillBundleActual);
mock.module("$server/runtime/commands/discovery", () => discoveryActual);
mock.module("$lib/server/http-errors", () => httpErrorsActual);

let scopeResponse: Response | null = null;
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => scopeResponse,
}));

let projectRoot: string;
mock.module("$server/db/queries/projects", () => ({
  getProject: async (id: string) =>
    id === "missing" ? undefined : { id, name: "p", path: projectRoot },
}));

let createCalls: any[] = [];
let createImpl: (i: any) => Promise<{ name: string }> = async (i) => ({
  name: i.name,
});
mock.module("$server/db/queries/user-commands", () => ({
  createUserCommand: async (i: any) => {
    createCalls.push(i);
    return createImpl(i);
  },
}));

let existingExtNames = new Set<string>();
let extLookupThrows = false;
mock.module("$server/db/queries/extensions", () => ({
  getExtensionByName: async (n: string) => {
    if (extLookupThrows) throw new Error("lookup boom");
    return existingExtNames.has(n) ? { id: "x", name: n } : null;
  },
}));

let installCalls: any[] = [];
let installImpl: (d: string) => Promise<{ id: string }> = async () => ({
  id: "ext-installed",
});
mock.module("$server/extensions/source-import", () => ({
  stageExtensionSourceFiles: async (actor: unknown, files: WorkspaceFiles, provenance: { name: string }) => {
    installCalls.push({ files, actor, provenance });
    const installation = await installImpl(provenance.name);
    return { installation, operation: { id: "build-operation" }, openUrl: "/extensions/author?installation=ext-installed" };
  },
}));

let reloadCalled = false;
mock.module("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      reload: async () => {
        reloadCalled = true;
      },
    }),
  },
}));

let invalidatedFor: string | null = null;
mock.module("$lib/server/context", () => ({
  getCommandRegistry: () => ({
    invalidateUser: (id: string) => {
      invalidatedFor = id;
    },
  }),
}));

const { POST } = await import("../commit/+server");

afterAll(() => restoreModuleMocks());

beforeEach(async () => {
  scopeResponse = null;
  createCalls = [];
  installCalls = [];
  reloadCalled = false;
  invalidatedFor = null;
  existingExtNames = new Set();
  extLookupThrows = false;
  createImpl = async (i) => ({ name: i.name });
  installImpl = async () => ({ id: "ext-installed" });
  projectRoot = await mkdtemp(join(tmpdir(), "imp-commit-proj-"));
});

function evt(body: unknown, user: typeof MEMBER_USER | null = { ...MEMBER_USER, role: "admin" }): any {
  const request = new Request("http://localhost/api/import/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return {
    request,
    url: new URL(request.url),
    locals: { user: user ?? undefined, authMethod: "session" },
  };
}

// Materialise a real staging session containing one command + one
// skill, returning the sessionId + the ids the wizard would select.
async function stageFixture(binary = false): Promise<{
  sessionId: string;
  commandId: string;
  skillId: string;
}> {
  const F = (c: string, n: string) => new File([c], n);
  const { sessionId } = await stagingActual.stageDirectoryUpload({
    projectRoot,
    files: [
      F("---\ndescription: Foo\n---\nfoo body", "foo.md"),
      F("---\nname: Baz\ndescription: Baz skill\n---\ninstr", "SKILL.md"),
      F("echo hi", "run.sh"),
      ...(binary ? [new File([new Uint8Array([255, 254])], "image.png")] : []),
    ],
    paths: [
      ".claude/commands/foo.md",
      ".claude/skills/baz/SKILL.md",
      ".claude/skills/baz/run.sh",
      ...(binary ? [".claude/skills/baz/image.png"] : []),
    ],
  });
  return {
    sessionId,
    commandId: "project:claude-commands|foo",
    skillId: "baz",
  };
}

describe("commit — guards", () => {
  test("skills require an administrator browser session, not a member or API key", async () => {
    const { sessionId, skillId } = await stageFixture();
    const body = { projectId: "proj-1", sessionId, skills: [skillId] };
    expect((await POST(evt(body, MEMBER_USER))).status).toBe(403);
    const apiEvent = evt(body);
    apiEvent.locals.authMethod = "api-key";
    expect((await POST(apiEvent)).status).toBe(403);
    expect(installCalls).toHaveLength(0);
  });
  test("scope gate", async () => {
    scopeResponse = new Response("no", { status: 403 });
    expect((await POST(evt({}))).status).toBe(403);
  });

  test("missing user → 401", async () => {
    expect((await POST(evt({}, null))).status).toBe(401);
  });

  test("invalid body → 400", async () => {
    expect((await POST(evt("not json"))).status).toBe(400);
  });

  test("global project → 400", async () => {
    expect(
      (await POST(evt({ projectId: "global", sessionId: "x" }))).status,
    ).toBe(400);
  });

  test("expired/unknown session → 410", async () => {
    const res = await POST(
      evt({
        projectId: "proj-1",
        sessionId: "00000000-0000-0000-0000-000000000000",
        commands: [],
        skills: [],
      }),
    );
    expect(res.status).toBe(410);
  });
});

describe("commit — happy path", () => {
  test("imports a command + skill, invalidates, reloads, cleans staging", async () => {
    const { sessionId, commandId, skillId } = await stageFixture();
    const res = await POST(
      evt({
        projectId: "proj-1",
        sessionId,
        commands: [commandId],
        skills: [skillId],
      }),
    );
    expect(res.status).toBe(200);
    const { results } = await res.json();

    const cmd = results.find((r: any) => r.kind === "command");
    expect(cmd.status).toBe("ok");
    expect(cmd.finalName).toBe("foo");
    expect(createCalls[0].name).toBe("foo");
    expect(createCalls[0].frontmatter.imported).toBe("project:claude-commands");

    const skill = results.find((r: any) => r.kind === "skill");
    expect(skill.status).toBe("ok");
    expect(skill.finalName).toBe("baz");
    expect(skill.extId).toBe("ext-installed");
    expect(installCalls[0].provenance).toEqual({ kind: "skill", name: "baz" });
    expect(installCalls[0].files["extension.ts"]).toContain("createRuntimeExtension");
    expect(installCalls[0].files["skill/SKILL.md"]).toContain("instr");
    expect(
      existsSync(join(projectRoot, ".ezcorp/extensions/baz/ezcorp.config.ts")),
    ).toBe(false);

    expect(invalidatedFor).toBe(MEMBER_USER.id);
    expect(reloadCalled).toBe(false);
    expect(skill.operationId).toBe("build-operation");
    expect(skill.openUrl).toContain("/extensions/author");
    expect(installCalls[0].actor).toEqual({ principalId: MEMBER_USER.id, scope: "global", kind: "human" });

    // Staging removed in finally.
    let gone = false;
    try {
      await stat(
        join(projectRoot, ".ezcorp/import-staging", sessionId),
      );
    } catch {
      gone = true;
    }
    expect(gone).toBe(true);
  });

  test("only selected items are imported", async () => {
    const { sessionId, commandId } = await stageFixture();
    const res = await POST(
      evt({ projectId: "proj-1", sessionId, commands: [commandId], skills: [] }),
    );
    const { results } = await res.json();
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe("command");
    expect(installCalls).toHaveLength(0);
    expect(reloadCalled).toBe(false);
  });
});

describe("commit — collisions + failures", () => {
  test("binary skill assets preserve exact bytes in an unapproved workspace", async () => {
    const { sessionId, skillId } = await stageFixture(true);
    const response = await POST(evt({ projectId: "proj-1", sessionId, skills: [skillId] }));
    const { results } = await response.json();
    expect(results[0].status).toBe("ok");
    expect(installCalls).toHaveLength(1);
    const asset = installCalls[0].files["skill/image.png"];
    expect(asset).toEqual({ encoding: "base64", data: "//4=", executable: false });
    expect(workspaceFileBytes(asset)).toEqual(new Uint8Array([255, 254]));
    expect(results[0].operationId).toBe("build-operation");
    expect(results[0].openUrl).toContain("/extensions/author");
    expect(reloadCalled).toBe(false);
  });
  test("suffixes a skill whose name is taken", async () => {
    existingExtNames = new Set(["baz"]);
    const { sessionId, skillId } = await stageFixture();
    const res = await POST(
      evt({ projectId: "proj-1", sessionId, commands: [], skills: [skillId] }),
    );
    const { results } = await res.json();
    expect(results[0].finalName).toBe("baz-2");
    expect(installCalls[0].provenance).toEqual({ kind: "skill", name: "baz-2" });
  });

  test("install failure rolls back the synthesized dir", async () => {
    installImpl = async () => {
      throw new Error("env-key-leak");
    };
    const { sessionId, skillId } = await stageFixture();
    const res = await POST(
      evt({ projectId: "proj-1", sessionId, commands: [], skills: [skillId] }),
    );
    const { results } = await res.json();
    expect(results[0].status).toBe("error");
    expect(results[0].message).toContain("env-key-leak");
    expect(existsSync(join(projectRoot, ".ezcorp/extensions/baz"))).toBe(false);
    expect(reloadCalled).toBe(false);
  });

  test("a thrown ext-name lookup is caught as synthesis error", async () => {
    extLookupThrows = true;
    const { sessionId, skillId } = await stageFixture();
    const res = await POST(
      evt({ projectId: "proj-1", sessionId, commands: [], skills: [skillId] }),
    );
    const { results } = await res.json();
    expect(results[0].status).toBe("error");
    expect(results[0].message).toContain("lookup boom");
  });

  test("a failing command create is reported per-item", async () => {
    createImpl = async () => {
      throw new Error("db down");
    };
    const { sessionId, commandId } = await stageFixture();
    const res = await POST(
      evt({ projectId: "proj-1", sessionId, commands: [commandId], skills: [] }),
    );
    const { results } = await res.json();
    expect(results[0].status).toBe("error");
    expect(results[0].message).toContain("db down");
    expect(invalidatedFor).toBeNull();
  });
});
