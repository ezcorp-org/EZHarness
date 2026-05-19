// HTTP route tests for POST /api/import/preview.
//
// Staging + command/skill scanners run REAL against a tmp project
// root (true integration); only the project lookup + auth/scope
// boundaries are stubbed.

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
let unwritablePath: string;
mock.module("$server/db/queries/projects", () => ({
  getProject: async (id: string) => {
    if (id === "missing") return undefined;
    if (id === "unwritable") return { id, name: "p", path: unwritablePath };
    return { id, name: "p", path: projectRoot };
  },
}));

const { POST } = await import("../preview/+server");

afterAll(() => restoreModuleMocks());

beforeEach(async () => {
  scopeResponse = null;
  projectRoot = await mkdtemp(join(tmpdir(), "imp-prev-proj-"));
  // A regular file used as a bogus "project root" so staging's mkdir
  // throws a non-StagingError (ENOTDIR) → exercises the generic-500 path.
  unwritablePath = join(projectRoot, "iam-a-file");
  await writeFile(unwritablePath, "x", "utf8");
});

function evt(
  body: FormData | string,
  user: typeof MEMBER_USER | null = MEMBER_USER,
  contentType?: string,
): any {
  const init: RequestInit = { method: "POST", body };
  if (contentType) init.headers = { "content-type": contentType };
  const request = new Request("http://localhost/api/import/preview", init);
  return { request, url: new URL(request.url), locals: { user: user ?? undefined } };
}

function dirForm(
  files: Array<[string, string]>,
  projectId = "proj-1",
): FormData {
  const form = new FormData();
  form.append("projectId", projectId);
  for (const [path, content] of files) {
    form.append("files", new File([content], path.split("/").pop()!));
    form.append("paths", path);
  }
  return form;
}

describe("preview — guards", () => {
  test("rejects non-multipart", async () => {
    const res = await POST(evt("{}", MEMBER_USER, "application/json"));
    expect(res.status).toBe(400);
  });

  test("missing user → 401", async () => {
    const res = await POST(evt(dirForm([[".claude/commands/a.md", "x"]]), null));
    expect(res.status).toBe(401);
  });

  test("unparseable multipart body → 400", async () => {
    const request = new Request("http://localhost/api/import/preview", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=zzz" },
      body: "not really multipart",
    });
    const res = await POST({
      request,
      url: new URL(request.url),
      locals: { user: MEMBER_USER },
    } as any);
    expect(res.status).toBe(400);
  });

  test("scope gate short-circuits", async () => {
    scopeResponse = new Response("nope", { status: 403 });
    const res = await POST(evt(dirForm([[".claude/commands/a.md", "x"]])));
    expect(res.status).toBe(403);
  });

  test("global / missing project → 400", async () => {
    const res = await POST(evt(dirForm([["a.md", "x"]], "global")));
    expect(res.status).toBe(400);
  });

  test("unknown project → 404", async () => {
    const res = await POST(evt(dirForm([["a.md", "x"]], "missing")));
    expect(res.status).toBe(404);
  });

  test("a traversal path is rejected as a StagingError", async () => {
    const res = await POST(evt(dirForm([["../evil.md", "x"]])));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("BAD_PATH");
  });

  test("a non-StagingError from staging surfaces as 500", async () => {
    const res = await POST(
      evt(dirForm([[".claude/commands/a.md", "x"]], "unwritable")),
    );
    expect(res.status).toBe(500);
  });
});

describe("preview — directory upload", () => {
  test("returns discovered commands + skills and keeps staging", async () => {
    const res = await POST(
      evt(
        dirForm([
          [".claude/commands/foo.md", "---\ndescription: Foo cmd\n---\nbody"],
          [".codex/prompts/bar.md", "bar body"],
          [".claude/skills/baz/SKILL.md", "---\nname: Baz\ndescription: Baz skill\n---\nbaz instructions"],
          [".claude/skills/baz/run.sh", "echo hi"],
        ]),
      ),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.commands.map((c: any) => c.name).sort()).toEqual(["bar", "foo"]);
    expect(data.skills).toHaveLength(1);
    expect(data.skills[0].name).toBe("baz");
    expect(data.skills[0].scriptCount).toBe(1);
    // Staging dir kept for the commit step.
    const dir = join(
      projectRoot,
      ".ezcorp",
      "import-staging",
      data.sessionId,
    );
    expect((await stat(dir)).isDirectory()).toBe(true);
  });
});

describe("preview — archive upload", () => {
  test("extracts a tar.gz and scans it", async () => {
    const src = await mkdtemp(join(tmpdir(), "imp-prev-arc-"));
    const out = join(tmpdir(), `imp-prev-fix-${Date.now()}.tar.gz`);
    try {
      await mkdir(join(src, ".claude/commands"), { recursive: true });
      await writeFile(join(src, ".claude/commands/zap.md"), "zap", "utf8");
      const p = Bun.spawnSync(["tar", "-czf", out, "-C", src, "."], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(p.exitCode).toBe(0);

      const form = new FormData();
      form.append("projectId", "proj-1");
      form.append(
        "archive",
        new File([await Bun.file(out).arrayBuffer()], "u.tar.gz"),
      );
      const res = await POST(evt(form));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.commands.map((c: any) => c.name)).toEqual(["zap"]);
    } finally {
      await rm(src, { recursive: true, force: true });
      await rm(out, { force: true });
    }
  });
});
