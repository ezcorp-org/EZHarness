# EZCorp agents Worker

This Worker provides the LLM-only `summarizer` agent. It does not load the host
executor, database, or native sandbox modules, so it can run in workerd.

Every API route needs `Authorization: Bearer <AGENTS_API_TOKEN>`. Without
the `AGENTS_API_TOKEN` secret, the Worker answers every request with 503. A
missing or wrong token gets 401. Only the CORS preflight (`OPTIONS`) is open,
because it returns no data.

Set the token and the provider keys as Worker secrets BEFORE you deploy. Do not
add them to `wrangler.jsonc`:

```sh
openssl rand -base64 32 | wrangler secret put AGENTS_API_TOKEN --config worker/wrangler.jsonc
wrangler secret put OPENAI_API_KEY --config worker/wrangler.jsonc
wrangler secret put ANTHROPIC_API_KEY --config worker/wrangler.jsonc
wrangler secret put GOOGLE_API_KEY --config worker/wrangler.jsonc
wrangler deploy --config worker/wrangler.jsonc
```

Give the token only to clients you trust. They all share one token, so the
Worker cannot tell callers apart: every caller can list every run with
`GET /api/runs`. A run stores the summary (the model's output), the provider,
model, token counts and error messages. It does not store the input text.

## API

All routes need the bearer token (see above).

| Route | Result |
|---|---|
| `GET /api/agents` | The agent list (only `summarizer`). |
| `POST /api/agents/summarizer/run` | Body `{"text", "provider"?, "model"?}`. Returns the finished run (200). A provider or configuration failure is a run with `status: "error"`. |
| `POST /api/agents/<other>/run` | 404, `Agent not found: <other>`. |
| `GET /api/runs` | Every stored run, newest first. |
| `GET /api/runs/<id>` | One run, or 404. |

A body that is not JSON is a 400. A missing, empty or non-string `text` is a
400 (`input.text must be a non-empty string`). These requests record no run
and call no provider.

A run defaults to `anthropic` when `provider` is omitted. It must specify
`model`, or set `DEFAULT_MODEL` as a non-secret Worker variable. Set
`DEFAULT_PROVIDER` to change the provider default. Optional `*_BASE_URL` variables
send each provider to a compatible gateway or test service. The Worker passes
requests through `@earendil-works/pi-ai/compat`; it does not implement provider
HTTP formats itself.

Run records are local to a Worker isolate. They are intended for short-lived
inspection and retain the newest 100 completed records only. Use durable storage
for history that must survive an isolate restart.
