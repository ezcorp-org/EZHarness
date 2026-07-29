// ── Triggers — dynamic cron + webhook registration (C2) ──────────────
//
// `Schedule` and `Webhook` are MANIFEST-tier: the author declares a fixed
// list of crons/slugs and the host reconciles rows at install time. This
// class is the RUNTIME tier — the extension mints triggers as its users
// create them ("run this job every Monday at 3am"), bounded by the
// `permissions.triggers` envelope the manifest declares and the user
// approved at install.
//
// ── The key is the identity ─────────────────────────────────────────
//
// You supply a `key` (`"job:42"`); everything else is host-derived. Two of
// your jobs can share a cron expression — the normal case, not an edge
// case — and stay distinguishable, because dispatch is keyed on `key`, not
// on the cron string.
//
// That is why this class has its OWN receiver (`ezcorp/trigger-fire`)
// rather than reusing `Schedule`'s. `Schedule` resolves its handler with
// `handlers.get(ctx.cron)`, so two jobs on `0 9 * * 1` would both land on
// the same handler with no way to tell which fired. `Schedule.on` and
// `ezcorp/schedule-fire` are untouched by C2; manifest crons behave exactly
// as they always have.
//
// ── You never choose a slug ──────────────────────────────────────────
//
// `register({kind: "webhook"})` takes no slug. The host mints it under your
// manifest's declared `webhookPrefix` from a digest of your extension name
// and the key, and hands back the URL. There is no wire field in which to
// name a slug, so you cannot collide with — or forge — another extension's
// hook even by accident.
//
// ── A fire is OWNERLESS ──────────────────────────────────────────────
//
// A cron or webhook fire has no conversation and no user, so an
// owner-scoped reverse-RPC made from inside a `on()` handler soft-fails
// with `-32106`. That includes `ctx.workflows.run(...)`. Registering a
// trigger works today; ACTING on the fire arrives with delegated execution.
// Plan handler bodies accordingly.

import { getChannel } from "./channel";

export type TriggerKind = "cron" | "webhook";

/** What the host pushes on `ezcorp/trigger-fire`. Unlike
 *  {@link ScheduleHandlerContext} this carries the JOB IDENTITY (`key`),
 *  which is what makes two jobs sharing a cron expression distinguishable. */
export interface TriggerFireContext {
  v: 1;
  /** The key you registered. Always present — this is the job's identity. */
  key: string;
  kind: TriggerKind;
  firedAt: string; // ISO timestamp
  fireId: string;
  /** True when this fire was drained from a backlog after the subprocess
   *  was down (cron-style catch-up). */
  catchUp: boolean;
  attempt: number;
  /** Cron expression, for a `kind: "cron"` fire. */
  cron?: string;
  /** Inbound delivery payload, for a `kind: "webhook"` fire. UNTRUSTED. */
  payload?: unknown;
}

export type TriggerHandler = (ctx: TriggerFireContext) => Promise<void> | void;

/** A registered cron trigger, as returned by `register` / `list`. */
export interface CronTrigger {
  kind: "cron";
  key: string;
  cron: string;
  timezone?: string | null;
  enabled?: boolean;
  /** The per-key daily fire cap the host derived from your envelope. */
  maxRunsPerDay?: number | null;
  nextFireAt?: string;
}

/** A registered webhook trigger. The secret is NOT here — rotate the hook
 *  to obtain a token. */
export interface WebhookTrigger {
  kind: "webhook";
  key: string;
  slug: string;
  url: string;
  enabled?: boolean;
}

export type RegisteredTrigger = CronTrigger | WebhookTrigger;

export interface RegisterCronOpts {
  kind: "cron";
  key: string;
  cron: string;
  /** IANA zone, e.g. `"America/New_York"`. Defaults to the host's. */
  timezone?: string;
}

export interface RegisterWebhookOpts {
  kind: "webhook";
  key: string;
}

export type RegisterOpts = RegisterCronOpts | RegisterWebhookOpts;

// Keyed by `key`, NOT by cron — see the header. This is the whole reason
// `ezcorp/trigger-fire` exists as a separate notification.
const handlers = new Map<string, TriggerHandler>();
let receiverInstalled = false;

function installReceiver(): void {
  if (receiverInstalled) return;
  receiverInstalled = true;

  // The host's orphan sweep asks, on extension start, which keys are still
  // live. Answering from the HANDLER REGISTRY is the honest answer: a key
  // you have not wired a handler for cannot do anything when it fires.
  //
  // This responder is installed by `on()`, never at import. That is
  // deliberate — an extension that has wired no handlers yet answers
  // `-32601 Method not found`, which the host reads as "unknown, disable
  // nothing" rather than as "zero live keys". Without that asymmetry, an
  // extension that registers rows before wiring handlers would have every
  // one of its users' jobs swept away on the next restart.
  getChannel().onRequest("ezcorp/triggers-sync", async () => ({
    v: 1,
    keys: [...handlers.keys()],
  }));

  getChannel().onRequest("ezcorp/trigger-fire", async (params: unknown) => {
    const ctx = params as TriggerFireContext;
    const handler = handlers.get(ctx.key);
    if (!handler) {
      // Silent drop — no handler registered for this key. Happens when the
      // extension restarts and re-registers its rows before wiring its
      // handlers, or when a row outlives the job that made it. The host
      // records the fire; nothing runs. Mirrors `schedule.ts`.
      return undefined;
    }
    await handler(ctx);
    return undefined;
  });
}

export class Triggers {
  /**
   * Register — or UPDATE — a dynamic trigger.
   *
   * Registering an existing `key` updates it in place: same row, same slug,
   * same secret. A job editor saving twice is the normal case, so this is
   * deliberately idempotent rather than an error.
   *
   * Rejects with the host's JSON-RPC error when refused. `data.reason`
   * carries a typed code (`TRIGGERS_QUOTA_EXCEEDED`, `TRIGGER_CRON_INVALID`,
   * …); for an invalid cron, `data.cronReason` additionally carries the
   * validator's own message verbatim (`"min-5-min-interval-required"`,
   * `"expected 5 fields, got 4"`, …) so you can render it next to the field
   * the user typed into.
   */
  async register(opts: RegisterOpts): Promise<RegisteredTrigger> {
    return getChannel().request<RegisteredTrigger>("ezcorp/triggers", {
      v: 1,
      action: "register",
      ...opts,
    });
  }

  /** Remove a trigger. For a webhook this also destroys the hook's secret,
   *  so any token already handed out stops authenticating immediately; the
   *  delivery history is preserved. */
  async unregister(kind: TriggerKind, key: string): Promise<{ removed: boolean }> {
    return getChannel().request<{ removed: boolean }>("ezcorp/triggers", {
      v: 1,
      action: "unregister",
      kind,
      key,
    });
  }

  /** Every dynamic trigger THIS extension holds. Scoped host-side from the
   *  registry, so it can only ever return your own. */
  async list(): Promise<RegisteredTrigger[]> {
    const res = await getChannel().request<{ v: 1; triggers: RegisteredTrigger[] }>(
      "ezcorp/triggers",
      { v: 1, action: "list" },
    );
    return res.triggers;
  }

  /** Wire a handler for a registered key. Registering the row and handling
   *  its fire are separate steps: a row with no handler drops its fires
   *  silently, so call this on every startup for every key you hold — not
   *  just at the moment you create one. */
  on(key: string, handler: TriggerHandler): void {
    handlers.set(key, handler);
    installReceiver();
  }

  /** Stop handling fires for a key without unregistering the row. */
  off(key: string): void {
    handlers.delete(key);
  }
}

/** @internal test-only — clear the handler registry + receiver latch so each
 *  test starts from a clean slate (mirrors `__resetWebhooksForTests`). */
export function __resetTriggersForTests(): void {
  handlers.clear();
  receiverInstalled = false;
}
