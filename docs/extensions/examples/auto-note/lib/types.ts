// ── Auto Note Types ──────────────────────────────────────────────

export const CATEGORIES = ["ideas", "tasks", "decisions", "references", "journal", "meetings"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface VaultNote {
  title: string;
  category: Category;
  tags: string[];
  created: string; // ISO timestamp
  updated: string;
  links: string[]; // vault-relative paths of linked notes
  actionable: boolean;
}

/** In-memory + KV index: path → metadata (no body content). */
export type VaultIndex = Record<string, VaultNote>;

export interface ActionItem {
  text: string;
  /** If a separate task note was created, its vault path. */
  taskNotePath?: string;
}

/**
 * Optional overrides a caller (typically the auto-note agent running on the
 * platform LLM) can pass to `capture` to skip the keyword-based heuristics.
 * Any field that is omitted or rejected by validation falls back to the
 * deterministic pipeline in `lib/categorizer.ts`.
 */
export interface CaptureOverrides {
  category?: Category;
  title?: string;
  tags?: string[];
}

export interface CaptureResult {
  path: string;
  note: VaultNote;
  body: string;
  actionItems: ActionItem[];
  relatedNotes: string[]; // paths that were linked + backlinked
}

/** One step in an approval-mode action plan. */
export interface PlannedAction {
  verb: "create" | "link" | "backlink" | "extract-task" | "update-index";
  description: string;
  /** Vault-relative path affected. */
  target?: string;
}

export interface ActionPlan {
  id: string;
  text: string; // original note text
  mode: "approval";
  result: CaptureResult;
  actions: PlannedAction[];
  createdAt: string;
}

export interface Config {
  vaultPath?: string; // custom vault root (default: $CWD/.ezcorp/extension-data/auto-note/vault)
  defaultMode: "approval" | "yolo";
}

export interface VaultStats {
  totalNotes: number;
  categoryCounts: Record<Category, number>;
  totalActionItems: number;
  completedActionItems: number;
  recentCaptures: Array<{ path: string; title: string; category: Category; created: string }>;
}
