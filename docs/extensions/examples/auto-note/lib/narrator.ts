// ── Narration Engine ─────────────────────────────────────────────
// Builds human-readable descriptions of actions in future (approval)
// or past (yolo) tense.

import type { PlannedAction } from "./types";

const VERB_LABELS: Record<PlannedAction["verb"], { future: string; past: string }> = {
  create: { future: "Create", past: "Created" },
  link: { future: "Link to", past: "Linked to" },
  backlink: { future: "Add backlink in", past: "Added backlink in" },
  "extract-task": { future: "Extract task note", past: "Extracted task note" },
  "update-index": { future: "Update vault index", past: "Updated vault index" },
};

export function narrateAction(action: PlannedAction, tense: "future" | "past"): string {
  const label = VERB_LABELS[action.verb]?.[tense] ?? action.verb;
  const target = action.target ? ` \`${action.target}\`` : "";
  return `${label}${target}: ${action.description}`;
}

export function narratePlan(actions: PlannedAction[]): string {
  const lines = actions.map((a, i) => `${i + 1}. ${narrateAction(a, "future")}`);
  return `**Here's what I'd like to do:**\n\n${lines.join("\n")}\n\nProceed?`;
}

export function narrateCompleted(actions: PlannedAction[]): string {
  const lines = actions.map((a) => `- ${narrateAction(a, "past")}`);
  return `**Done!**\n\n${lines.join("\n")}`;
}
