# Settings

Declare a typed configuration schema in your manifest, and the host renders a settings panel on `/extensions/<id>` for free. Each user has their own values, and the runtime injects the resolved blob into every tool call. No bespoke UI code. No manual persistence.

This is the SDK surface for any extension whose behaviour the user should be able to tune without touching code — voice / speed pickers, model choice, refresh intervals, feature flags, etc.

## What is this for?

| Use a settings schema when | Use the storage RPC when |
|---|---|
| The values are user-visible knobs (voice, model, threshold) | The data is opaque internal state (caches, intermediate results) |
| The shape is fixed up-front and small | The shape is dynamic or grows over time |
| Each user should pick their own | Per-conversation isolation is enough |
| Validation should be declarative (regex, min/max, enum) | Validation lives inside the extension's own logic |

If you need both — e.g. a configurable refresh interval **plus** a cached result blob — declare the interval in `settings` and store the cache via `ezcorp/storage`. They are complementary, not alternatives.

The reference implementation in this repo is **`kokoro-tts`** ([manifest](examples/kokoro-tts/ezcorp.config.ts)) — a `voice` select and a `speed` number flow into the in-browser TTS card.

## Declaring a settings schema

Add a `settings` block to your `ezcorp.config.ts`. See **[Manifest § settings](manifest-schema.md#settings----recordstring-settingsfield)** for the full field reference (key rules, per-type properties, validation rules).

```typescript
export default defineExtension({
  // …
  settings: {
    voice: {
      type: "select",
      label: "Voice",
      options: [
        { value: "af_bella", label: "Bella (US, female)" },
        { value: "am_adam",  label: "Adam (US, male)" },
      ],
      default: "af_bella",
    },
    speed: {
      type: "number",
      label: "Playback speed",
      min: 0.5, max: 2.0, step: 0.05, default: 1.0,
    },
  },
});
```

That's it for the manifest side. The host picks up the new block on the next install (or hot-reload during `ezcorp ext dev`) and the settings section materializes on `/extensions/<id>`.

## How values are resolved

Two layers, lowest to highest:

```
declared default  <  user override
```

The resolver merges left-to-right, then **clamps** the result against the manifest schema — unknown keys are dropped, type-mismatched values are coerced, and select options outside the declared `options[]` revert to the declared default. The clamp runs at write time AND at read time, so dropping a field from your schema in v1.1 cannot leak the v1.0 value into a tool call.

Resolved values land in `_meta.invocationMetadata.settings` on every JSON-RPC envelope your subprocess receives. Cross-extension `ezcorp/invoke` callers may also pass `invocationMetadata.settings` to override the resolved blob — useful when an orchestrator needs to invoke your tool with non-default values without touching the user's own override.

## Reading values from a tool handler

Use the SDK's runtime helpers — never reach into `_meta` by hand.

```typescript
import { createToolDispatcher, getChannel, getSetting, toolResult } from "@ezcorp/sdk/runtime";

createToolDispatcher({
  synthesize: async (ctx, args) => {
    const voice = getSetting<string>(ctx, "voice") ?? "af_bella";
    const speed = getSetting<number>(ctx, "speed") ?? 1.0;
    // … synthesize using { voice, speed } …
    return toolResult(JSON.stringify({ ok: true, voice, speed }));
  },
});
getChannel().start();
```

`getSetting<T>(ctx, key)` returns the resolved value or `undefined`; `getAllSettings(ctx)` returns the full blob. Always provide a fallback (`?? defaultValue`) — settings can be empty if the user hasn't visited the panel and the manifest declared no default.

## Reading values from a tool card (frontend)

Tool cards run in the browser bundle. The chat layout pre-loads the resolved blob keyed by extension *name* into a module-scoped cache (`web/src/lib/stores/extensionSettings.ts`); cards read it synchronously while rendering.

```svelte
<script lang="ts">
  import { getCachedSettings } from "$lib/stores/extensionSettings";

  const settings = getCachedSettings("kokoro-tts") ?? {};
  const voice = (settings.voice as string) ?? "af_bella";
  const speed = (settings.speed as number) ?? 1.0;
</script>
```

`getCachedSettings` is synchronous and returns `undefined` when nothing is cached — always provide a fallback. The cache is invalidated automatically after the user saves or resets values on the detail page; in-flight cards re-render with the new blob on the next chat-page mount.

## Editing values

Users land on `/extensions/<id>` and see a single **Your settings** panel under the **Settings** section (between the header and the **Permissions** section). Save persists to the user's row; **Reset to default** clears the row so the resolver falls back to the declared defaults on the next read.

The form is rendered by a single generic `<SchemaForm/>` component driven by your manifest schema — no extension-specific UI code is needed. See [API Reference § Per-extension Settings API](api-reference.md#per-extension-settings-api) for the wire shapes.

## Migrations

When you change the schema between versions, the resolver's clamp protects the runtime — but it doesn't notify users that a value was dropped. Plan accordingly:

| Change | Effect on persisted values |
|---|---|
| **Add a new field** | Existing user blobs don't have it → resolves to the field's `default` (or `undefined`). |
| **Drop a field** | Stale values are silently dropped on read; no error, no warning. |
| **Narrow a type** (e.g. select with fewer options) | Out-of-range values revert to the declared default on read. |
| **Change `default`** | Only affects users who never set an override. Persisted values remain. |
| **Tighten `min` / `max` / `pattern`** | Invalid persisted values revert to default on read. |

There is no schema-version field on settings rows — the resolver always validates against the **current** manifest. If a breaking change matters to your users (e.g. a renamed select option), surface it in your README or in a new banner before shipping; the host won't.

## Secret fields (API tokens, credentials)

Declare `type: "secret"` with a `storageKey` and the host renders a masked, write-only input on the settings page:

```typescript
settings: {
  psa_api_token: {
    type: "secret",
    label: "PSA API token",
    description: "Free token from api.psacard.com. Stored encrypted; never shown again.",
    storageKey: "psa-token",
  },
}
```

Secret fields are different from every other type:

- **The value never enters the settings JSON blob** — it is not in `userValues`, not in `resolved`, and never injected into tool calls. The clamp drops secret keys unconditionally.
- **On save the host encrypts it** (the same AES-256-GCM path as the storage RPC's `encrypted: true`) and upserts it into extension storage at `(scope: "user", scopeId: <saving user>, key: storageKey)`. Your extension reads it through its ordinary Storage surface — `new Storage("user")` then `storage.get(storageKey)` — with **zero extra code**. Secrets are implicitly per-user.
- **The GET payload carries only `secrets: { <key>: { isSet } } `** — a row-existence probe. No response byte ever contains the value; after saving, the UI shows a "Set" badge and a replace-only input.
- **Saving an empty string clears** the stored row (the panel's **Clear** button queues exactly that). Values are otherwise non-empty strings of at most 512 characters.
- **Audit is name-only** — the mutation is audited with `secretsSet` / `secretsCleared` field-name lists, never the plaintext.

The reference consumer is `graded-card-scanner`: its `psa_api_token` field writes the same `psa-token` storage row its `set_psa_token` tool writes, so `lib/token.ts`'s `resolveToken` works untouched whichever path supplied the token.

## FAQ

**Can settings hold secrets?**

Yes — but **only** via `type: "secret"` (see [Secret fields](#secret-fields-api-tokens-credentials)). Never put a credential in a `text` field: the `GET /api/extensions/<id>/settings` response is returned to the calling authenticated session, and the `resolved` blob ships into the chat browser bundle as part of the per-conversation hydration. `userValues` is visible to that user; the schema and any defaults are visible to every user who can see the extension's detail page. Secret fields avoid all of that by storing the value outside the settings blob entirely.

If your extension collects the credential itself (e.g. through a tool call rather than the settings page), use the [Storage API](api-reference.md#storage-api) with `scope: "user"` and `encrypted: true` — the value is encrypted at rest with AES-256-GCM, and it is the exact row a secret settings field with the same `storageKey` writes. The scope matters: the default `global` scope is one install-wide bucket shared by **every** user of the extension, so the server rejects encrypted writes to it (`-32602`). Note that the extension sends the value in plaintext over the stdio RPC channel; the **server** encrypts it before writing to the database (see `src/extensions/storage-handler.ts`).

**Why is there no per-conversation scope?**

Settings are per-user, not per-chat. If you need conversation-scoped state, use `ezcorp/storage` with `scope: "conversation"`. The settings UI deliberately lives on the extension detail page, not in the chat composer, to signal that scope.

**What happens when an extension is uninstalled?**

The DB foreign key on `extension_settings_user` cascade-deletes. Re-installing the extension starts fresh — there is no resurrection of old values.

**Can a tool override a setting per-call?**

Yes. Cross-extension `ezcorp/invoke` callers can pass `invocationMetadata.settings` in the request, and that overrides the resolved blob for that one call. Within your own subprocess the easiest pattern is to read via `getSetting` and then merge in any per-call overrides locally before dispatching.

## Reference

- Manifest field: [`settings`](manifest-schema.md#settings----recordstring-settingsfield)
- HTTP routes: [API Reference § Per-extension Settings API](api-reference.md#per-extension-settings-api)
- SDK helpers: [`packages/@ezcorp/sdk/src/runtime/settings.ts`](../../packages/@ezcorp/sdk/src/runtime/settings.ts)
- Worked example: [`docs/extensions/examples/kokoro-tts/`](examples/kokoro-tts/)
- Frontend store: [`web/src/lib/stores/extensionSettings.ts`](../../web/src/lib/stores/extensionSettings.ts)
