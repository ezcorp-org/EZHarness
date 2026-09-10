# EZCorp agents Worker

This Worker provides the LLM-only `summarizer` agent. It does not load the host
executor, database, or native sandbox modules, so it can run in workerd.

Set provider keys as Worker secrets. Do not add them to `wrangler.jsonc`:

```sh
wrangler secret put OPENAI_API_KEY --config worker/wrangler.jsonc
wrangler secret put ANTHROPIC_API_KEY --config worker/wrangler.jsonc
wrangler secret put GOOGLE_API_KEY --config worker/wrangler.jsonc
```

A run defaults to `anthropic` when `provider` is omitted. It must specify
`model`, or set `DEFAULT_MODEL` as a non-secret Worker variable. Set
`DEFAULT_PROVIDER` to change the provider default. Optional `*_BASE_URL` variables
send each provider to a compatible gateway or test service. The Worker passes
requests through `@earendil-works/pi-ai/compat`; it does not implement provider
HTTP formats itself.

Run records are local to a Worker isolate. They are intended for short-lived
inspection and retain the newest 100 completed records only. Use durable storage
for history that must survive an isolate restart.
