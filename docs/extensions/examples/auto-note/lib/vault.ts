// ── Vault CRUD ──────────────────────────────────────────────────
// Filesystem-backed vault with in-memory index for fast lookups.

import { join, dirname } from "path";
import type {
  VaultNote, VaultIndex, VaultStats, Category, ActionItem,
  CaptureResult, PlannedAction, Config, CaptureOverrides,
} from "./types";
import { CATEGORIES } from "./types";
import {
  categorize, generateTitle, slugify, extractTags,
  extractActionItems, findRelatedNotes,
} from "./categorizer";
import {
  findProjectRoot as sdkFindProjectRoot,
  fsRead,
  fsWrite,
  fsMkdir,
  fsExists,
  fsList,
  fsUnlink,
} from "@ezcorp/sdk/runtime";

// Phase 3 fs hardening: this extension runs as a persistent SUBPROCESS, so
// it must use the SDK's host-mediated `fs*` helpers. The legacy host-side
// helpers (`atomicWrite`/`loadJSON`/`saveJSON`) and raw `Bun.file`/`node:fs`
// are poisoned by the sandbox-preload and throw inside a subprocess.

// ── Project Root Detection ──────────────────────────────────────
//
// Thin wrapper over the SDK helper. The SDK version throws when no `.git`
// ancestor is found, but this module runs at import time (see
// `const projectRoot = findProjectRoot()` below), so we preserve the
// original silent-fallback-to-`from` semantics to keep module-load safe
// for environments without a git repo (e.g. some test harnesses).

export function findProjectRoot(from: string = process.cwd()): string {
  try {
    return sdkFindProjectRoot(from);
  } catch {
    return from;
  }
}

// ── Vault Path Helpers ──────────────────────────────────────────
//
// CONVENTION: all extension data lives under
//   <projectRoot>/.ezcorp/extension-data/<extension-name>/
// This keeps the top of a user's repo tidy and means a single `.gitignore`
// entry (`.ezcorp/`) covers every extension's persistent state.

const projectRoot = findProjectRoot();
const EXT_DATA_ROOT = join(projectRoot, ".ezcorp", "extension-data", "auto-note");

export function getVaultRoot(config?: Config): string {
  return config?.vaultPath ?? join(EXT_DATA_ROOT, "vault");
}

let _configPathOverride: string | null = null;

/** Test-only: override the config path so tests don't pollute the real config. */
export function _setConfigPathForTests(path: string | null): void {
  _configPathOverride = path;
}

export function getConfigPath(): string {
  return _configPathOverride ?? join(EXT_DATA_ROOT, "config.json");
}

function vaultAbsPath(vaultRoot: string, vaultRelPath: string): string {
  return join(vaultRoot, vaultRelPath);
}

// ── File I/O ────────────────────────────────────────────────────
//
// Host-mediated (`fsRead`/`fsWrite`/`fsMkdir`). `readFileOrNull` swallows
// ALL read errors (missing OR unreadable) — the vault intentionally treats
// unreadable files as absent. `writeFileEnsuringDir` replaces the legacy
// `atomicWrite`, which created the parent dir before writing; the
// host-mediated `fsWrite` does NOT, so we `fsMkdir` first.

async function readFileOrNull(absPath: string): Promise<string | null> {
  try {
    const result = await fsRead(absPath);
    return typeof result === "string" ? result : new TextDecoder().decode(result);
  } catch {
    return null;
  }
}

// NOTE: non-atomic — unlike the legacy `atomicWrite` (tmp-write + rename),
// the host's `fsWrite` does a plain write with no rename, so an interrupted
// write can leave a half-written file. Acceptable for this single-writer
// example vault; do NOT copy this into a concurrent-write extension without
// adding a write-then-rename step (two host ops).
async function writeFileEnsuringDir(absPath: string, content: string): Promise<void> {
  await fsMkdir(dirname(absPath), { recursive: true });
  await fsWrite(absPath, content);
}

// ── Config ──────────────────────────────────────────────────────

export async function loadConfig(): Promise<Config> {
  const text = await readFileOrNull(getConfigPath());
  if (text === null) return { defaultMode: "approval" };
  try {
    return JSON.parse(text) as Config;
  } catch {
    return { defaultMode: "approval" };
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await writeFileEnsuringDir(getConfigPath(), JSON.stringify(config, null, 2));
}

// ── Index Management ────────────────────────────────────────────

export async function rebuildIndex(vaultRoot: string): Promise<VaultIndex> {
  const index: VaultIndex = {};

  for (const cat of CATEGORIES) {
    const catDir = join(vaultRoot, cat);
    if (!(await fsExists(catDir))) continue;
    const files = (await fsList(catDir))
      .filter((e) => e.isFile && e.name.endsWith(".md"))
      .map((e) => e.name);
    for (const file of files) {
      const absPath = join(catDir, file);
      const content = await readFileOrNull(absPath);
      if (content === null) continue;
      const meta = parseFrontmatter(content);
      if (meta) {
        const relPath = `${cat}/${file}`;
        index[relPath] = meta;
      }
    }
  }
  return index;
}

function parseFrontmatter(content: string): VaultNote | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const yaml = match[1]!;

  const get = (key: string): string | undefined => {
    const m = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m?.[1]?.trim();
  };
  const getArray = (key: string): string[] => {
    const m = yaml.match(new RegExp(`^${key}:\\s*\\[(.*)\\]$`, "m"));
    if (!m) return [];
    return m[1]!.split(",").map((s) => s.trim()).filter(Boolean);
  };
  const getBool = (key: string): boolean => get(key) === "true";

  return {
    title: get("title") ?? "Untitled",
    category: (get("category") as Category) ?? "ideas",
    tags: getArray("tags"),
    created: get("created") ?? new Date().toISOString(),
    updated: get("updated") ?? new Date().toISOString(),
    links: getArray("links"),
    actionable: getBool("actionable"),
  };
}

// ── Frontmatter Generation ──────────────────────────────────────

function buildFrontmatter(note: VaultNote): string {
  const lines = [
    "---",
    `title: ${note.title}`,
    `category: ${note.category}`,
    `tags: [${note.tags.join(", ")}]`,
    `created: ${note.created}`,
    `updated: ${note.updated}`,
  ];
  if (note.links.length > 0) {
    lines.push(`links: [${note.links.join(", ")}]`);
  }
  if (note.actionable) {
    lines.push("actionable: true");
  }
  lines.push("---");
  return lines.join("\n");
}

// ── Note Creation ───────────────────────────────────────────────

export function planCapture(
  text: string,
  index: VaultIndex,
  overrides?: CaptureOverrides,
): { result: CaptureResult; actions: PlannedAction[] } {
  const now = new Date().toISOString();

  // Category: honor override if it's one of the known categories; otherwise
  // fall back to the deterministic keyword matcher. Invalid overrides (e.g.
  // the LLM hallucinates a category) fall through safely.
  const overrideCategory = overrides?.category;
  const category: Category =
    overrideCategory && (CATEGORIES as readonly string[]).includes(overrideCategory)
      ? overrideCategory
      : categorize(text);

  // Title: override wins if non-empty after trim.
  const overrideTitle = overrides?.title?.trim();
  const title = overrideTitle && overrideTitle.length > 0 ? overrideTitle : generateTitle(text);

  const slug = slugify(title);

  // Collect all existing tags for reinforcement
  const allTags = new Set<string>();
  for (const note of Object.values(index)) {
    for (const t of note.tags) allTags.add(t);
  }
  const extractedTags = extractTags(text, allTags);

  // Merge override tags with extracted tags, dedup + sort. Normalize override
  // tags to lowercase to match the convention in extractTags.
  const overrideTags = (overrides?.tags ?? [])
    .map((t) => t.toLowerCase().trim())
    .filter((t) => t.length > 0);
  const tags = [...new Set([...overrideTags, ...extractedTags])].sort();

  // Extract action items
  const rawActions = extractActionItems(text);
  const actionItems: ActionItem[] = rawActions.map((a) => ({
    text: a.sentence,
    taskNotePath: category !== "tasks" ? `tasks/${slugify(a.sentence)}.md` : undefined,
  }));
  const actionable = actionItems.length > 0;

  // Find related notes
  const relatedNotes = findRelatedNotes(tags, index);

  // Build path (handle collisions)
  let path = `${category}/${slug}.md`;
  if (index[path]) {
    path = `${category}/${slug}-${Date.now().toString(36)}.md`;
  }

  const note: VaultNote = {
    title, category, tags, created: now, updated: now,
    links: relatedNotes, actionable,
  };

  const result: CaptureResult = {
    path, note, body: text, actionItems, relatedNotes,
  };

  // Build action plan
  const actions: PlannedAction[] = [];
  actions.push({
    verb: "create",
    target: path,
    description: `Note "${title}" in ${category}/ with tags [${tags.join(", ")}]`,
  });

  for (const related of relatedNotes) {
    actions.push({
      verb: "link",
      target: related,
      description: `Link to "${index[related]?.title ?? related}"`,
    });
    actions.push({
      verb: "backlink",
      target: related,
      description: `Add backlink from "${index[related]?.title ?? related}" → "${title}"`,
    });
  }

  for (const item of actionItems) {
    if (item.taskNotePath) {
      actions.push({
        verb: "extract-task",
        target: item.taskNotePath,
        description: item.text,
      });
    }
  }

  actions.push({
    verb: "update-index",
    description: "Regenerate vault index and _index.md",
  });

  return { result, actions };
}

export async function executeCapture(
  result: CaptureResult,
  index: VaultIndex,
  vaultRoot: string,
): Promise<VaultIndex> {
  const { path, note, body, actionItems, relatedNotes } = result;

  // 1. Build note markdown
  const linkedNotesSection = relatedNotes.length > 0
    ? "\n## Linked Notes\n" +
      relatedNotes.map((r) => `- [[${r}|${index[r]?.title ?? r}]]`).join("\n")
    : "";

  const actionSection = actionItems.length > 0
    ? "\n## Action Items\n" +
      actionItems.map((a) =>
        a.taskNotePath
          ? `- [ ] ${a.text} (-> [[${a.taskNotePath}]])`
          : `- [ ] ${a.text}`
      ).join("\n")
    : "";

  const frontmatter = buildFrontmatter(note);
  const markdown = `${frontmatter}\n\n# ${note.title}\n\n${body}${linkedNotesSection}${actionSection}\n`;

  await writeFileEnsuringDir(vaultAbsPath(vaultRoot, path), markdown);
  index[path] = note;

  // 2. Update backlinks in related notes
  for (const relPath of relatedNotes) {
    const absPath = vaultAbsPath(vaultRoot, relPath);
    const existing = await readFileOrNull(absPath);
    if (!existing) continue;

    const backlinkLine = `- [[${path}|${note.title}]]`;
    if (existing.includes(backlinkLine)) continue;

    let updated: string;
    if (existing.includes("## Linked Notes")) {
      updated = existing.replace(
        /(## Linked Notes\n)/,
        `$1${backlinkLine}\n`,
      );
    } else {
      updated = existing.trimEnd() + `\n\n## Linked Notes\n${backlinkLine}\n`;
    }

    // Update the note's links array in index
    const relNote = index[relPath];
    if (relNote && !relNote.links.includes(path)) {
      relNote.links.push(path);
      // Update frontmatter in file
      updated = updated.replace(/^---\n[\s\S]*?\n---/, buildFrontmatter(relNote));
    }

    await writeFileEnsuringDir(absPath, updated);
  }

  // 3. Create separate task notes for extracted action items
  for (const item of actionItems) {
    if (!item.taskNotePath) continue;
    const taskNote: VaultNote = {
      title: item.text,
      category: "tasks",
      tags: note.tags,
      created: note.created,
      updated: note.updated,
      links: [path],
      actionable: true,
    };
    const taskMd = `${buildFrontmatter(taskNote)}\n\n# ${item.text}\n\nExtracted from [[${path}|${note.title}]]\n\n- [ ] ${item.text}\n`;
    await writeFileEnsuringDir(vaultAbsPath(vaultRoot, item.taskNotePath), taskMd);
    index[item.taskNotePath] = taskNote;
  }

  // 4. Regenerate _index.md
  await generateIndexMd(vaultRoot, index);

  return index;
}

// ── Vault Browsing ──────────────────────────────────────────────

export function buildTree(index: VaultIndex): string {
  const lines: string[] = [".ezcorp/extension-data/auto-note/vault/"];
  const byCategory = new Map<string, string[]>();

  for (const [path, note] of Object.entries(index)) {
    const cat = note.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(path);
  }

  const cats = [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (let ci = 0; ci < cats.length; ci++) {
    const [cat, paths] = cats[ci]!;
    const isLast = ci === cats.length - 1;
    const prefix = isLast ? "└── " : "├── ";
    lines.push(`${prefix}${cat}/ (${paths.length} notes)`);

    const sorted = paths.sort();
    for (let fi = 0; fi < sorted.length; fi++) {
      const file = sorted[fi]!.split("/").pop()!;
      const fIsLast = fi === sorted.length - 1;
      const indent = isLast ? "    " : "│   ";
      const fPrefix = fIsLast ? "└── " : "├── ";
      lines.push(`${indent}${fPrefix}${file}`);
    }
  }

  // Tag cloud
  const tagCounts = new Map<string, number>();
  for (const note of Object.values(index)) {
    for (const t of note.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([t, c]) => `#${t}(${c})`);

  if (topTags.length > 0) {
    lines.push("", `Tags: ${topTags.join("  ")}`);
  }

  lines.push("", `Total: ${Object.keys(index).length} notes`);
  return lines.join("\n");
}

export function searchNotes(
  index: VaultIndex,
  _vaultRoot: string,
  opts: { query?: string; category?: string; tags?: string[] },
): Array<{ path: string; title: string; category: string; tags: string[]; created: string; snippet?: string }> {
  let entries = Object.entries(index);

  if (opts.category && opts.category !== "all") {
    entries = entries.filter(([, n]) => n.category === opts.category);
  }
  if (opts.tags && opts.tags.length > 0) {
    const tagSet = new Set(opts.tags.map((t) => t.toLowerCase()));
    entries = entries.filter(([, n]) => n.tags.some((t) => tagSet.has(t)));
  }

  const results = entries.map(([path, note]) => ({
    path,
    title: note.title,
    category: note.category,
    tags: note.tags,
    created: note.created,
  }));

  // Sort by created date descending
  results.sort((a, b) => b.created.localeCompare(a.created));
  return results.slice(0, 50);
}

export async function readNote(
  vaultRoot: string,
  path: string,
): Promise<string | null> {
  return readFileOrNull(vaultAbsPath(vaultRoot, path));
}

// ── Related Notes (with depth) ──────────────────────────────────

export function findRelated(
  path: string,
  index: VaultIndex,
  depth: number = 1,
): {
  directLinks: string[];
  sharedTagNeighbors: string[];
  sameCategorySiblings: string[];
} {
  const note = index[path];
  if (!note) return { directLinks: [], sharedTagNeighbors: [], sameCategorySiblings: [] };

  // Direct wikilinks
  const directLinks = note.links.filter((l) => index[l]);

  // Shared-tag neighbors (not already direct-linked)
  const directSet = new Set([path, ...directLinks]);
  const tagSet = new Set(note.tags);
  const neighbors: Array<{ path: string; overlap: number }> = [];

  for (const [p, n] of Object.entries(index)) {
    if (directSet.has(p)) continue;
    const overlap = n.tags.filter((t) => tagSet.has(t)).length;
    if (overlap > 0) neighbors.push({ path: p, overlap });
  }
  neighbors.sort((a, b) => b.overlap - a.overlap);
  const sharedTagNeighbors = neighbors.slice(0, 10).map((n) => n.path);

  // Same-category siblings (not already listed)
  const listed = new Set([path, ...directLinks, ...sharedTagNeighbors]);
  const sameCategorySiblings = Object.entries(index)
    .filter(([p, n]) => n.category === note.category && !listed.has(p))
    .map(([p]) => p)
    .slice(0, 5);

  // Depth > 1: follow links of direct links
  if (depth > 1) {
    for (const link of directLinks) {
      const sub = findRelated(link, index, depth - 1);
      for (const p of [...sub.directLinks, ...sub.sharedTagNeighbors]) {
        if (!directSet.has(p) && !sharedTagNeighbors.includes(p)) {
          sharedTagNeighbors.push(p);
        }
      }
    }
  }

  return { directLinks, sharedTagNeighbors, sameCategorySiblings };
}

// ── Refile ───────────────────────────────────────────────────────

export async function refileNote(
  oldPath: string,
  index: VaultIndex,
  vaultRoot: string,
  opts: {
    newCategory?: Category;
    newTags?: string[];
    addTags?: string[];
    removeTags?: string[];
  },
): Promise<{ newPath: string; updatedFiles: string[] }> {
  const note = index[oldPath];
  if (!note) throw new Error(`Note not found: ${oldPath}`);

  const updatedFiles: string[] = [];

  // Update tags
  let tags = [...note.tags];
  if (opts.newTags) {
    tags = opts.newTags;
  } else {
    if (opts.addTags) tags = [...new Set([...tags, ...opts.addTags])];
    if (opts.removeTags) {
      const remove = new Set(opts.removeTags);
      tags = tags.filter((t) => !remove.has(t));
    }
  }
  note.tags = tags;
  note.updated = new Date().toISOString();

  // Move to new category if needed
  let newPath = oldPath;
  if (opts.newCategory && opts.newCategory !== note.category) {
    const filename = oldPath.split("/").pop()!;
    newPath = `${opts.newCategory}/${filename}`;

    // Handle collision
    if (index[newPath]) {
      const base = filename.replace(/\.md$/, "");
      newPath = `${opts.newCategory}/${base}-${Date.now().toString(36)}.md`;
    }

    note.category = opts.newCategory;

    // Read old file, update frontmatter, write to new location
    const content = await readFileOrNull(vaultAbsPath(vaultRoot, oldPath));
    if (content) {
      const updated = content.replace(/^---\n[\s\S]*?\n---/, buildFrontmatter(note));
      await writeFileEnsuringDir(vaultAbsPath(vaultRoot, newPath), updated);
      await fsUnlink(vaultAbsPath(vaultRoot, oldPath));
    }

    // Update index
    delete index[oldPath];
    index[newPath] = note;
    updatedFiles.push(newPath);

    // Fix backlinks in all notes that linked to the old path
    for (const [p, n] of Object.entries(index)) {
      if (n.links.includes(oldPath)) {
        n.links = n.links.map((l) => (l === oldPath ? newPath : l));
        const fileContent = await readFileOrNull(vaultAbsPath(vaultRoot, p));
        if (fileContent) {
          const fixed = fileContent
            .replaceAll(`[[${oldPath}`, `[[${newPath}`)
            .replace(/^---\n[\s\S]*?\n---/, buildFrontmatter(n));
          await writeFileEnsuringDir(vaultAbsPath(vaultRoot, p), fixed);
          updatedFiles.push(p);
        }
      }
    }
  } else {
    // Just update tags in place
    const content = await readFileOrNull(vaultAbsPath(vaultRoot, oldPath));
    if (content) {
      const updated = content.replace(/^---\n[\s\S]*?\n---/, buildFrontmatter(note));
      await writeFileEnsuringDir(vaultAbsPath(vaultRoot, oldPath), updated);
      updatedFiles.push(oldPath);
    }
    index[oldPath] = note;
  }

  await generateIndexMd(vaultRoot, index);
  return { newPath, updatedFiles };
}

// ── Daily Digest ────────────────────────────────────────────────

export function dailyDigest(
  index: VaultIndex,
  date?: string,
): {
  date: string;
  notesCreated: Array<{ path: string; title: string; category: string }>;
  openActionItems: Array<{ path: string; title: string }>;
  suggestedConnections: Array<{ from: string; to: string; sharedTags: string[] }>;
} {
  const targetDate = date ?? new Date().toISOString().slice(0, 10);

  // Notes created on target date
  const notesCreated = Object.entries(index)
    .filter(([, n]) => n.created.startsWith(targetDate))
    .map(([path, n]) => ({ path, title: n.title, category: n.category }));

  // Open action items (notes marked actionable in tasks/)
  const openActionItems = Object.entries(index)
    .filter(([path, n]) => n.actionable && path.startsWith("tasks/"))
    .map(([path, n]) => ({ path, title: n.title }));

  // Suggested connections: pairs of notes with shared tags but no direct link
  const suggestions: Array<{ from: string; to: string; sharedTags: string[] }> = [];
  const paths = Object.keys(index);
  for (let i = 0; i < paths.length && suggestions.length < 5; i++) {
    const a = index[paths[i]!]!;
    for (let j = i + 1; j < paths.length && suggestions.length < 5; j++) {
      const b = index[paths[j]!]!;
      // Skip if already linked
      if (a.links.includes(paths[j]!) || b.links.includes(paths[i]!)) continue;
      const shared = a.tags.filter((t) => b.tags.includes(t));
      if (shared.length >= 2) {
        suggestions.push({ from: paths[i]!, to: paths[j]!, sharedTags: shared });
      }
    }
  }

  return { date: targetDate, notesCreated, openActionItems, suggestedConnections: suggestions };
}

// ── Index Generation ────────────────────────────────────────────

export async function generateIndexMd(vaultRoot: string, index: VaultIndex): Promise<void> {
  const counts: Record<string, number> = {};
  for (const cat of CATEGORIES) counts[cat] = 0;
  for (const note of Object.values(index)) {
    counts[note.category] = (counts[note.category] ?? 0) + 1;
  }

  const recent = Object.entries(index)
    .sort(([, a], [, b]) => b.created.localeCompare(a.created))
    .slice(0, 10);

  const lines = [
    "# Vault Index",
    "",
    `> Auto-generated — ${Object.keys(index).length} notes total`,
    "",
    "## Categories",
    "",
    ...CATEGORIES.map((c) => `- **${c}/** — ${counts[c]} notes`),
    "",
    "## Recent Notes",
    "",
    ...recent.map(([path, n]) => `- [[${path}|${n.title}]] (${n.category}, ${n.created.slice(0, 10)})`),
    "",
  ];

  await writeFileEnsuringDir(join(vaultRoot, "_index.md"), lines.join("\n"));
}

// ── Stats for Panel ─────────────────────────────────────────────

export function computeStats(index: VaultIndex): VaultStats {
  const categoryCounts = {} as Record<Category, number>;
  for (const cat of CATEGORIES) categoryCounts[cat] = 0;

  let totalActionItems = 0;
  const recentCaptures: VaultStats["recentCaptures"] = [];

  for (const [path, note] of Object.entries(index)) {
    // Guard against unknown categories from corrupt frontmatter so we never
    // produce NaN counts (which would serialize as `null` in JSON and drop
    // the kv pair on the panel).
    if (categoryCounts[note.category] == null) categoryCounts[note.category] = 0;
    categoryCounts[note.category]++;
    if (note.actionable) totalActionItems++;
    recentCaptures.push({ path, title: note.title, category: note.category, created: note.created });
  }

  recentCaptures.sort((a, b) => b.created.localeCompare(a.created));

  return {
    totalNotes: Object.keys(index).length,
    categoryCounts,
    totalActionItems,
    completedActionItems: 0, // Would need to parse note content for checkbox state
    recentCaptures: recentCaptures.slice(0, 5),
  };
}
