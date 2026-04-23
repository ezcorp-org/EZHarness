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

Both return a markdown snippet `![<alt>](data:image/<fmt>;base64,…)`
that the chat UI renders inline with lightbox + broken-URL fallback.

## Permissions

- `network`: `api.openai.com`, `chatgpt.com`
- `env`: `OPENAI_API_KEY`, `OPENAI_ACCESS_TOKEN`

No filesystem or shell access — images are returned as base64
in-memory.

## Run the tests

```
bun test docs/extensions/examples/openai-image-gen-2
```
