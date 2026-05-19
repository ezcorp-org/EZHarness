/**
 * markdown-speech — turn assistant markdown into clean spoken prose.
 *
 * TTS reads the *raw string* it's given, so markdown syntax becomes
 * audible garbage: `**bold**` is spoken "asterisk asterisk bold…",
 * `## Heading` becomes "hash hash Heading", `[label](https://…)` reads
 * the entire URL aloud, fenced code blocks get spelled out, table
 * pipes turn into "bar bar bar". This module strips all of that and
 * yields only what a person would actually say.
 *
 * Implementation: we tokenize with `marked`'s lexer (the same parser
 * the chat UI already renders with — no new dependency) and walk the
 * token tree extracting readable text. A lexer is used deliberately
 * instead of regex find/replace: regex can't tell `*` inside a code
 * span from emphasis, can't keep a link's label while dropping its
 * href, and mangles nested/unbalanced emphasis. The lexer gets all of
 * that right.
 *
 * Block boundaries (paragraphs, headings, list items, table rows)
 * collapse to single newlines — kokoro-js's sentence splitter treats
 * `\n` as a hard split point, so this also gives natural pauses
 * without injecting fake punctuation that would corrupt short inputs
 * (e.g. a one-word "hello" must come out exactly "hello").
 */

import { lexer, type Token, type Tokens } from "marked";

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function inlineText(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  let out = "";
  for (const t of tokens) out += tokenText(t);
  return out;
}

function tokenText(token: Token): string {
  const generic = token as Tokens.Generic;
  switch (token.type) {
    case "space":
    case "hr":
      return "\n";
    case "br":
      return " ";
    // Fenced/indented code blocks and images are not speech — drop.
    case "code":
    case "image":
      return "";
    case "codespan":
      return decodeEntities((token as Tokens.Codespan).text);
    case "escape":
      return (token as Tokens.Escape).text;
    case "html":
      return decodeEntities(stripTags((token as Tokens.HTML).text));
    case "text": {
      const tx = token as Tokens.Text;
      return tx.tokens && tx.tokens.length
        ? inlineText(tx.tokens)
        : decodeEntities(tx.text);
    }
    // Emphasis/strike: keep the wrapped words, drop the markers.
    // Link: keep the label tokens, drop the href.
    case "strong":
    case "em":
    case "del":
    case "link":
      return inlineText(
        (token as Tokens.Strong | Tokens.Em | Tokens.Del | Tokens.Link)
          .tokens,
      );
    case "paragraph":
    case "heading":
      return (
        inlineText(
          (token as Tokens.Paragraph | Tokens.Heading).tokens,
        ) + "\n"
      );
    case "blockquote":
      return inlineText(generic.tokens as Token[] | undefined) + "\n";
    case "list":
      return (
        (token as Tokens.List).items
          .map((it) => inlineText(it.tokens).trim())
          .filter(Boolean)
          .join("\n") + "\n"
      );
    case "list_item":
      return inlineText((token as Tokens.ListItem).tokens) + "\n";
    case "table": {
      const tb = token as Tokens.Table;
      const row = (cells: Tokens.TableCell[]): string =>
        cells
          .map((c) => inlineText(c.tokens).trim())
          .filter(Boolean)
          .join(", ");
      const head = row(tb.header);
      const body = tb.rows.map(row).filter(Boolean).join("\n");
      return [head, body].filter(Boolean).join("\n") + "\n";
    }
    default:
      if (Array.isArray(generic.tokens)) return inlineText(generic.tokens);
      return typeof generic.text === "string"
        ? decodeEntities(generic.text)
        : "";
  }
}

/**
 * Scrub markdown markers the lexer leaves behind as literal text when
 * they're unbalanced or stand alone — a lone `**`, a `--`/`***` rule
 * the tokenizer treated as a paragraph, a stray backtick. The lexer
 * handles *well-formed* markdown; this catches the ragged edges so
 * none of `* _ ~ # \` --` is ever spoken. Rules are whitespace-bounded
 * so `snake_case`, `well-known`, and `C#` survive intact.
 */
function scrubResidue(s: string): string {
  return s
    .replace(/^[ \t]*(?:\*{1,3}|_{1,3}|~~|-{2,}|={2,}|#{1,6})[ \t]*$/gm, "\n")
    .replace(/[ \t]+-{2,}[ \t]+/g, ", ")
    .replace(/(^|\s)(?:\*{1,3}|_{1,3}|~~|`+|#{1,6})(?=\s|$)/g, "$1");
}

function finalize(s: string): string {
  return scrubResidue(s)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Last-ditch strip if the lexer ever throws on pathological input —
 * a TTS request must never die over a markdown parser edge case.
 */
function crudeStrip(s: string): string {
  return finalize(
    s
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>+\s?/gm, "")
      .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, "")
      .replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, " ")
      .replace(/(\*\*\*|\*\*|\*|___|__|_|~~)(.*?)\1/g, "$2")
      .replace(/\|/g, " "),
  );
}

/**
 * Convert a markdown string to clean, speakable plain text. Plain
 * prose passes through unchanged (modulo whitespace normalization).
 */
export function markdownToSpeech(input: string): string {
  if (!input) return "";
  let tokens: Token[];
  try {
    tokens = lexer(input);
  } catch {
    return crudeStrip(input);
  }
  let out = "";
  for (const tk of tokens) out += tokenText(tk);
  return finalize(out);
}
