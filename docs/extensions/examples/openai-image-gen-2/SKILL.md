# Image Generation (OpenAI)

Generate or edit raster images via OpenAI. Two paths:

- **Subscription OAuth** — uses your ChatGPT subscription via the Codex
  Responses API (`chatgpt.com/backend-api/codex/responses`) with the
  built-in `image_generation` tool. No API key required, no separate
  billing.
- **BYOK API key** — classic `sk-…` key against
  `api.openai.com/v1/images/generations`.

The extension picks the OAuth path when `OPENAI_ACCESS_TOKEN` is
available, else falls back to `OPENAI_API_KEY`. Both are injected
automatically from the platform's stored credentials.

## When to use

- Generate a new image (concept art, product shot, cover, hero).
- Use reference images for style, composition, or mood.
- Edit an existing image (inpainting, lighting changes, background
  replacement, object removal, transparent cutout).
- Produce multiple variants (one `generate` call per variant).

## When not to use

- Extending an existing SVG/vector icon set.
- Simple shapes/diagrams better done in SVG/HTML/CSS.
- Any task where deterministic code-native output is preferred.

## Prompt shaping

When `augment=true` (the default), the extension normalizes scaffolding
hints into a labeled spec:

```
Use case: <slug>
Primary request: <user's prompt>
Scene/background: <environment>
Subject: <main subject>
Style/medium: <photo/illustration/3D/etc>
Composition/framing: <wide/close/top-down; placement>
Lighting/mood: <lighting + mood>
Color palette: <palette notes>
Materials/textures: <surface details>
Text (verbatim): "<exact text>"
Constraints: <must keep/must avoid>
Avoid: <negative constraints>
```

Use-case slugs (keep consistent):

- Generate: `photorealistic-natural`, `product-mockup`, `ui-mockup`,
  `infographic-diagram`, `logo-brand`, `illustration-story`,
  `stylized-concept`, `historical-scene`.
- Edit: `text-localization`, `identity-preserve`,
  `precise-object-edit`, `lighting-weather`, `background-extraction`,
  `style-transfer`, `compositing`, `sketch-to-render`.

Keep augmentation light. If the user's prompt is already specific, just
normalize it; don't inflate.

## Editing prior generations

When the user asks you to **modify, tweak, change, refine, or iterate on**
an image you (or an earlier turn) just generated with this extension,
call **`edit`** — never `generate`. `generate` produces a fresh image
unrelated to the prior one; `edit` is the only path that modifies it.

Every `generate` / `edit` result is rendered as markdown like:

```
![alt text](/api/ext-files/openai-image-gen-2/generated/<uuid>.png)
```

That URL is itself a valid `images` entry for `edit`. To modify the
prior image, copy the URL out of the prior tool result's markdown and
pass it through:

```
edit({
  prompt: "make the sky overcast, keep everything else identical",
  images: ["/api/ext-files/openai-image-gen-2/generated/<uuid>.png"]
})
```

The extension resolves the URL to bytes locally before sending — both
on the OAuth path (data URI inlined for the Codex backend) and on the
BYOK path (multipart upload).

Iterate one change at a time. Repeat the invariants ("keep everything
else identical", "same camera angle", etc.) every turn — it cuts down
on drift across edits.

If the file no longer exists on disk you'll get a clear validation
error; ask the user for the image again or regenerate from scratch.

## Best practices

- Structure: scene/backdrop → subject → details → constraints.
- For edits, repeat invariants every iteration to reduce drift.
- For multi-image edits, describe how each reference should be used.
- Quote in-image text verbatim.
- Iterate with single-change follow-ups.

## Size / quality / format

- `size` defaults to `1024x1024`. `1536x1024` for wide, `1024x1536` for
  vertical, `auto` to let the model pick.
- `quality` defaults to `auto`. `high` for final assets, `low` for
  iteration.
- `output_format` defaults to `png`. `webp` for smaller transparent
  outputs, `jpeg` for opaque photography.
- `background: "transparent"` requires `png` or `webp`.

## Rendering

The chat UI renders the generated image **directly from the tool
result** — you do not need to echo the returned markdown. The image
appears inline on the tool card automatically, with lazy-loading,
lightbox, and a fallback if the source fails.

Your prose reply is optional narration (what you changed, why, next
steps). Don't write "here is your image" if you didn't actually call
the tool — the image only appears when a call succeeded, so claiming
one was generated without calling produces a reply with no image,
which is worse than saying nothing. If the call failed, say that
plainly instead.
