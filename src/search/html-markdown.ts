// HTML → markdown extraction for the host-side DIRECT url reader.
//
// Why this exists: `read-url`'s primary backend is Jina's hosted reader
// (`r.jina.ai`), which renders far better markdown than anything we could
// hand-roll. But the keyless tier is gated on NETWORK REPUTATION — upstream
// answers 401 for entire ASNs — so a deployment can be permanently blocked
// through no fault of its own, and `read-url` then fails on EVERY call.
// `DirectReader` (src/search/providers.ts) is the host-side fallback: fetch
// the page ourselves through the SSRF guard and extract the main content
// here.
//
// Locked decision — NO new HTML-parsing dependencies. Extraction uses Bun's
// built-in `HTMLRewriter` (lol-html) with hand-rolled entity decoding,
// exactly like the DuckDuckGo result scraper in `./providers.ts`.
//
// Scope: "reasonable, not perfect". We keep headings, paragraphs, list
// items, table rows, `<pre>` blocks and links; we drop chrome
// (script/style/nav/header/footer/aside/svg/iframe/noscript/canvas/template);
// we prefer `<main>`/`<article>` when the page has one. We do NOT attempt
// readability-style scoring, boilerplate removal by heuristics, image
// handling, or inline emphasis. See docs/features/tools/web-search.md.

/**
 * Named HTML entities we decode. Deliberately a short curated table rather
 * than the full HTML5 named-character-reference set (2231 entries) — these
 * are the ones real article markup actually emits, and the numeric forms
 * below cover everything else.
 *
 * `amp` is NOT in this table: it is decoded LAST (see `decodeHtmlEntities`)
 * so `&amp;lt;` yields the literal text `&lt;` instead of `<`.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  middot: "·",
  bull: "•",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  dagger: "†",
  prime: "′",
  rarr: "→",
  larr: "←",
};

/** Decode a numeric character reference, or return the raw match when the
 *  code point is out of the Unicode range (malformed markup — leave it be
 *  rather than throwing out of a parser callback). */
function fromCodePoint(raw: string, digits: string, radix: number): string {
  const n = Number.parseInt(digits, radix);
  if (!(n >= 0 && n <= 0x10ffff)) return raw;
  return String.fromCodePoint(n);
}

/**
 * Minimal HTML-entity decode. Shared by the DuckDuckGo scraper and the
 * direct URL reader (one implementation, per the DRY rule).
 *
 * Order matters: numeric refs first, then the named table, then `&amp;`
 * LAST — so `&amp;lt;` decodes to the literal `&lt;`, not to `<`.
 */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h: string) => fromCodePoint(m, h, 16))
    .replace(/&#(\d+);/g, (m, d: string) => fromCodePoint(m, d, 10))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/&amp;/g, "&");
}

// ── Tag classification ──────────────────────────────────────────────

/** Chrome / non-content subtrees: their text is dropped entirely. */
const DROP_TAGS: ReadonlySet<string> = new Set([
  "aside",
  "canvas",
  "footer",
  "header",
  "iframe",
  "nav",
  "noscript",
  "script",
  "style",
  "svg",
  "template",
]);

/** Elements that end the current output line. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "ul",
]);

/** When the page has one of these, ONLY its content is returned. */
const MAIN_TAGS: ReadonlySet<string> = new Set(["article", "main"]);

/** Void elements in our selector set — `onEndTag` THROWS on these
 *  ("No end tag"), so we never register a close handler for them. */
const VOID_TAGS: ReadonlySet<string> = new Set(["br", "hr"]);

const HEADING_LEVELS: Readonly<Record<string, number>> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

/** One comma-joined selector for a SINGLE element handler. lol-html
 *  invokes a handler once per matching element, so dispatch happens on
 *  `el.tagName` below. */
const ELEMENT_SELECTOR = [...new Set([...DROP_TAGS, ...BLOCK_TAGS, "a"])].join(", ");

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

interface Line {
  text: string;
  /** List item — consecutive items render without a blank line between. */
  li: boolean;
  /** Emitted inside a `<main>` / `<article>` subtree. */
  main: boolean;
}

/**
 * Convert an HTML document to compact markdown.
 *
 * `baseUrl` (the fetched URL) resolves relative `href`s so the emitted
 * links are usable; links that don't resolve to http(s)/mailto degrade to
 * their plain text.
 */
export async function htmlToMarkdown(html: string, baseUrl?: string): Promise<string> {
  const lines: Line[] = [];
  const linkStack: Array<{ href: string; mark: number }> = [];
  let cur = "";
  let prefix = "";
  let isLi = false;
  let dropDepth = 0;
  let mainDepth = 0;
  let preDepth = 0;

  const push = (text: string, li: boolean): void => {
    if (text.length > 0) lines.push({ text, li, main: mainDepth > 0 });
  };

  const reset = (): void => {
    cur = "";
    prefix = "";
    isLi = false;
    linkStack.length = 0;
  };

  /** Close the current line, collapsing whitespace + decoding entities. */
  const flush = (): void => {
    const text = collapse(decodeHtmlEntities(cur));
    push(text.length > 0 ? prefix + text : "", isLi);
    reset();
  };

  /** Close a `<pre>` — keep the literal whitespace, emit a fenced block. */
  const flushPre = (): void => {
    const body = decodeHtmlEntities(cur).replace(/^\n+/, "").replace(/\s+$/, "");
    push(body.length > 0 ? "```\n" + body + "\n```" : "", false);
    reset();
  };

  /** Resolve an `href` to an absolute http(s)/mailto URL, or null when it
   *  is a fragment / javascript: / unparseable — those become plain text. */
  const resolveHref = (raw: string | null): string | null => {
    if (raw === null) return null;
    const href = raw.trim();
    if (href.length === 0 || href.startsWith("#")) return null;
    let u: URL;
    try {
      u = baseUrl === undefined ? new URL(href) : new URL(href, baseUrl);
    } catch {
      return null; // relative href with no base, or malformed
    }
    if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "mailto:") {
      return null;
    }
    return u.toString();
  };

  const openLink = (raw: string | null): void => {
    const href = resolveHref(raw);
    if (href === null) return;
    linkStack.push({ href, mark: cur.length });
  };

  /** Rewrite the text captured since the anchor opened into `[text](href)`.
   *  The stack can be empty when an intervening block boundary flushed the
   *  line out from under the anchor (`<a href><div>…</div></a>`) — that
   *  anchor's text already shipped, so there is nothing to rewrite. */
  const closeLink = (): void => {
    const entry = linkStack.pop();
    if (entry === undefined) return;
    const inner = collapse(cur.slice(entry.mark));
    cur = cur.slice(0, entry.mark) + (inner.length > 0 ? `[${inner}](${entry.href})` : "");
  };

  const open = (tag: string, href: string | null): void => {
    if (DROP_TAGS.has(tag)) {
      if (dropDepth === 0) flush();
      dropDepth++;
      return;
    }
    if (dropDepth > 0) return;
    // Inside <pre> every tag is literal text — no blocks, no links.
    if (preDepth > 0) return;
    if (tag === "pre") {
      flush();
      preDepth++;
      return;
    }
    if (tag === "a") {
      openLink(href);
      return;
    }
    if (BLOCK_TAGS.has(tag)) flush();
    if (MAIN_TAGS.has(tag)) mainDepth++;
    const level = HEADING_LEVELS[tag];
    if (level !== undefined) prefix = "#".repeat(level) + " ";
    else if (tag === "li") {
      prefix = "- ";
      isLi = true;
    } else if (tag === "title") prefix = "# ";
  };

  const close = (tag: string): void => {
    if (DROP_TAGS.has(tag)) {
      dropDepth--;
      return;
    }
    if (dropDepth > 0) return;
    if (tag === "pre") {
      flushPre();
      preDepth--;
      return;
    }
    if (preDepth > 0) return;
    if (tag === "a") {
      closeLink();
      return;
    }
    // Flush BEFORE leaving the <main> subtree so the last line is still
    // attributed to it.
    if (BLOCK_TAGS.has(tag)) flush();
    if (MAIN_TAGS.has(tag)) mainDepth--;
  };

  await new HTMLRewriter()
    // A single `*` text handler fires exactly ONCE per text chunk (lol-html
    // does not re-invoke the same handler for each matching ancestor), which
    // is why suppression is a depth counter rather than per-selector.
    .on("*", {
      text(t) {
        if (dropDepth === 0) cur += t.text;
      },
    })
    .on(ELEMENT_SELECTOR, {
      element(el) {
        const tag = el.tagName.toLowerCase();
        open(tag, el.getAttribute("href"));
        if (!VOID_TAGS.has(tag)) el.onEndTag(() => close(tag));
      },
    })
    .transform(new Response(html))
    .text();

  // Trailing text with no closing block (malformed markup / bare body text).
  flush();

  const chosen = lines.some((l) => l.main) ? lines.filter((l) => l.main) : lines;
  const out: string[] = [];
  for (let i = 0; i < chosen.length; i++) {
    const line = chosen[i]!;
    // Blank line between blocks; consecutive list items stay tight.
    if (i > 0 && !(line.li && chosen[i - 1]!.li)) out.push("");
    out.push(line.text);
  }
  return out.join("\n");
}
