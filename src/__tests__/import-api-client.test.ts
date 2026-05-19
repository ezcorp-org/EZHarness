import { test, expect, describe, afterEach } from "bun:test";
import {
  importPreview,
  importCommit,
  uninstallExtension,
} from "../../web/src/lib/api";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(
  body: unknown,
  init: ResponseInit = { status: 200 },
): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string, fInit?: RequestInit) => {
    calls.push({ url: String(url), init: fInit });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      ...init,
    });
  }) as unknown as typeof fetch;
  return { calls };
}

describe("import api client helpers", () => {
  test("importPreview POSTs the FormData and returns the result", async () => {
    const { calls } = stubFetch({
      sessionId: "s1",
      fileCount: 2,
      commands: [],
      skills: [],
    });
    const form = new FormData();
    form.append("projectId", "p1");
    const res = await importPreview(form);
    expect(res.sessionId).toBe("s1");
    expect(calls[0]!.url).toContain("/api/import/preview");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBeInstanceOf(FormData);
  });

  test("importCommit POSTs JSON and returns results", async () => {
    const { calls } = stubFetch({ results: [{ kind: "command", status: "ok" }] });
    const out = await importCommit({
      sessionId: "s1",
      projectId: "p1",
      commands: ["c1"],
      skills: [],
    });
    expect(out.results).toHaveLength(1);
    expect(calls[0]!.url).toContain("/api/import/commit");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init?.body as string).sessionId).toBe("s1");
  });

  test("uninstallExtension DELETEs and tolerates 204", async () => {
    const { calls } = stubFetch("", { status: 204 });
    await uninstallExtension("ext-1");
    expect(calls[0]!.url).toContain("/api/extensions/ext-1");
    expect(calls[0]!.init?.method).toBe("DELETE");
  });

  test("uninstallExtension surfaces a non-204 error", async () => {
    stubFetch({ error: "nope" }, { status: 500 });
    let threw = false;
    try {
      await uninstallExtension("ext-2");
    } catch (e) {
      threw = true;
      expect(e instanceof Error ? e.message : "").toContain("nope");
    }
    expect(threw).toBe(true);
  });
});
