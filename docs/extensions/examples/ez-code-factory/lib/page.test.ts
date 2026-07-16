import { test, expect, describe } from "bun:test";
import { buildDashboard, shortSha, STATUS_BADGE } from "./page";
import type { RunRecord, RunStatus } from "./runs";

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run_abc",
    repoId: "0123456789ab",
    branch: "feat/x",
    ref: "refs/heads/feat/x",
    headSha: "abcdef0123456789",
    baseSha: "0000000000000000",
    status: "completed",
    worktreePath: null,
    createdAt: "2026-07-15T08:00:00.000Z",
    updatedAt: "2026-07-15T08:00:05.000Z",
    parkedMs: 0,
    awaitingAgentSince: null,
    intent: null,
    intentSource: null,
    ...over,
  };
}

describe("shortSha", () => {
  test("takes the first 8 chars", () => {
    expect(shortSha("abcdef0123456789")).toBe("abcdef01");
  });
});

describe("STATUS_BADGE", () => {
  test("has a badge for every run status", () => {
    const statuses: RunStatus[] = ["created", "worktree_ready", "completed", "failed"];
    for (const s of statuses) expect(STATUS_BADGE[s]).toBeTruthy();
  });
});

describe("buildDashboard", () => {
  test("renders an empty-state + zeroed stats when there are no runs", () => {
    const tree = buildDashboard([]);
    expect(tree.title).toBe("ez-code-factory");
    const nodes = tree.nodes as Array<Record<string, unknown>>;
    const stats = nodes.find((n) => n.type === "stats") as { items: Array<{ value: string }> };
    expect(stats.items[0]!.value).toBe("0");
    expect(nodes.some((n) => n.type === "empty-state")).toBe(true);
    expect(nodes.some((n) => n.type === "table")).toBe(false);
  });

  test("renders a runs table with per-status stat counts", () => {
    const tree = buildDashboard([
      run({ id: "r1", status: "completed" }),
      run({ id: "r2", status: "failed" }),
      run({ id: "r3", status: "worktree_ready" }),
      run({ id: "r4", status: "created" }),
    ]);
    const nodes = tree.nodes as Array<Record<string, unknown>>;
    const stats = nodes.find((n) => n.type === "stats") as {
      items: Array<{ label: string; value: string }>;
    };
    expect(stats.items.find((i) => i.label === "Total runs")!.value).toBe("4");
    expect(stats.items.find((i) => i.label === "Active")!.value).toBe("2");
    expect(stats.items.find((i) => i.label === "Completed")!.value).toBe("1");
    expect(stats.items.find((i) => i.label === "Failed")!.value).toBe("1");

    const table = nodes.find((n) => n.type === "table") as {
      columns: string[];
      rows: Array<{ cells: string[] }>;
    };
    expect(table.columns).toEqual(["Run", "Branch", "Head", "Status", "Updated"]);
    expect(table.rows).toHaveLength(4);
    // Head SHA is shortened; status badge is rendered; time is trimmed.
    const firstRow = table.rows[0]!.cells;
    expect(firstRow[2]).toBe("abcdef01");
    expect(firstRow[3]).toBe(STATUS_BADGE.completed);
    expect(firstRow[4]).toBe("2026-07-15 08:00");
  });
});
