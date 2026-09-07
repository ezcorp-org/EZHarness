# Available live provider checks

The parent replay used pinned Bun 1.3.14. `scripts/verify-shipping-keyless-providers.ts`
builds real first-party releases and invokes them through the production host
network broker with real DNS and real provider requests. GitHub Stats returned
the public `octocat` profile, Weather returned current and daily conditions,
City Conditions returned structured weather and pollen data, and Price Chart
returned chart points for MSFT. All four checks passed. Permissions are a
controlled fixture; these checks do not run the complete production app image.

The retained Memory Extractor replay also passed: one test, ten assertions.
It uses a built release, the production event dispatcher and delivery queue,
the host LLM broker, local Ollama `gemma4:e2b`, runtime deduplication and an owned
database. Denied LLM access creates no row; the permitted event creates one
owner-linked row. Only the embedding vector is fixed. The replay command is
`docs/validation/extension-v4-independent/runtime/artifacts/memory-installed-ollama-combined-replay.sh.txt`.

These fresh results supplement the full
[capability inventory](../../extension-v4-independent/runtime/extension-capability-inventory.md).
They do not turn its 116 rows without complete lifecycle smoke tests into
new complete lifecycle passes.

| Remaining path | Input needed for live proof |
| --- | --- |
| Paid image generation | Approved test account, OpenAI API key or access token, and one approved paid call |
| Private GitHub tools and project mutations | Scoped test token, disposable repository/project and approved mutations |
| Authenticated GitHub Stats | Optional scoped token for authenticated requests and rate limits |
| Substack tools | Test session, `substack-mcp` setup, and approved publishing/engagement operations |
| Graded Card Scanner | PSA credential, stable test card identifiers, and complete PriceCharting/CGC inputs |
| Paid host LLM variants | Approved provider credentials for the declared models; local Ollama is verified separately |
| SEO Watcher endpoint | A real endpoint and response contract to replace illustrative `api.example.com` |
| Optional Google pollen enrichment | A configured test key and approved request |

`provider-environment-presence.json` records only the presence of named process
environment variables. It contains no credential values and makes no claim
about credentials in other stores. Existing GitHub CLI access is not treated
as authorization to give a provider credential to an extension. No external
publication, project mutation or paid call was made for this replay.

The 24-hour operator soak has not run. The measured Stage2 soak is 300 seconds.
The 84 Gate integrity findings and six product decisions remain separate from
test results and require maintainer/product review.
