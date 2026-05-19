# substack-pilot — pre-port tool-response fixtures

This directory freezes the JSON shapes substack-pilot's hand-rolled
`lib/post-types.ts` (~421 LOC, deleted in commit `5b2109c`) returned
for each of its 5 post-type CRUD tools. The accompanying
`../post-types-port.test.ts` asserts the SDK-generated tools produce
semantically equivalent responses against the same canned inputs.

## Adapter contract (NOT byte-identical)

The pre-port wrappers returned `toolResult()` with custom prose
prefixes — e.g. `create_post_type` returned `"Created post type
\"weekly\" (Weekly Roundup).\n<JSON>"`. The SDK-generated tools return
just the JSON envelope (`{slug, data}`). This is the documented
adapter — the prose has been dropped; the structured data is the
contract.

The fixture files therefore freeze the *core PostType record* (the
JSON inside the old prose), and the test asserts that field-for-field
the SDK output's `data` payload equals the pre-port payload.

## Fixtures

| File | Tool | Shape |
|---|---|---|
| `list-post-types.before.json` | `list_post_types` | `{postTypes: PostTypeSummary[]}` (pre-port) |
| `get-post-type-weekly.before.json` | `get_post_type{slug:"weekly"}` | `PostType` record |
| `create-post-type-monthly.before.json` | `create_post_type{...}` | created `PostType` record |
| `update-post-type-weekly.before.json` | `update_post_type{slug, patch}` | merged `PostType` record |
| `delete-post-type-monthly.before.json` | `delete_post_type{slug}` | `{success: true}` (pre-port wrapper) |

`PostType` shape (verbatim, pre-port):

```ts
{ name: string; slug: string; systemPrompt: string;
  cadence?: string; defaults?: { titlePrefix?: string; subtitleTemplate?: string } }
```

`PostTypeSummary` shape (pre-port `listPostTypes`):

```ts
{ slug: string; name: string; cadence?: string }
```

## How the test compares

The SDK-generated tools return JSON envelopes like `{items: [{slug,
data}]}` (list), `{slug, data}` (get/create/update), `{deleted:
boolean}` (delete). The adapter normalizes both shapes to the
*PostType records* they describe and asserts deep equality on the
records. See `post-types-port.test.ts` for the exact normalization.
