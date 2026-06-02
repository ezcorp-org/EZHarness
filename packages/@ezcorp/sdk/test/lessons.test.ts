// lessons.test.ts — 100% line coverage for runtime/lessons.ts
//
// `Lessons` is a thin typed client over the `ezcorp/lessons` reverse
// RPC. Every method just shapes a params object and forwards it through
// `getChannel().request`. We spy that single chokepoint (mirroring the
// storage.test.ts harness) to assert the wire shape per action and to
// hand back synthetic host responses so the unwrap logic is exercised.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { Lessons, type LessonRecord } from "../src/runtime/lessons";
import {
  __resetChannelForTests,
  getChannel,
  type HostChannel,
} from "../src/runtime/channel";

afterEach(() => {
  __resetChannelForTests();
});

interface RequestCall {
  method: string;
  params: Record<string, unknown>;
}

function stubRequest(
  impl: (call: RequestCall) => Promise<unknown>,
): { calls: RequestCall[] } {
  const ch: HostChannel = getChannel();
  const calls: RequestCall[] = [];
  const spy = spyOn(ch, "request");
  spy.mockImplementation(
    (async (method: string, params: unknown) => {
      const call: RequestCall = {
        method,
        params: (params ?? {}) as Record<string, unknown>,
      };
      calls.push(call);
      return impl(call);
    }) as HostChannel["request"],
  );
  return { calls };
}

function makeLesson(overrides: Partial<LessonRecord> = {}): LessonRecord {
  return {
    id: "l1",
    projectId: "p1",
    ownerId: "o1",
    visibility: "user",
    slug: "use-bun",
    title: "Use Bun",
    body: "Prefer bun over node.",
    frontmatter: null,
    source: "distiller",
    authorExtensionId: "ext-1",
    firedCount: 0,
    lastFiredAt: null,
    dismissedCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Lessons.list", () => {
  test("no opts → only { action: 'list' }, returns lessons array", async () => {
    const lesson = makeLesson();
    const { calls } = stubRequest(async () => ({ lessons: [lesson] }));
    const result = await new Lessons().list();
    expect(calls[0]?.method).toBe("ezcorp/lessons");
    expect(calls[0]?.params).toEqual({ action: "list" });
    expect(result).toEqual([lesson]);
  });

  test("projectId only attaches projectId, omits limit", async () => {
    const { calls } = stubRequest(async () => ({ lessons: [] }));
    await new Lessons().list({ projectId: "proj-9" });
    expect(calls[0]?.params).toEqual({ action: "list", projectId: "proj-9" });
  });

  test("limit only attaches limit (including 0), omits projectId", async () => {
    const { calls } = stubRequest(async () => ({ lessons: [] }));
    await new Lessons().list({ limit: 0 });
    expect(calls[0]?.params).toEqual({ action: "list", limit: 0 });
  });

  test("both projectId + limit attached", async () => {
    const { calls } = stubRequest(async () => ({ lessons: [] }));
    await new Lessons().list({ projectId: "proj-9", limit: 25 });
    expect(calls[0]?.params).toEqual({
      action: "list",
      projectId: "proj-9",
      limit: 25,
    });
  });

  test("empty opts object omits both optional keys", async () => {
    const { calls } = stubRequest(async () => ({ lessons: [] }));
    await new Lessons().list({});
    expect(calls[0]?.params).toEqual({ action: "list" });
  });
});

describe("Lessons.get", () => {
  test("sends { action: 'get', id } and returns the lesson", async () => {
    const lesson = makeLesson({ id: "abc" });
    const { calls } = stubRequest(async () => ({ lesson }));
    const result = await new Lessons().get("abc");
    expect(calls[0]?.params).toEqual({ action: "get", id: "abc" });
    expect(result).toEqual(lesson);
  });

  test("returns null when host has no row", async () => {
    stubRequest(async () => ({ lesson: null }));
    expect(await new Lessons().get("ghost")).toBeNull();
  });
});

describe("Lessons.getBySlug", () => {
  test("sends { action: 'get', slug, projectId } and returns the lesson", async () => {
    const lesson = makeLesson({ slug: "x" });
    const { calls } = stubRequest(async () => ({ lesson }));
    const result = await new Lessons().getBySlug("x", "proj-1");
    expect(calls[0]?.params).toEqual({
      action: "get",
      slug: "x",
      projectId: "proj-1",
    });
    expect(result).toEqual(lesson);
  });

  test("returns null when slug not found", async () => {
    stubRequest(async () => ({ lesson: null }));
    expect(await new Lessons().getBySlug("nope", "p")).toBeNull();
  });
});

describe("Lessons.write", () => {
  test("forwards input verbatim and returns {lesson, created}", async () => {
    const lesson = makeLesson();
    const { calls } = stubRequest(async () => ({ lesson, created: true }));
    const input = {
      slug: "use-bun",
      title: "Use Bun",
      body: "Prefer bun.",
      projectId: "p1",
    };
    const result = await new Lessons().write(input);
    expect(calls[0]?.params).toEqual({ action: "write", input });
    expect(result).toEqual({ lesson, created: true });
  });

  test("slug-collision soft outcome surfaces created:false", async () => {
    const lesson = makeLesson();
    stubRequest(async () => ({ lesson, created: false }));
    const result = await new Lessons().write({
      slug: "use-bun",
      title: "Use Bun",
      body: "dup",
      visibility: "project",
      frontmatter: { tags: ["x"] },
      projectId: "p1",
    });
    expect(result.created).toBe(false);
    expect(result.lesson).toEqual(lesson);
  });
});

describe("Lessons.update / archive / recordFired / recordDismissed", () => {
  test("update sends { action:'update', id, patch } and returns {ok:true}", async () => {
    const { calls } = stubRequest(async () => ({ ok: true }));
    const patch = { title: "New Title" };
    const result = await new Lessons().update("id-1", patch);
    expect(calls[0]?.params).toEqual({ action: "update", id: "id-1", patch });
    expect(result).toEqual({ ok: true });
  });

  test("archive sends { action:'archive', id }", async () => {
    const { calls } = stubRequest(async () => ({ ok: true }));
    const result = await new Lessons().archive("id-2");
    expect(calls[0]?.params).toEqual({ action: "archive", id: "id-2" });
    expect(result).toEqual({ ok: true });
  });

  test("recordFired sends { action:'recordFired', id }", async () => {
    const { calls } = stubRequest(async () => ({ ok: true }));
    const result = await new Lessons().recordFired("id-3");
    expect(calls[0]?.params).toEqual({ action: "recordFired", id: "id-3" });
    expect(result).toEqual({ ok: true });
  });

  test("recordDismissed sends { action:'recordDismissed', id }", async () => {
    const { calls } = stubRequest(async () => ({ ok: true }));
    const result = await new Lessons().recordDismissed("id-4");
    expect(calls[0]?.params).toEqual({
      action: "recordDismissed",
      id: "id-4",
    });
    expect(result).toEqual({ ok: true });
  });
});
