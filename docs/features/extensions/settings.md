# Per-Extension Settings

> _A declarative manifest `settings` schema that the host turns into a generic per-user config form on `/extensions/[id]`, with values resolved `default < override`, clamped at write **and** read, and injected into every tool call via `_meta.invocationMetadata.settings`._

## Intent

Extensions need user-tunable knobs — a TTS voice, a playback speed, a refresh interval, a model choice — without shipping bespoke UI or persistence code. An extension declares a typed `settings` schema in its manifest; the host renders the form, persists per-user values, validates them against the schema, and threads the resolved blob into each tool invocation. This is the user-visible knobs surface; opaque internal state (caches, intermediate results) belongs in the `ezcorp/storage` RPC instead, and **secrets must never live here** (see Notes & gotchas).

## How it works

The schema is one map of `key → SettingsField` on the manifest (`SettingsSchema` in `src/extensions/types.ts`). Four field types exist: `select`, `text`, `number`, `boolean` — there is no generic `string` type. Keys must match `/^[a-z][a-z0-9_]{0,63}$/`.

### Resolution & clamping

`resolveExtensionSettings(extensionId, userId, schema?)` in `src/db/queries/extension-settings.ts` is the single resolver. It merges two layers, lowest to highest:

```
declared default  <  user override
```

1. `getDeclaredDefaults(schema)` — pulls each field's `default` (skips fields with no default).
2. The user's row from `extension_settings_user`, **clamped** by `clampSettings(schema, values)`.
3. Returns `{ ...declared, ...clampedUser }`. A `null` `userId` returns just the declared defaults (the no-user tool-call path).

`clampSettings` drops unknown keys and any value that fails `isValidForField` (`src/extensions/manifest.ts`) — the same predicate the admit-time validator uses. **The clamp runs at write time (`setUserSettings`) AND at read time (`resolveExtensionSettings`)**, so dropping a field from the schema in v1.1 cannot leak a stale v1.0 value into a tool call; out-of-range / out-of-enum values silently revert to the declared default on read.

### Injection into tool calls

`src/extensions/tool-executor.ts` (around line 1148) is where resolved settings reach the subprocess. When a tool's manifest declares a `settings` block, the executor:

- Calls `resolveExtensionSettings(extensionId, this.currentUserId ?? null, manifest.settings)` — passing the in-memory schema so the resolver skips the per-call `extensions.manifest` DB lookup (N+1 fix; only the `extension_settings_user` row is queried).
- Merges `{ ...resolved, ...(callerSettings ?? {}) }` under `invocationMetadata.settings`, where `callerSettings` is any `invocationMetadata.settings` the caller passed. **Caller-supplied settings win** — a cross-extension `ezcorp/invoke` orchestrator can pre-bind overrides at wire time.
- Writes the result onto `_meta.invocationMetadata` on the JSON-RPC envelope sent to the subprocess.

### Reading from a handler (SDK)

`packages/@ezcorp/sdk/src/runtime/settings.ts` exposes two free functions that read `ctx.invocationMetadata.settings`:

- `getSetting<T>(ctx, key)` — one resolved value or `undefined`.
- `getAllSettings(ctx)` — a fresh shallow copy of the whole blob (mutating it is safe).

By the time a value reaches a handler the host has already clamped it to the declared field type, so the handler can trust the shape. Always provide a fallback (`?? defaultValue`) — the map is empty when the extension declares no `settings` and there's no per-call override.

### Reading from a tool card (browser)

Tool cards run in the browser bundle and read settings synchronously from a module-scoped cache (`web/src/lib/stores/extensionSettings.ts`), keyed by extension **name** (not id):

- The conversation layout (`web/src/routes/(app)/project/[id]/chat/[convId]/+layout.ts`) walks the enabled-extensions list and fires `loadExtensionSettings(name)` for each one. It resolves the name → id via `GET /api/extensions?name=`, then `GET /api/extensions/<id>/settings`, and caches the `resolved` blob. In-flight requests are deduped; failures cache `{}`.
- A card calls `getCachedSettings(name)` synchronously while rendering (e.g. `KokoroTtsPlayerCard.svelte`).
- After a save/reset, the settings page calls `invalidateExtensionSettings(name)`; the next chat-page mount re-loads.

## Usage

### REST API

| Method & path | Purpose |
|---|---|
| `GET /api/extensions/[id]/settings` | Returns `{ schema, declaredDefaults, userValues, resolved, capabilities }` for the calling user. `schema: null` when the extension declares none. Instance-wide `capabilities` (held host-capability schemas, v1: search) ride along on the same payload. |
| `PUT /api/extensions/[id]/settings/user` | Persist the calling user's values. Body `{ values: {...} }`. Clamped server-side before write. **409** if the extension has no `settings` schema; **400** if `values` is absent/not a plain object. Returns `{ ok, userValues }` (post-clamp). Audited. |
| `DELETE /api/extensions/[id]/settings/user` | Reset — deletes the user's row so the resolver falls back to declared defaults. **409** if no schema. Audited. |

All three call `requireAuth(locals)` and operate on the **caller's** `user.id` — there is no cross-user read/write surface here.

### UI entry points

- The extension detail page `web/src/routes/(app)/extensions/[id]/+page.svelte` renders a **Settings** section (`data-testid="extension-settings-section"`), placed before the separate **Permissions** section. Inside it, a **Your settings** panel is rendered (when the extension declares a schema) via the route-local `web/src/routes/(app)/extensions/[id]/SettingsPanel.svelte` (`title="Your settings"`); the held-capability policy panel (`CapabilitiesPanel`) renders above it and the modify-extension controls below it. `SettingsPanel` owns the local edit buffer and the **Save** / **Reset to default** buttons: "Save" issues the `PUT`; "Reset to default" issues the `DELETE`. It delegates field rendering to the generic `web/src/lib/components/SchemaForm.svelte` — no extension-specific UI code.
- `SchemaForm.svelte` is a fully controlled renderer: the parent (`SettingsPanel`) owns `values`, local edits propagate via `oninput(next)`, and it never mutates the prop. It maps each field type to a native control and coerces number inputs.

### SDK calls

```ts
import { getSetting, getAllSettings } from "@ezcorp/sdk/runtime";

const voice = getSetting<string>(ctx, "voice") ?? "af_bella";
const all   = getAllSettings(ctx); // safe-to-mutate copy
```

### Manifest declaration

```ts
export default defineExtension({
  settings: {
    voice: { type: "select", label: "Voice", options: [/* … */], default: "af_bella" },
    speed: { type: "number", label: "Playback speed", min: 0.5, max: 2.0, step: 0.05, default: 1.0 },
  },
});
```

The reference implementation is `kokoro-tts` (`docs/extensions/examples/kokoro-tts/ezcorp.config.ts`).

## Key files

- `src/extensions/types.ts` — `SettingsField` (`select` / `text` / `number` / `boolean`), `SettingsSchema`, and `settings?` on the manifest type.
- `src/db/queries/extension-settings.ts` — `getDeclaredDefaults`, `clampSettings`, `getUserSettings`, `setUserSettings`, `clearUserSettings`, `resolveExtensionSettings` (the merge `default < override` + clamp logic).
- `src/db/schema.ts` — `extension_settings_user` table (`userId` + `extensionId` composite PK, `values` JSONB, cascade-delete on both FKs).
- `src/extensions/manifest.ts` — `isValidForField` per-value validity predicate used by both clamp and admit-time checks.
- `src/extensions/tool-executor.ts` — resolves + merges settings into `_meta.invocationMetadata.settings` per tool call (caller overrides win).
- `src/extensions/audit-actions.ts` — `EXT_AUDIT_ACTIONS.SETTINGS_USER_UPDATED` (`ext:settings.user.update`) / `SETTINGS_USER_RESET` (`ext:settings.user.reset`).
- `packages/@ezcorp/sdk/src/runtime/settings.ts` — `getSetting` / `getAllSettings` SDK handler helpers.
- `web/src/routes/api/extensions/[id]/settings/+server.ts` — `GET` schema + resolved values + held capabilities.
- `web/src/routes/api/extensions/[id]/settings/user/+server.ts` — `PUT` (clamp + audit) / `DELETE` (reset + audit).
- `web/src/lib/stores/extensionSettings.ts` — browser cache keyed by extension name: `loadExtensionSettings`, `getCachedSettings`, `invalidateExtensionSettings`.
- `web/src/lib/components/SchemaForm.svelte` — generic controlled form driven by a `SettingsSchema`.
- `web/src/routes/(app)/extensions/[id]/SettingsPanel.svelte` — route-local wrapper owning the edit buffer + Save / Reset-to-default buttons; delegates field rendering to `SchemaForm`.
- `web/src/routes/(app)/extensions/[id]/+page.svelte` — the detail page hosting the Settings section + save/reset wiring.
- `web/src/routes/(app)/project/[id]/chat/[convId]/+layout.ts` — pre-loads resolved settings for the chat's wired extensions.
- `web/src/lib/components/tool-cards/KokoroTtsPlayerCard.svelte` — reference card reading settings via `getCachedSettings`.

## Features it touches

- [[overview-and-authoring]] — the `settings` block is part of the extension manifest authored alongside tools, panels, and permissions.
- [[runtime-and-rpc]] — resolved values ride on `_meta.invocationMetadata.settings` over the same stdio JSON-RPC envelope used for tool calls and reverse-RPC.
- [[permissions-and-grants]] — held host-capability policy schemas are returned on the **same** `GET …/settings` payload (`capabilities`); the capability override is written via the admin permissions `PUT`, not the per-user settings route.
- [[hub-pages]] — extension panels/cards in the Hub read settings synchronously from the same browser cache.
- [[canvas-cards]] — chat tool cards (e.g. the Kokoro TTS player) read resolved settings via `getCachedSettings`.
- [[audit-and-observability]] — every settings update/reset writes an audit row capturing pre/post blobs.
- [[bundled-catalog]] — `kokoro-tts` is the bundled reference extension exercising the settings surface.
- [[web-search]] — the search host capability is the v1 capability whose policy schema co-tenants the settings `GET` response.
- [[data-and-entities]] — values persist in the `extension_settings_user` table.

## Related docs

- [docs/extensions/settings.md](../../extensions/settings.md) — the authoring-side guide (declaring a schema, reading values, migration table, secrets FAQ).
- [manifest § settings](../../extensions/manifest-schema.md) — full field reference (per-type properties, key rules, validation).

## Notes & gotchas

- **Settings are NOT secret.** `GET /api/extensions/[id]/settings` returns the `resolved` + `userValues` blob to the calling authenticated session, and the chat layout ships `resolved` into the browser bundle. The schema and any declared defaults are visible to every user who can see the extension's detail page. There is no `secret: true` field flag. For API keys / tokens, use the Storage API with `scope: "user"` + `encrypted: true` (the **server** AES-256-GCM-encrypts at rest). Because settings can still carry a user-pasted secret in a text field, the `PUT`/`DELETE` routes audit the mutation (with the raw `submitted` input) defensively.
- **Clamp is the only schema guard.** There is no schema-version column on settings rows — the resolver always validates against the **current** manifest. Adding a field → resolves to its `default`; dropping a field → silently dropped on read; narrowing a type / tightening min/max/pattern → invalid persisted values revert to default on read. The host never notifies the user that a value was dropped.
- **Caller overrides win, per-call.** A cross-extension `ezcorp/invoke` caller passing `invocationMetadata.settings` overrides the resolved blob for that one call (`{ ...resolved, ...callerSettings }`). This is by design for orchestration; an extension cannot prevent a host orchestrator from overriding its own user's values for a single invocation.
- **Cache is keyed by name, route is keyed by id.** The browser store keys by extension **name** and resolves name → id at load time; the REST routes and the DB table key by extension **id**. A name collision (shouldn't happen — names are unique) would cross wires in the cache only.
- **No per-conversation / no global per-user write surface.** Settings are strictly per-user; there is no per-chat scope and no admin route to set another user's values. Conversation-scoped state belongs in `ezcorp/storage` with `scope: "conversation"`.
- **Uninstall cascades.** Both FKs on `extension_settings_user` are `onDelete: "cascade"` — deleting the user or the extension wipes the rows; re-installing starts fresh with no resurrection of old values.
- **Audit writes are best-effort.** The `insertAuditEntry` calls in the `user` route are wrapped in `try { … } catch { /* swallow */ }` — an audit failure never blocks the settings write.
