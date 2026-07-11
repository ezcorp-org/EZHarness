# openai-image-gen-2

Generate or edit raster images with OpenAI. Bundled extension.

## Two paths, one tool surface

The extension picks the right upstream automatically:

| Credential injected | Path | Endpoint |
|---|---|---|
| `OPENAI_ACCESS_TOKEN` (subscription OAuth) | Codex Responses + `image_generation` | `chatgpt.com/backend-api/codex/responses` |
| `OPENAI_API_KEY` (BYOK sk-…) | Images API | `api.openai.com/v1/images/generations` |

OAuth wins when both are present. Credentials are injected at spawn
time by the platform's `wireOpenAIExtensionCredentials` — the user
doesn't set env vars directly; they connect OpenAI via the admin UI's
OAuth flow or store a BYOK key in admin settings.

## Tools

- **`generate`** — text → image.
- **`edit`** — input images + prompt → edited image.

Both return a markdown snippet `![<alt>](/api/ext-files/openai-image-gen-2/<relPath>)`
that the chat UI renders inline with lightbox + broken-URL fallback.

## Permissions

- `network`: `api.openai.com`, `chatgpt.com`
- `env`: `OPENAI_API_KEY`, `OPENAI_ACCESS_TOKEN`
- `filesystem`: `$CWD`

Generated images are written to disk under
`.ezcorp/extension-data/openai-image-gen-2/generated/` and served via a
short `/api/ext-files/…` URL — keeping image bytes out of the model's
context window rather than inlining base64. No shell access.

## Run the tests

```
bun test docs/extensions/examples/openai-image-gen-2
```
