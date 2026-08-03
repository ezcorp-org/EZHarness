/**
 * Extension Pages Hub — core page provider registry.
 *
 * Core features (Daily Briefing today) ship Hub tabs through the SAME
 * declarative component system extensions use: a provider renders a
 * `HubPageTree` which the Hub API validates with `validatePageTree`
 * before serving (uniform contract — core trees get zero special
 * treatment). Providers are registered at boot (web layer
 * `ensureInitialized()`, next to the briefing runtime registration)
 * and listed by the Hub API as `core:<id>` page ids.
 *
 * Same module-singleton indirection pattern as
 * `briefing/runtime-registry.ts`: backend code (src/) can't import the
 * web layer, so registration happens where both sides are reachable.
 */
import type { HubPageTree } from "../extensions/page-schema";

export interface HubPageContext {
  userId: string;
}

/**
 * Thrown by provider action handlers to surface a SPECIFIC HTTP status
 * (429 rate-limited, 503 unavailable, …) through the Hub actions route.
 * Plain `Error`s from handlers are treated as 500s.
 */
export class HubPageActionError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "HubPageActionError";
  }
}

export type HubPageActionHandler = (
  ctx: HubPageContext,
  payload?: Record<string, unknown>,
) => Promise<HubPageTree | undefined>;

export interface HubPageProvider {
  /** Stable id, becomes the `core:<id>` Hub page id. Lowercase slug. */
  id: string;
  /** Tab label. */
  title: string;
  /** Optional lucide icon name (resolved client-side with fallback). */
  icon?: string;
  description?: string;
  /** Render the page for one user. The tree is re-validated by the API. */
  render(ctx: HubPageContext): Promise<HubPageTree>;
  /** Named actions, addressable via POST /api/hub/pages/core:<id>/actions/<name>.
   *  May return a fresh tree to render immediately. The action names
   *  double as the page's `allowedEvents` for tree validation. */
  actions?: Record<string, HubPageActionHandler>;
  /**
   * Actions that require an INTERACTIVE HUMAN SESSION, refused for every
   * API-key principal by the Hub actions route (`requireSessionAuth`).
   *
   * The actions route is otherwise `chat`-scoped and `harness: controllable`
   * — deliberately, because triggering work programmatically is a real
   * capability. But an action that spends a HUMAN DECISION is not work: the
   * workflow-approvals `answer` action reaches `answerApproval`, so without
   * this a leaked `chat` key answered approvals through the Hub even after
   * the REST answer route was closed (R-4). One bypass is all a consent
   * boundary needs.
   *
   * Declared here rather than known by the route: the route is generic
   * infrastructure and must not learn what any particular action MEANS. The
   * provider knows. `registerHubPageProvider` rejects a name that is not a
   * real action, so a typo cannot silently leave one unprotected.
   */
  sessionOnlyActions?: readonly string[];
}

/** Provider ids (and action names) are URL path segments — keep them
 *  to the same conservative slug charset the manifest uses. */
export const HUB_PROVIDER_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/;

const providers = new Map<string, HubPageProvider>();

/**
 * Register a core provider. Idempotent by id — re-registering replaces
 * the previous provider (boot code may run twice under HMR). Throws on
 * malformed ids/action names: a bad registration is a programming
 * error, not user input.
 */
export function registerHubPageProvider(provider: HubPageProvider): void {
  if (!HUB_PROVIDER_ID_REGEX.test(provider.id)) {
    throw new Error(`Invalid hub page provider id: ${JSON.stringify(provider.id)}`);
  }
  for (const action of Object.keys(provider.actions ?? {})) {
    if (!HUB_PROVIDER_ID_REGEX.test(action)) {
      throw new Error(
        `Invalid hub page action name ${JSON.stringify(action)} on provider "${provider.id}"`,
      );
    }
  }
  // A `sessionOnlyActions` entry that names nothing is INERT — it reads like
  // a protected action and protects nothing, which is the worst failure mode
  // a security declaration has. Caught at registration (boot) rather than by
  // a meta-test, so the drift is impossible rather than merely noticed.
  for (const action of provider.sessionOnlyActions ?? []) {
    if (!provider.actions || !(action in provider.actions)) {
      throw new Error(
        `sessionOnlyActions names ${JSON.stringify(action)} on provider "${provider.id}", ` +
          `which is not one of its actions`,
      );
    }
  }
  providers.set(provider.id, provider);
}

export function getHubPageProvider(id: string): HubPageProvider | undefined {
  return providers.get(id);
}

/** Registration-order list — drives Hub tab order for core pages. */
export function listHubPageProviders(): HubPageProvider[] {
  return [...providers.values()];
}

/** Test-only: reset the registry between suites. */
export function _resetHubPageProvidersForTests(): void {
  providers.clear();
}
