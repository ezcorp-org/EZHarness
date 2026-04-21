#!/usr/bin/env bun
// todo-tracker - Scan project files for TODO/FIXME/HACK comments.
// Migrated onto @ezcorp/sdk/runtime (rpc wrappers) in Phase 2.3.

import {
  createToolDispatcher,
  getChannel,
  toolResult,
  toolError,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";

const cwd = process.cwd();

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

function parseTodoLine(line: string, file: string, lineNum: number): TodoEntry | null {
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

async function findSourceFiles(): Promise<string[]> {
  try {
    const result = await Bun.$`find ${cwd} -type f \( -name "*.ts" -o -name "*.js" -o -name "*.svelte" \) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/.svelte-kit/*"`.text();
    return result.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
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
        const content = await Bun.file(file).text();
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const lineText = lines[i];
          if (lineText === undefined) continue;
          const entry = parseTodoLine(lineText, file.slice(cwd.length + 1), i + 1);
          if (entry) todos.push(entry);
        }
      } catch { /* skip unreadable files */ }
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

const tools: Record<string, ToolHandler> = {
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
