// ── Lessons — typed client for ezcorp/lessons reverse RPC ──────
//
// `write()` returns `{lesson, created: boolean}` so callers can
// distinguish a fresh insert from a slug-collision soft outcome
// (the host returns the existing row unchanged on collision rather
// than throwing — so an extension that re-runs its distiller on
// the same conversation gets a stable identity).

import { getChannel } from "./channel";

export type LessonVisibility = "user" | "project";

export interface LessonRecord {
  id: string;
  projectId: string;
  ownerId: string;
  visibility: LessonVisibility | "global";
  slug: string;
  title: string;
  body: string;
  frontmatter: Record<string, unknown> | null;
  source: string;
  authorExtensionId: string | null;
  firedCount: number;
  lastFiredAt: string | null;
  dismissedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LessonInput {
  slug: string;
  title: string;
  body: string;
  visibility?: LessonVisibility;
  frontmatter?: Record<string, unknown>;
  projectId: string;
}

export interface LessonsListOpts {
  projectId?: string;
  limit?: number;
}

export class Lessons {
  async list(opts?: LessonsListOpts): Promise<LessonRecord[]> {
    const result = await getChannel().request<{ lessons: LessonRecord[] }>(
      "ezcorp/lessons",
      {
        action: "list",
        ...(opts?.projectId !== undefined ? { projectId: opts.projectId } : {}),
        ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
      },
    );
    return result.lessons;
  }

  async get(id: string): Promise<LessonRecord | null> {
    const result = await getChannel().request<{ lesson: LessonRecord | null }>(
      "ezcorp/lessons",
      { action: "get", id },
    );
    return result.lesson;
  }

  async getBySlug(slug: string, projectId: string): Promise<LessonRecord | null> {
    const result = await getChannel().request<{ lesson: LessonRecord | null }>(
      "ezcorp/lessons",
      { action: "get", slug, projectId },
    );
    return result.lesson;
  }

  async write(input: LessonInput): Promise<{ lesson: LessonRecord | null; created: boolean }> {
    return getChannel().request<{ lesson: LessonRecord | null; created: boolean }>(
      "ezcorp/lessons",
      { action: "write", input },
    );
  }

  async update(id: string, patch: Partial<LessonInput>): Promise<{ ok: true }> {
    return getChannel().request<{ ok: true }>(
      "ezcorp/lessons",
      { action: "update", id, patch },
    );
  }

  async archive(id: string): Promise<{ ok: true }> {
    return getChannel().request<{ ok: true }>(
      "ezcorp/lessons",
      { action: "archive", id },
    );
  }

  async recordFired(id: string): Promise<{ ok: true }> {
    return getChannel().request<{ ok: true }>(
      "ezcorp/lessons",
      { action: "recordFired", id },
    );
  }

  async recordDismissed(id: string): Promise<{ ok: true }> {
    return getChannel().request<{ ok: true }>(
      "ezcorp/lessons",
      { action: "recordDismissed", id },
    );
  }
}
