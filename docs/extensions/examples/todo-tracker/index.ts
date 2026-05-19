#!/usr/bin/env bun
// todo-tracker - Scan project files for TODO/FIXME/HACK comments.
// Migrated onto @ezcorp/sdk/runtime (rpc wrappers) in Phase 2.3.
// Migrated onto host-mediated fsList/fsRead in Phase post-perm-cleanup
// — see tasks/post-perm-cleanup.md Phase B. Raw `Bun.$` (find shell-out)
// and `Bun.file().text()` are poisoned by the sandbox-preload (Phase 3),
// so this extension now walks the source tree via `ezcorp/fs.list` and
// reads each file via `ezcorp/fs.read`.

import {
  createToolDispatcher,
  fsList,
  fsRead,
  getChannel,
  toolResult,
  toolError,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";
import { join } from "node:path";

const cwd = process.cwd();

// Source-file extensions and directory exclusions, mirroring the
// pre-migration `find` shell-out (see ezcorp.config.ts history).
const SOURCE_EXTS = [".ts", ".js", ".svelte"] as const;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".svelte-kit"]);

interface TodoEntry {
  file: string;
  line: number;
  type: string;        // TODO, FIXME, HACK
  priority: string;    // critical, high, medium, low, or ""
  tags: string[];
  deadline: string;    // ISO date or ""
  text: string;
}

// Pattern: // TODO(priority:high, tags:bug,perf, deadline:2025-12-31): description
// Or simply: // TODO: description
const TODO_PATTERN = /\/\/\s*(TODO|FIXME|HACK)\s*(?:\(([^)]*)\))?\s*:?\s*(.*)/i;

/** Parse a single line into a TodoEntry, returning null if it doesn't
 *  match the TODO/FIXME/HACK comment pattern. Exported for unit
 *  testing — pure function, no fs IO. */
export function parseTodoLine(line: string, file: string, lineNum: number): TodoEntry | null {
  const match = line.match(TODO_PATTERN);
  if (!match) return null;

  const type = match[1]!.toUpperCase();
  const meta = match[2] ?? "";
  const text = match[3]!.trim();

  let priority = "";
  const tags: string[] = [];
  let deadline = "";

  // Parse metadata like priority:high, tags:bug,perf, deadline:2025-12-31
  for (const part of meta.split(",").map((s) => s.trim())) {
    const pieces = part.split(":").map((s) => s.trim());
    const key = pieces[0];
    const val = pieces[1];
    if (!key || !val) continue;
    switch (key.toLowerCase()) {
      case "priority": priority = val.toLowerCase(); break;
      case "tags": case "tag": tags.push(...val.split(/[,|]/).map((t) => t.trim())); break;
      case "deadline": case "due": deadline = val; break;
    }
  }

  return { file, line: lineNum, type, priority, tags, deadline, text };
}

/**
 * Walk the project tree under `root` collecting source files we care
 * about. Mirrors the pre-migration `find` shell-out: include `.ts`,
 * `.js`, `.svelte`; skip `node_modules`, `.git`, `dist`, `.svelte-kit`.
 *
 * Phase post-perm-cleanup: routed through host-mediated `fsList` so
 * the sandbox-preload's `Bun.$` denier doesn't break it. Errors at any
 * directory (permission denied, ENOENT mid-walk) are swallowed — the
 * pre-migration `find` would have logged a non-fatal warning to stderr;
 * we just skip the entry. The host's grant-prefix check + per-tool
 * `capabilities.filesystem.mode` gating filters paths the extension
 * shouldn't see; from the extension's POV, any error from `fsList`
 * means "skip and continue" so a single inaccessible subtree doesn't
 * tank the whole scan.
 */
async function findSourceFiles(root: string = cwd): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof fsList>>;
    try {
      entries = await fsList(dir);
    } catch {
      return; // skip dirs we can't list (permission, gone, etc.)
    }
    for (const entry of entries) {
      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile) {
        if (SOURCE_EXTS.some((ext) => entry.name.endsWith(ext))) {
          out.push(join(dir, entry.name));
        }
      }
    }
  }
  await walk(root);
  return out;
}

const scanTodos: ToolHandler = async (args) => {
  const searchQuery = (args.searchQuery as string) ?? "";
  const priority = (args.priority as string) ?? "all";
  const filterTags = (args.tags as string[]) ?? [];
  const deadlineStr = args.deadline as string | undefined;
  const deadlineDate = deadlineStr ? new Date(deadlineStr) : null;

  try {
    const files = await findSourceFiles();
    const todos: TodoEntry[] = [];

    for (const file of files) {
      try {
        // `fsRead` defaults to utf-8 → returns string. The cast is
        // safe given the encoding default; we don't ask for binary
        // anywhere in this extension.
        const content = (await fsRead(file)) as string;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const lineText = lines[i];
          if (lineText === undefined) continue;
          const entry = parseTodoLine(lineText, file.slice(cwd.length + 1), i + 1);
          if (entry) todos.push(entry);
        }
      } catch { /* skip unreadable files (denied, gone mid-scan, etc.) */ }
    }

    // Apply filters
    let filtered = todos;

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter((t) => t.text.toLowerCase().includes(q) || t.type.toLowerCase().includes(q));
    }

    if (priority !== "all") {
      filtered = filtered.filter((t) => t.priority === priority);
    }

    if (filterTags.length > 0) {
      filtered = filtered.filter((t) => filterTags.some((tag) => t.tags.includes(tag)));
    }

    if (deadlineDate) {
      filtered = filtered.filter((t) => {
        if (!t.deadline) return false;
        const d = new Date(t.deadline);
        return !isNaN(d.getTime()) && d <= deadlineDate;
      });
    }

    if (filtered.length === 0) {
      return toolResult(todos.length === 0
        ? "No TODO/FIXME/HACK comments found in the project."
        : `No TODOs match the filters (${todos.length} total TODOs in project).`);
    }

    const reportLines = filtered.map((t) => {
      const meta = [
        t.priority && `priority:${t.priority}`,
        t.tags.length > 0 && `tags:${t.tags.join(",")}`,
        t.deadline && `deadline:${t.deadline}`,
      ].filter(Boolean).join(" ");
      return `${t.file}:${t.line} [${t.type}]${meta ? ` (${meta})` : ""} ${t.text}`;
    });

    return toolResult(
      `Found ${filtered.length} TODO(s)${todos.length !== filtered.length ? ` (filtered from ${todos.length} total)` : ""}:\n\n${reportLines.join("\n")}`,
    );
  } catch (err) {
    return toolError(`Failed: ${(err as Error).message}`);
  }
};

// Exported for `index.test.ts` so the scan-todos handler can be invoked
// directly with stubbed `getChannel().request` for `ezcorp/fs.list` and
// `ezcorp/fs.read`. Smallest API surface change vs. introducing a
// dedicated helper — the dispatcher contract is already public.
export const tools: Record<string, ToolHandler> = {
  "scan-todos": scanTodos,
};

// --- Production wiring ---
//
// Gated on `import.meta.main` so test imports don't open stdin. Order is
// load-bearing: `getChannel()` arms the dispatcher registration before
// `createToolDispatcher(tools)` supplies the handlers; `ch.start()` then
// kicks off the stdin read loop.

if (import.meta.main) {
  const ch = getChannel();
  createToolDispatcher(tools);
  ch.start();
}
