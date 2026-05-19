// ── Schedule — typed client for ezcorp/schedule reverse RPC ────
//
// Manifest-only registration: cron expressions live in the manifest's
// `permissions.schedule.crons[]`; the host's reconciler creates rows
// in `extension_schedules` at install time. The SDK class lets the
// extension wire a handler per cron AND optionally `fireNow(cron)`
// to invoke the handler immediately (counts against quota).
//
// SDK silently drops `on()` calls for crons not in the manifest —
// defense-in-depth; the manifest is the source of truth.

import { getChannel } from "./channel";

export interface ScheduleHandlerContext {
  cron: string;
  scheduledAt: string; // ISO timestamp
  firedAt: string;     // ISO timestamp
  fireId: string;
  catchUp: boolean;
  retry: boolean;
  attempt: number;
}

export type ScheduleHandler = (ctx: ScheduleHandlerContext) => Promise<void> | void;

const handlers = new Map<string, ScheduleHandler>();
let receiverInstalled = false;

function installReceiver(): void {
  if (receiverInstalled) return;
  receiverInstalled = true;
  getChannel().onRequest("ezcorp/schedule-fire", async (params: unknown) => {
    const ctx = params as ScheduleHandlerContext;
    const handler = handlers.get(ctx.cron);
    if (!handler) {
      // Silent drop — no manifest registration for this cron. The
      // host should never fire one we didn't declare; this is
      // defense-in-depth.
      return undefined;
    }
    await handler(ctx);
    return undefined;
  });
}

export class Schedule {
  /** Register a handler for the given cron. Manifest must declare
   *  the same cron in `permissions.schedule.crons` — the host
   *  refuses to fire any unmatched cron. */
  on(cron: string, handler: ScheduleHandler): void {
    handlers.set(cron, handler);
    installReceiver();
  }

  /** Fire-now invocation — counts against the daily-runs quota. */
  async fireNow(cron: string): Promise<void> {
    await getChannel().request<void>("ezcorp/schedule", {
      action: "fire-now", cron,
    });
  }
}
