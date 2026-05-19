import { test, expect, describe, afterEach } from "bun:test";
import {
  extractTitle,
  extractText,
  summarizeOne,
  summarizeUrlsList,
  summarizeUrls,
  _setBackendsForTests,
  _resetBackendsForTests,
  type UrlSummary,
} from "../lib/summarize";

// ── Fake fetch + LLM ────────────────────────────────────────────

interface CapturedLlmCall {
  systemPrompt?: string;
  userContent: string;
  maxTokens?: number;
}

function makeBackends(opts: {
  pages?: Record<string, { status: number; html: string }>;
  failPages?: string[];
  llmAnswers?: string[];
  llmShouldThrow?: Error;
}) {
  const state = {
    llmCalls: [] as CapturedLlmCall[],
    fetchCalls: [] as string[],
    fetchErrors: opts.failPages ?? [],
  };
  const pages = opts.pages ?? {};
  let answerIdx = 0;
  const fakeFetch = async (url: string) => {
    state.fetchCalls.push(url);
    if (state.fetchErrors.includes(url)) {
      throw new Error(`mock fetch failure for ${url}`);
    }
    const page = pages[url];
    if (!page) return { ok: false, status: 404, text: async () => "" };
    return {
      ok: page.status >= 200 && page.status < 300,
      status: page.status,
      text: async () => page.html,
    };
  };
  const fakeLlm = {
    async complete(args: {
      provider: string;
      model: string;
      systemPrompt?: string;
      messages: Array<{ role: string; content: string }>;
      maxTokens?: number;
    }) {
      if (opts.llmShouldThrow) throw opts.llmShouldThrow;
      const userContent = args.messages.find((m) => m.role === "user")?.content ?? "";
      state.llmCalls.push({
        ...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
        userContent,
        ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
      });
      const answers = opts.llmAnswers ?? [];
      const out = answers[answerIdx % Math.max(answers.length, 1)] ?? `summary-${answerIdx}`;
      answerIdx++;
      return { content: out };
    },
  };
  return { state, fakeFetch, fakeLlm };
}

function text(res: { content: Array<{ text: string }> }): string {
  return res.content[0]!.text;
}

afterEach(() => {
  _resetBackendsForTests();
});

// ── HTML extraction ─────────────────────────────────────────────

describe("extractTitle", () => {
  test("pulls the <title> tag", () => {
    expect(extractTitle("<html><head><title>Hello</title></head></html>")).toBe("Hello");
  });
  test("decodes common entities", () => {
    expect(extractTitle("<title>A &amp; B &quot;1&quot;</title>")).toBe('A & B "1"');
  });
  test("collapses whitespace", () => {
    expect(extractTitle("<title>  Lots   of   spaces  </title>")).toBe("Lots of spaces");
  });
  test("returns empty string when missing", () => {
    expect(extractTitle("<html><body>no title</body></html>")).toBe("");
  });
});

describe("extractText", () => {
  test("strips script + style + tags", () => {
    const html = `
      <html><head><style>.x{color:red}</style></head>
      <body>
        <script>var x=1;</script>
        <p>Hello <b>world</b>!</p>
      </body></html>`;
    const out = extractText(html);
    // Inline tag replacement leaves single-space joins ("Hello world !")
    // which is fine — we're feeding this to an LLM, not rendering it.
    expect(out).toContain("Hello");
    expect(out).toContain("world");
    expect(out).not.toContain("<");
    expect(out).not.toContain("color:red");
    expect(out).not.toContain("var x=1");
  });
  test("decodes the common entities", () => {
    expect(extractText("<p>A &amp; B</p>")).toBe("A & B");
  });
  test("caps at the byte limit", () => {
    const big = `<p>${"x".repeat(20_000)}</p>`;
    const out = extractText(big, 1024);
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(1024);
  });
});

// ── summarizeOne ────────────────────────────────────────────────

describe("summarizeOne", () => {
  test("happy path — fetch + LLM, returns title + summary", async () => {
    const { state, fakeFetch, fakeLlm } = makeBackends({
      pages: {
        "https://x.test/a": {
          status: 200,
          html: "<html><head><title>Article A</title></head><body>Body text A.</body></html>",
        },
      },
      llmAnswers: ["short summary of A"],
    });
    _setBackendsForTests({ fetch: fakeFetch, llm: fakeLlm });

    const res = await summarizeOne("https://x.test/a");
    expect(res.url).toBe("https://x.test/a");
    expect(res.title).toBe("Article A");
    expect(res.summary).toBe("short summary of A");
    expect(res.error).toBeUndefined();
    expect(state.fetchCalls).toEqual(["https://x.test/a"]);
    // Verify the LLM saw the URL + title + extracted text.
    expect(state.llmCalls).toHaveLength(1);
    expect(state.llmCalls[0]?.userContent).toContain("https://x.test/a");
    expect(state.llmCalls[0]?.userContent).toContain("Article A");
    expect(state.llmCalls[0]?.userContent).toContain("Body text A.");
  });

  test("respects maxWordsPerSummary by threading it into systemPrompt + maxTokens", async () => {
    const { state, fakeFetch, fakeLlm } = makeBackends({
      pages: { "https://x.test/a": { status: 200, html: "<title>A</title><p>body</p>" } },
      llmAnswers: ["s"],
    });
    _setBackendsForTests({ fetch: fakeFetch, llm: fakeLlm });

    await summarizeOne("https://x.test/a", { maxWordsPerSummary: 50 });
    expect(state.llmCalls[0]?.systemPrompt).toContain("~50 words");
    expect(state.llmCalls[0]?.maxTokens).toBe(Math.ceil(50 * 1.6));
  });

  test("clamps maxWordsPerSummary to the 400 ceiling", async () => {
    const { state, fakeFetch, fakeLlm } = makeBackends({
      pages: { "https://x.test/a": { status: 200, html: "<title>A</title><p>body</p>" } },
      llmAnswers: ["s"],
    });
    _setBackendsForTests({ fetch: fakeFetch, llm: fakeLlm });

    await summarizeOne("https://x.test/a", { maxWordsPerSummary: 99_999 });
    expect(state.llmCalls[0]?.systemPrompt).toContain("~400 words");
  });

  test("falls back to default when maxWordsPerSummary is junk", async () => {
    const { state, fakeFetch, fakeLlm } = makeBackends({
      pages: { "https://x.test/a": { status: 200, html: "<title>A</title><p>body</p>" } },
      llmAnswers: ["s"],
    });
    _setBackendsForTests({ fetch: fakeFetch, llm: fakeLlm });

    await summarizeOne("https://x.test/a", { maxWordsPerSummary: -5 });
    expect(state.llmCalls[0]?.systemPrompt).toContain("~80 words");
  });

  test("fetch failure returns a per-URL error, never throws", async () => {
    const { fakeFetch, fakeLlm } = makeBackends({
      failPages: ["https://x.test/a"],
    });
    _setBackendsForTests({ fetch: fakeFetch, llm: fakeLlm });

    const res = await summarizeOne("https://x.test/a");
    expect(res.error).toContain("fetch failed");
    expect(res.summary).toBe("");
  });

  test("non-2xx returns a per-URL HTTP error", async () => {
    const { fakeFetch, fakeLlm } = makeBackends({
      pages: { "https://x.test/a": { status: 503, html: "" } },
    });
    _setBackendsForTests({ fetch: fakeFetch, llm: fakeLlm });

    const res = await summarizeOne("https://x.test/a");
    expect(res.error).toBe("HTTP 503");
  });

  test("3xx redirect is refused (SSRF guard, never silently followed)", async () => {
    // Simulate a redirect response surfaced by `redirect: "manual"`.
    // `r.ok` is false for any non-2xx, so the fake returns ok=false +
    // status=301 just like a real fetch would under manual redirect mode.
    const fakeFetch = async () => ({
      ok: false,
      status: 301,
      text: async () => "",
    });
    const fakeLlm = {
      async complete() {
        // The LLM must NOT be called on a redirect path.
        throw new Error("LLM should not be invoked for refused redirects");
      },
    };
    _setBackendsForTests({ fetch: fakeFetch, llm: fakeLlm });

    const res = await summarizeOne("https://public.example/r");
    expect(res.summary).toBe("");
    expect(res.error).toContain("redirect refused");
    expect(res.error).toContain("301");
  });

  test("empty text after extraction returns no-text error", async () => {
    const { fakeFetch, fakeLlm } = makeBackends({
      pages: { "https://x.test/a": { status: 200, html: "<script>x</script>" } },
    });
    _setBackendsForTests({ fetch: fakeFetch, llm: fakeLlm });

    const res = await summarizeOne("https://x.test/a");
    expect(res.error).toBe("no extractable text");
  });

  test("LLM failure surfaces as a per-URL error", async () => {
    const { fakeFetch, fakeLlm } = makeBackends({
      pages: { "https://x.test/a": { status: 200, html: "<title>A</title><p>body</p>" } },
      llmShouldThrow: new Error("upstream 429"),
    });
    _setBackendsForTests({ fetch: fakeFetch, llm: fakeLlm });

    const res = await summarizeOne("https://x.test/a");
    expect(res.error).toContain("LLM failed");
    expect(res.error).toContain("upstream 429");
  });

  test("missing title falls back to the URL", async () => {
    const { fakeFetch, fakeLlm } = makeBackends({
      pages: { "https://x.test/a": { status: 200, html: "<p>just a body</p>" } },
      llmAnswers: ["s"],
    });
    _setBackendsForTests({ fetch: fakeFetch, llm: fakeLlm });

    const res = await summarizeOne("https://x.test/a");
    expect(res.title).toBe("https://x.test/a");
  });
});

// ── summarizeUrlsList — multi-URL ───────────────────────────────

describe("summarizeUrlsList", () => {
  test("runs sequentially, one summary per URL", async () => {
    const { state, fakeFetch, fakeLlm } = makeBackends({
      pages: {
        "https://x.test/a": { status: 200, html: "<title>A</title><p>aa</p>" },
        "https://x.test/b": { status: 200, html: "<title>B</title><p>bb</p>" },
        "https://x.test/c": { status: 200, html: "<title>C</title><p>cc</p>" },
      },
      llmAnswers: ["sum-A", "sum-B", "sum-C"],
    });
    _setBackendsForTests({ fetch: fakeFetch, llm: fakeLlm });

    const out: UrlSummary[] = await summarizeUrlsList([
      "https://x.test/a",
      "https://x.test/b",
      "https://x.test/c",
    ]);
    expect(out.map((s) => s.summary)).toEqual(["sum-A", "sum-B", "sum-C"]);
    expect(state.fetchCalls).toHaveLength(3);
    expect(state.llmCalls).toHaveLength(3);
  });

  test("a failing URL does not stop the rest", async () => {
    const { fakeFetch, fakeLlm } = makeBackends({
      pages: {
        "https://x.test/a": { status: 200, html: "<title>A</title><p>aa</p>" },
        "https://x.test/c": { status: 200, html: "<title>C</title><p>cc</p>" },
      },
      failPages: ["https://x.test/b"],
      llmAnswers: ["sum-A", "sum-C"],
    });
    _setBackendsForTests({ fetch: fakeFetch, llm: fakeLlm });

    const out = await summarizeUrlsList([
      "https://x.test/a",
      "https://x.test/b",
      "https://x.test/c",
    ]);
    expect(out[0]?.summary).toBe("sum-A");
    expect(out[1]?.error).toContain("fetch failed");
    expect(out[2]?.summary).toBe("sum-C");
  });
});

// ── Tool wrapper (summarize_urls) ───────────────────────────────

describe("summarize_urls tool", () => {
  test("happy path returns structured JSON", async () => {
    const { fakeFetch, fakeLlm } = makeBackends({
      pages: { "https://x.test/a": { status: 200, html: "<title>A</title><p>aa</p>" } },
      llmAnswers: ["sum"],
    });
    _setBackendsForTests({ fetch: fakeFetch, llm: fakeLlm });

    const res = await summarizeUrls({ urls: ["https://x.test/a"] });
    expect(res.isError).toBe(false);
    const parsed = JSON.parse(text(res)) as { summaries: UrlSummary[] };
    expect(parsed.summaries).toHaveLength(1);
    expect(parsed.summaries[0]?.summary).toBe("sum");
  });

  test("rejects when urls is not an array", async () => {
    const res = await summarizeUrls({ urls: "not-an-array" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("requires 'urls' array");
  });

  test("rejects when urls is empty", async () => {
    const res = await summarizeUrls({ urls: [] });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("at least one");
  });

  test("rejects non-http(s) URLs up front", async () => {
    const res = await summarizeUrls({ urls: ["file:///etc/passwd"] });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("must be http/https");
  });

  test("rejects javascript: URLs (XSS-style)", async () => {
    const res = await summarizeUrls({ urls: ["javascript:alert(1)"] });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("must be http/https");
  });

  test("rejects data: URLs (inline payload)", async () => {
    const res = await summarizeUrls({ urls: ["data:text/plain,foo"] });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("must be http/https");
  });

  test("filters non-string entries before checking length", async () => {
    const res = await summarizeUrls({ urls: [123, true, null] });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("at least one string URL");
  });

  test("accepts maxWordsPerSummary and threads it through", async () => {
    const { state, fakeFetch, fakeLlm } = makeBackends({
      pages: { "https://x.test/a": { status: 200, html: "<title>A</title><p>aa</p>" } },
      llmAnswers: ["s"],
    });
    _setBackendsForTests({ fetch: fakeFetch, llm: fakeLlm });

    const res = await summarizeUrls({
      urls: ["https://x.test/a"],
      maxWordsPerSummary: 120,
    });
    expect(res.isError).toBe(false);
    expect(state.llmCalls[0]?.systemPrompt).toContain("~120 words");
  });
});
