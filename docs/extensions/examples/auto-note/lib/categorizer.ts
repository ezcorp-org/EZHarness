// ── Categorization Engine ────────────────────────────────────────
// Deterministic keyword/pattern matching — no LLM required.

import type { Category, VaultIndex } from "./types";

// ── Category Detection ──────────────────────────────────────────

interface CategoryRule {
  category: Category;
  /** Patterns tested against the full (lowercased) text. */
  patterns: RegExp[];
}

const CATEGORY_RULES: CategoryRule[] = [
  {
    category: "meetings",
    patterns: [
      /^meeting:/i, /^standup:/i, /^retro:/i, /^sync:/i, /^1-on-1:/i,
      /\battendees?\b/i, /\baction items from\b/i, /\bmeeting notes\b/i,
    ],
  },
  {
    category: "decisions",
    patterns: [
      /^decision:/i, /^decided:/i,
      /\bwe chose\b/i, /\bwe decided\b/i, /\bgoing with\b/i,
      /\binstead of\b/i, /\bpros and cons\b/i, /\btrade-?off/i,
    ],
  },
  {
    category: "tasks",
    patterns: [
      /^TODO:/i, /^task:/i, /^fix:/i, /^bug:/i,
      /\bneed to\b/i, /\bshould\b/i, /\bmust\b/i,
      /\bdeadline\b/i, /\bblocked on\b/i, /\bassign(?:ed)?\b/i,
    ],
  },
  {
    category: "references",
    patterns: [
      /https?:\/\/\S+/, /```[\s\S]*?```/, /\bdocumentation\b/i,
      /\bsee also\b/i, /\breference\b/i, /\bspec(?:ification)?\b/i,
      /\bapi\b/i, /\bschema\b/i,
    ],
  },
  {
    category: "journal",
    patterns: [
      /^today\b/i, /^this morning\b/i, /^this afternoon\b/i,
      /^reflection:/i, /\bI (?:did|learned|noticed|felt|realized)\b/i,
      /\byesterday\b/i, /\bthis week\b/i,
    ],
  },
  // "ideas" is the default — matched explicitly for high-confidence signals
  {
    category: "ideas",
    patterns: [
      /^idea:/i, /^what if\b/i, /\bwe could\b/i,
      /\bimagine\b/i, /\bbrainstorm/i, /\bhow about\b/i,
    ],
  },
];

export function categorize(text: string): Category {
  const lower = text.toLowerCase();
  // Check rules in priority order; first match wins
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((p) => p.test(lower))) {
      return rule.category;
    }
  }
  return "ideas"; // default fallback
}

// ── Title Generation ────────────────────────────────────────────

/** Category prefixes to strip from the generated title. */
const TITLE_PREFIXES = /^(meeting|standup|retro|sync|decision|decided|todo|task|fix|bug|idea|reflection):\s*/i;

export function generateTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? text.trim();
  const cleaned = firstLine.replace(TITLE_PREFIXES, "").trim();
  // Cap at ~60 chars, break at word boundary
  if (cleaned.length <= 60) return cleaned;
  const truncated = cleaned.slice(0, 60);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 30 ? truncated.slice(0, lastSpace) : truncated) + "...";
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

// ── Tag Extraction ──────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "that", "this", "was", "are",
  "be", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "can", "not", "no", "so", "if",
  "then", "than", "when", "what", "which", "who", "how", "all", "each",
  "every", "both", "few", "more", "most", "some", "any", "we", "our",
  "us", "i", "my", "me", "you", "your", "they", "their", "them", "he",
  "she", "his", "her", "its", "been", "being", "about", "up", "out",
  "just", "also", "very", "like", "into", "over", "after", "before",
]);

export function extractTags(text: string, existingTags?: Set<string>): string[] {
  const tags = new Set<string>();

  // 1. Explicit #tags
  for (const match of text.matchAll(/#([a-zA-Z][a-zA-Z0-9_-]*)/g)) {
    tags.add(match[1]!.toLowerCase());
  }

  // 2. @mentions → person tags
  for (const match of text.matchAll(/@([a-zA-Z][a-zA-Z0-9_-]*)/g)) {
    tags.add(match[1]!.toLowerCase());
  }

  // 3. Reinforce existing vault tags found in text
  if (existingTags) {
    const lower = text.toLowerCase();
    for (const tag of existingTags) {
      if (lower.includes(tag) && !tags.has(tag)) {
        tags.add(tag);
      }
    }
  }

  // 4. Extract significant nouns (simple heuristic: multi-char words not in stop list)
  const words = text
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));

  // Take top frequent words as candidate tags (max 5 new ones)
  const freq = new Map<string, number>();
  for (const w of words) {
    if (!tags.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  let added = 0;
  for (const [word] of sorted) {
    if (added >= 5) break;
    if (word.length > 3) {
      tags.add(word);
      added++;
    }
  }

  return [...tags].sort();
}

// ── Action Item Extraction ──────────────────────────────────────

const ACTION_PATTERNS = [
  /\bneed to\s+\w+/i,
  /\bshould\s+\w+/i,
  /\bmust\s+\w+/i,
  /\bTODO:\s*.+/i,
  /\b(?:migrate|fix|create|update|review|deploy|implement|refactor|remove|add|write|test|check|configure|set up)\s+.+/i,
];

const DEADLINE_PATTERNS = [
  /\bbefore\s+\w+/i,
  /\bby\s+(?:end of|next|this)\s+\w+/i,
  /\bASAP\b/i,
  /\burgent(?:ly)?\b/i,
  /\bdeadline\b/i,
];

export interface ExtractedAction {
  sentence: string;
  hasDeadline: boolean;
}

export function extractActionItems(text: string): ExtractedAction[] {
  const sentences = text
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 5);

  const actions: ExtractedAction[] = [];
  for (const sentence of sentences) {
    const isAction = ACTION_PATTERNS.some((p) => p.test(sentence));
    if (isAction) {
      const hasDeadline = DEADLINE_PATTERNS.some((p) => p.test(sentence));
      actions.push({ sentence, hasDeadline });
    }
  }
  return actions;
}

// ── Related Notes Discovery ─────────────────────────────────────

export function findRelatedNotes(
  tags: string[],
  index: VaultIndex,
  excludePath?: string,
): string[] {
  const tagSet = new Set(tags);
  const scored: Array<{ path: string; score: number }> = [];

  for (const [path, note] of Object.entries(index)) {
    if (path === excludePath) continue;
    const overlap = note.tags.filter((t) => tagSet.has(t)).length;
    if (overlap > 0) {
      scored.push({ path, score: overlap });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((s) => s.path);
}
