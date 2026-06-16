// sec-C4 helper: clamp a caller-submitted permission set to the
// intersection of what the extension's manifest actually requested.
// Anything beyond the manifest is dropped silently — an admin cannot
// elevate an extension past what its author declared. Anything less is
// allowed (admin can grant a subset).
//
// Shared between:
//   - PUT  /api/extensions/[id]/permissions  (sec-C4 main writer)
//   - POST /api/extensions/[id]/activate     (sec-C3 follow-up writer)
// Keep the two callers in sync — every clamping rule belongs here, not
// inline at either call site.
//
// ── Capability tier (Phase 2+): taskEvents / spawnAgents / agentConfig /
// eventSubscriptions ── Each field is clamped against the manifest
// declaration AND against the kill-switch env var. If
// EZCORP_DISABLE_CAPABILITY_TOOLS=1 is set, the fields behave as if the
// manifest never declared them — operators can disable the entire tier
// without touching schema or code.
//
// eventSubscriptions (Phase 2c): clamp to the triple-intersection of
// submitted ∩ manifest-declared ∩ direct-carrier allowlist. An event
// name that survives is guaranteed routable by the dispatcher at
// runtime; unknown names fail closed (no grant) rather than landing in
// a grant that can never be honored. Phase 51.4 added the object form
// `{events, includeFullPayload?}`; both forms are normalized to the
// array form before the intersection (the dispatcher reads the
// includeFullPayload flag separately at install time).
//
// ── Phase 4 deputy / orchestration flags ──
// `acceptsCallerCaps` and `escalateChildCaps` are extension-level
// boolean elevations declared at the manifest's TOP LEVEL (not under
// `permissions`). The clamp respects the same rule: an admin can only
// grant what the manifest authored, and the user must explicitly
// consent — silent declines reset the field to false.
//
// ── Phase 51 capability surfaces (llm / memory / lessons / schedule) ──
// These delegate to the canonical clamp helpers in
// `src/extensions/clamp-permissions.ts` so the validation logic lives
// in exactly one place. The five classic permission fields (network /
// filesystem / shell / env / storage) stay inline here — their clamps
// are trivial and the test contract on this file already covers them.

import { capabilityToolsDisabled } from "$server/extensions/capability-flags";
import { DIRECT_CARRIER_EVENT_TYPES } from "$server/runtime/sse-conversation-filter";
import type { ExtensionPermissions, ExtensionManifestV2 } from "$server/extensions/types";
import {
  clampLlmPermission,
  clampMemoryPermission,
  clampLessonsPermission,
  clampSchedulePermission,
  clampSearchPermission,
} from "$server/extensions/clamp-permissions";

/** Normalize the manifest's `eventSubscriptions` to the canonical
 *  array-of-event-names form. Handles the Phase 51.4 object form
 *  `{events, includeFullPayload?}`. Returns `undefined` if the
 *  manifest didn't declare event subscriptions. */
function normalizeManifestEventSubscriptions(
  field: ExtensionManifestV2["permissions"]["eventSubscriptions"],
): string[] | undefined {
  if (Array.isArray(field)) return field;
  if (field && typeof field === "object" && Array.isArray(field.events)) return field.events;
  return undefined;
}

/** Phase 51.4: detect whether a manifest's event-subscription grant
 *  asked for the full payload (no `tool:start`/`tool:complete` strip).
 *  The dispatcher reads this at install/registration time via
 *  `setIncludeFullPayload`. */
export function manifestEventsIncludeFullPayload(
  field: ExtensionManifestV2["permissions"]["eventSubscriptions"],
): boolean {
  if (field && typeof field === "object" && !Array.isArray(field) && field.includeFullPayload === true) {
    return true;
  }
  return false;
}

export function clampExtensionPermissions(
  submitted: Partial<ExtensionPermissions>,
  // The ceiling. Normally the manifest declaration, but the
  // reapprove/re-clamp path passes a prior GRANT (or the bundled
  // ceiling) here — so `search` must tolerate the three-state grant
  // shape (`false | "inherit" | {…}`), which is a superset of the
  // manifest's object-only declaration. `clampSearchPermission` already
  // normalizes every state.
  manifest: Omit<ExtensionManifestV2["permissions"], "search"> & {
    search?: ExtensionManifestV2["permissions"]["search"] | ExtensionPermissions["search"];
  },
  manifestTopLevel?: Pick<ExtensionManifestV2, "acceptsCallerCaps" | "escalateChildCaps">,
): ExtensionPermissions {
  const clamped: ExtensionPermissions = { grantedAt: {} };

  if (submitted.network && manifest.network) {
    const allowed = submitted.network.filter((d) => manifest.network!.includes(d));
    if (allowed.length > 0) clamped.network = allowed;
  }

  if (submitted.filesystem && manifest.filesystem) {
    const allowed = submitted.filesystem.filter((p) => manifest.filesystem!.includes(p));
    if (allowed.length > 0) clamped.filesystem = allowed;
  }

  if (submitted.shell === true && manifest.shell === true) {
    clamped.shell = true;
  }

  if (submitted.env && manifest.env) {
    const allowed = submitted.env.filter((v) => manifest.env!.includes(v));
    if (allowed.length > 0) clamped.env = allowed;
  }

  if (submitted.storage === true && manifest.storage === true) {
    clamped.storage = true;
  }

  if (!capabilityToolsDisabled()) {
    if (submitted.taskEvents === true && manifest.taskEvents === true) {
      clamped.taskEvents = true;
    }
    if (submitted.spawnAgents && manifest.spawnAgents) {
      // spawnAgents is a structured permission — both maxPerHour and
      // maxConcurrent must be present at grant time. The grant cannot
      // exceed the manifest's declared caps; clamp numerically.
      const submittedMax = submitted.spawnAgents;
      const manifestMax = manifest.spawnAgents;
      const hourly = Math.min(submittedMax.maxPerHour, manifestMax.maxPerHour);
      const concurrent = Math.min(
        submittedMax.maxConcurrent ?? manifestMax.maxConcurrent ?? 3,
        manifestMax.maxConcurrent ?? 3,
      );
      if (hourly > 0 && concurrent > 0) {
        clamped.spawnAgents = { maxPerHour: hourly, maxConcurrent: concurrent };
      }
    }
    if (submitted.agentConfig === "read" && manifest.agentConfig === "read") {
      clamped.agentConfig = "read";
    }
    // eventSubscriptions: normalize both manifest object form and
    // submitted array form to a plain string[] before intersecting.
    const manifestEvents = normalizeManifestEventSubscriptions(manifest.eventSubscriptions);
    const submittedEvents = Array.isArray(submitted.eventSubscriptions)
      ? submitted.eventSubscriptions
      : (submitted.eventSubscriptions && typeof submitted.eventSubscriptions === "object"
          && Array.isArray((submitted.eventSubscriptions as { events?: unknown }).events)
            ? (submitted.eventSubscriptions as { events: string[] }).events
            : undefined);
    if (Array.isArray(submittedEvents) && Array.isArray(manifestEvents)) {
      const manifestSet = new Set(manifestEvents);
      const allowed = submittedEvents.filter(
        (e) => typeof e === "string"
          && manifestSet.has(e)
          && DIRECT_CARRIER_EVENT_TYPES.has(e as never),
      );
      if (allowed.length > 0) clamped.eventSubscriptions = allowed;
    }

    // ── Phase 51 capability surfaces ────────────────────────────────
    // Delegate to the canonical clamp helpers. Each helper returns
    // `undefined` when the manifest didn't declare the surface OR
    // when the clamp produced a no-op grant; only attach when defined.
    const llm = clampLlmPermission(
      submitted.llm,
      manifest.llm,
    );
    if (llm) clamped.llm = llm;

    const memory = clampMemoryPermission(
      submitted.memory,
      manifest.memory,
    );
    if (memory) clamped.memory = memory;

    const lessons = clampLessonsPermission(
      submitted.lessons,
      manifest.lessons,
    );
    if (lessons) clamped.lessons = lessons;

    const schedule = clampSchedulePermission(
      submitted.schedule,
      manifest.schedule,
    );
    if (schedule) clamped.schedule = schedule;

    // ctx.search (Phase 1). Unlike the others, `false` (search disabled)
    // is a VALID grant state — only `undefined` means "not declared" —
    // so attach on `!== undefined`.
    const search = clampSearchPermission(
      submitted.search,
      manifest.search,
    );
    if (search !== undefined) clamped.search = search;
  }

  // Phase 4 deputy / orchestration flags. Both are top-level manifest
  // declarations gated on user consent: an admin can grant TRUE only
  // when the manifest declared TRUE. Submission omitting or setting
  // the field to false leaves the grant absent (treated as opted-out
  // at runtime).
  if (
    submitted.acceptsCallerCaps === true &&
    manifestTopLevel?.acceptsCallerCaps === true
  ) {
    clamped.acceptsCallerCaps = true;
  }
  if (
    submitted.escalateChildCaps === true &&
    manifestTopLevel?.escalateChildCaps === true
  ) {
    clamped.escalateChildCaps = true;
  }

  // Preserve any prior grantedAt timestamps the caller passed for permissions
  // that survived clamping; stamp new ones below in the handler.
  if (submitted.grantedAt && typeof submitted.grantedAt === "object") {
    for (const [k, v] of Object.entries(submitted.grantedAt)) {
      if (typeof v === "number") clamped.grantedAt[k] = v;
    }
  }

  return clamped;
}
